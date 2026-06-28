/**
 * Main bot logic for Wheel of Fortune Telegram Bot
 */

import { Bot, type Context } from 'grammy';
import { getRandomWord } from './data/wikidata';
import { type GameState, MAX_TIMEOUTS, SOLUTION_TIMEOUT_MS, TURN_TIMEOUT_MS } from './types';
import { createJoinKeyboard, createKickKeyboard, createLetterKeyboard, parseCallbackData } from './utils/keyboard';
import { compareHebrewStrings, getBothForms, isHebrewLetter, normalize, stripHebrewMarks } from './utils/normalize';
import {
  addPlayer,
  addPoints,
  addRevealedLetter,
  checkWinner,
  createInitialState,
  deleteGameState,
  getCurrentPlayer,
  getCurrentPlayerId,
  getGameState,
  incrementTimeout,
  newRound,
  nextTurn,
  removePlayer,
  saveGameState,
} from './utils/redis';

/** Default win limit if not specified */
const DEFAULT_WIN_LIMIT = 100;

/** Points for correct letter guess */
const POINTS_LETTER = 1;

/** Points for solving the word */
const POINTS_SOLVE = 2;

/**
 * Create and configure the bot
 * @param token - Telegram bot token
 * @returns Configured bot instance
 */
export function createBot(token: string): Bot {
  const bot = new Bot(token);

  // Error boundary: never let one failing update stop the bot. grammY's *default*
  // handler calls bot.stop() on any uncaught error (e.g. an expired callback
  // query from a fast tap), which would take the whole bot down.
  bot.catch((err) => {
    console.error('Error handling update', err.ctx?.update?.update_id, err.error);
  });

  // /start command - show help
  bot.command('start', async (ctx) => {
    if (ctx.chat?.type === 'private') {
      await ctx.reply(
        '🎡 ברוכים הבאים לגלגל המזל!\n\n' +
          'הוסף אותי לקבוצה והשתמש בפקודה /start_game כדי להתחיל משחק.\n\n' +
          'פקודות:\n' +
          '/start_game [נקודות] - התחל משחק חדש (ברירת מחדל: 10 נקודות)\n' +
          '/end_game - סיים את המשחק הנוכחי\n' +
          '/help - עזרה',
      );
    }
  });

  // /help command
  bot.command('help', async (ctx) => {
    await ctx.reply(
      '🎡 <b>גלגל המזל - עזרה</b>\n\n' +
        '<b>חוקי המשחק:</b>\n' +
        '• נחשו אותיות כדי לגלות את המילה\n' +
        '• ניחוש נכון = נקודה ותור נוסף\n' +
        '• ניחוש שגוי = התור עובר\n' +
        '• פתרון המילה = 2 נקודות\n\n' +
        '<b>פקודות:</b>\n' +
        '/start_game [נקודות] - התחל משחק חדש\n' +
        '/end_game - סיים משחק\n\n' +
        '<b>טיפ:</b> האותיות כ/ך, מ/ם, נ/ן, פ/ף, צ/ץ נחשבות זהות!',
      { parse_mode: 'HTML' },
    );
  });

  // /start_game command - anyone can start
  bot.command('start_game', async (ctx) => {
    if (!ctx.chat || ctx.chat.type === 'private') {
      await ctx.reply('❌ פקודה זו פועלת רק בקבוצות.');
      return;
    }

    const chatId = ctx.chat.id;
    const userId = ctx.from?.id;

    if (!userId) {
      return;
    }

    // Check for existing game
    const existingGame = await getGameState(chatId);
    if (existingGame) {
      await ctx.reply('❌ כבר יש משחק פעיל! השתמש ב-/end_game כדי לסיים אותו.');
      return;
    }

    // Parse win limit from command argument
    const args = ctx.match?.toString().trim();
    let winLimit = DEFAULT_WIN_LIMIT;
    if (args) {
      const parsed = Number.parseInt(args, 10);
      if (!Number.isNaN(parsed) && parsed > 0 && parsed <= 100) {
        winLimit = parsed;
      }
    }

    // Get random word
    const { word, category, description } = await getRandomWord();

    // Create initial state
    const state = createInitialState(word, category, userId, winLimit, description);
    await saveGameState(chatId, state);

    // Send join message
    const message = await ctx.reply(
      '🎡 <b>גלגל המזל - משחק חדש!</b>\n\n' +
        `🏆 יעד: ${winLimit} נקודות\n` +
        '👥 שחקנים: 0\n\n' +
        'לחצו על <b>הצטרפות</b> להצטרף למשחק.\n' +
        'כשכולם מוכנים, יוצר המשחק ילחץ על <b>התחל משחק</b>.',
      {
        parse_mode: 'HTML',
        reply_markup: createJoinKeyboard(),
      },
    );

    // Save message ID for editing
    state.gameBoardMessageId = message.message_id;
    await saveGameState(chatId, state);
  });

  // /end_game command
  bot.command('end_game', async (ctx) => {
    if (!ctx.chat || ctx.chat.type === 'private') {
      return;
    }

    const chatId = ctx.chat.id;
    const userId = ctx.from?.id;

    if (!userId) {
      return;
    }

    const state = await getGameState(chatId);
    if (!state) {
      await ctx.reply('❌ אין משחק פעיל.');
      return;
    }

    await deleteGameState(chatId);
    await ctx.reply('🛑 המשחק הסתיים.');
  });

  // /leave command - leave the game
  bot.command('leave', async (ctx) => {
    if (!ctx.chat || ctx.chat.type === 'private') {
      return;
    }

    const chatId = ctx.chat.id;
    const userId = ctx.from?.id;
    const userName = ctx.from?.first_name || 'שחקן';

    if (!userId) {
      return;
    }

    const state = await getGameState(chatId);
    if (!state) {
      await ctx.reply('❌ אין משחק פעיל.');
      return;
    }

    // Check if player is in the game
    if (!state.playerOrder.includes(userId)) {
      await ctx.reply('❌ את/ה לא במשחק.');
      return;
    }

    const wasCurrentPlayer = getCurrentPlayerId(state) === userId;
    const newState = removePlayer(state, userId);

    // Check if game should end
    if (newState.playerOrder.length < 1) {
      await ctx.reply(`🚪 <b>${userName}</b> עזב/ה את המשחק.\n🛑 המשחק הסתיים - אין מספיק שחקנים.`, {
        parse_mode: 'HTML',
      });
      await deleteGameState(chatId);
      return;
    }

    // If leaving player was current, reset turn timer
    if (wasCurrentPlayer) {
      newState.turnStartTime = Date.now();
    }

    await saveGameState(chatId, newState);
    await ctx.reply(`🚪 <b>${userName}</b> עזב/ה את המשחק.`, { parse_mode: 'HTML' });

    // Update game board if game is active
    if (newState.status === 'playing') {
      await updateGameBoard(ctx, newState, chatId, wasCurrentPlayer);
    }
  });

  // Handle callback queries (button presses)
  bot.on('callback_query:data', async (ctx) => {
    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;
    const userName = ctx.from?.first_name || 'שחקן';

    if (!chatId || !userId) {
      await ctx.answerCallbackQuery({ text: 'שגיאה' });
      return;
    }

    const state = await getGameState(chatId);
    if (!state) {
      await ctx.answerCallbackQuery({ text: 'אין משחק פעיל' });
      return;
    }

    const { action, value } = parseCallbackData(ctx.callbackQuery.data);

    switch (action) {
      case 'action':
        await handleAction(ctx, state, chatId, userId, userName, value);
        break;
      case 'letter':
        await handleLetterGuess(ctx, state, chatId, userId, value);
        break;
      case 'kick':
        await handleKick(ctx, state, chatId, userId, value);
        break;
      default:
        await ctx.answerCallbackQuery();
    }
  });

  // Handle text messages (for solution attempts via reply)
  bot.on('message:text', async (ctx) => {
    const chatId = ctx.chat?.id;
    const userId = ctx.from?.id;

    if (!chatId || !userId || ctx.chat?.type === 'private') {
      return;
    }

    // Check if this is a reply
    const replyTo = ctx.message?.reply_to_message;
    if (!replyTo) {
      return;
    }

    const state = await getGameState(chatId);
    if (!state || !state.awaitingSolution || state.solvingPlayerId !== userId) {
      return;
    }

    // Verify reply is to our solution prompt message
    if (state.solutionMessageId && replyTo.message_id !== state.solutionMessageId) {
      return;
    }

    // Process the solution attempt
    await handleSolutionAttempt(ctx, state, chatId, userId, ctx.message.text);
  });

  return bot;
}

/**
 * Check if a user is a group admin
 */
async function checkIsAdmin(ctx: Context, chatId: number, userId: number): Promise<boolean> {
  try {
    const admins = await ctx.api.getChatAdministrators(chatId);
    return admins.some((admin) => admin.user.id === userId);
  } catch {
    return false;
  }
}

/**
 * Handle action button presses (join, start, solve)
 */
async function handleAction(
  ctx: Context,
  state: GameState,
  chatId: number,
  userId: number,
  userName: string,
  action?: string,
): Promise<void> {
  switch (action) {
    case 'join':
      await handleJoin(ctx, state, chatId, userId, userName);
      break;
    case 'start':
      await handleGameStart(ctx, state, chatId, userId);
      break;
    case 'solve':
      await handleSolveRequest(ctx, state, chatId, userId);
      break;
    case 'leave':
      await handleLeave(ctx, state, chatId, userId);
      break;
    case 'wait':
      await ctx.answerCallbackQuery({ text: 'זה לא התור שלך!' });
      break;
    case 'new_game':
      await ctx.answerCallbackQuery({ text: 'השתמש ב-/start_game להתחלת משחק חדש' });
      break;
    default:
      await ctx.answerCallbackQuery();
  }
}

/**
 * Check if turn timed out and handle it
 * @returns true if timeout was handled, false otherwise
 */
async function checkAndHandleTurnTimeout(ctx: Context, state: GameState, chatId: number): Promise<boolean> {
  // If awaiting solution, don't check turn timeout (solution has its own timeout)
  if (state.awaitingSolution) {
    return false;
  }

  // Check if turn timer exists and has expired
  if (state.turnStartTime && Date.now() - state.turnStartTime > TURN_TIMEOUT_MS) {
    const timedOutPlayerId = getCurrentPlayerId(state);
    const timedOutPlayer = getCurrentPlayer(state);
    const timedOutPlayerName = timedOutPlayer?.name || 'השחקן';

    if (!timedOutPlayerId) {
      return false;
    }

    // Increment timeout count
    let newState = incrementTimeout(state, timedOutPlayerId);
    const timeoutCount = newState.playersData[timedOutPlayerId]?.timeouts || 0;

    // Check if player should be kicked
    if (timeoutCount >= MAX_TIMEOUTS) {
      newState = removePlayer(newState, timedOutPlayerId);

      await ctx.answerCallbackQuery({ text: `🚫 ${timedOutPlayerName} הוסר/ה מהמשחק!` });
      await ctx.api.sendMessage(chatId, `🚫 <b>${timedOutPlayerName}</b> הוסר/ה מהמשחק לאחר ${MAX_TIMEOUTS} פסילות!`, {
        parse_mode: 'HTML',
      });

      // Check if game should end
      if (newState.playerOrder.length < 1) {
        await ctx.api.sendMessage(chatId, '🛑 המשחק הסתיים - אין מספיק שחקנים.');
        await deleteGameState(chatId);
        return true;
      }
    } else {
      // Just move to next player
      newState = nextTurn(newState);

      await ctx.answerCallbackQuery({ text: `⏰ נגמר הזמן! (${timeoutCount}/${MAX_TIMEOUTS})` });

      // Send timeout message with admin kick option
      const kickKeyboard = createKickKeyboard(timedOutPlayerId, timedOutPlayerName);
      await ctx.api.sendMessage(
        chatId,
        `⏰ נגמר הזמן ל-<b>${timedOutPlayerName}</b>! (${timeoutCount}/${MAX_TIMEOUTS}) התור עובר.\n<i>מנהלים יכולים להעיף:</i>`,
        { parse_mode: 'HTML', reply_markup: kickKeyboard },
      );
    }

    newState.turnStartTime = Date.now();
    await saveGameState(chatId, newState);
    await updateGameBoard(ctx, newState, chatId, true);
    return true;
  }

  return false;
}

/**
 * Handle player joining
 */
async function handleJoin(
  ctx: Context,
  state: GameState,
  chatId: number,
  userId: number,
  userName: string,
): Promise<void> {
  if (state.playerOrder.includes(userId)) {
    await ctx.answerCallbackQuery({ text: 'כבר הצטרפת למשחק!' });
    return;
  }

  const newState = addPlayer(state, userId, userName);
  await saveGameState(chatId, newState);

  // Handle join during playing phase (mid-game join)
  if (state.status === 'playing') {
    await ctx.answerCallbackQuery({ text: 'הצטרפת למשחק! 🎉 תורך יגיע בקרוב.' });
    // Update the game board to show new player in scoreboard
    await updateGameBoard(ctx, newState, chatId, false);
    return;
  }

  // Handle join during joining phase
  const playerNames = newState.playerOrder.map((id) => newState.playersData[id]?.name || 'שחקן').join(', ');

  await ctx.editMessageText(
    '🎡 <b>גלגל המזל - משחק חדש!</b>\n\n' +
      `🏆 יעד: ${newState.winLimit} נקודות\n` +
      `👥 שחקנים (${newState.playerOrder.length}): ${playerNames}\n\n` +
      'לחצו על <b>הצטרפות</b> להצטרף למשחק.\n' +
      'כשכולם מוכנים, לחצו על <b>התחל משחק</b>.',
    {
      parse_mode: 'HTML',
      reply_markup: createJoinKeyboard(),
    },
  );

  await ctx.answerCallbackQuery({ text: 'הצטרפת למשחק! 🎉' });
}

/**
 * Handle player leaving the game
 */
async function handleLeave(ctx: Context, state: GameState, chatId: number, userId: number): Promise<void> {
  // Check if player is in the game
  if (!state.playerOrder.includes(userId)) {
    await ctx.answerCallbackQuery({ text: 'את/ה לא במשחק!' });
    return;
  }

  const playerName = state.playersData[userId]?.name || 'שחקן';
  const wasCurrentPlayer = getCurrentPlayerId(state) === userId;

  const newState = removePlayer(state, userId);

  // Check if game should end
  if (newState.playerOrder.length < 1) {
    await ctx.answerCallbackQuery({ text: 'עזבת את המשחק.' });
    await ctx.api.sendMessage(chatId, `🚪 <b>${playerName}</b> עזב/ה את המשחק.\n🛑 המשחק הסתיים - אין מספיק שחקנים.`, {
      parse_mode: 'HTML',
    });
    await deleteGameState(chatId);
    return;
  }

  // If leaving player was current, reset turn timer
  if (wasCurrentPlayer) {
    newState.turnStartTime = Date.now();
  }

  await saveGameState(chatId, newState);

  await ctx.answerCallbackQuery({ text: 'עזבת את המשחק.' });
  await ctx.api.sendMessage(chatId, `🚪 <b>${playerName}</b> עזב/ה את המשחק.`, { parse_mode: 'HTML' });

  // Update game board if game is active
  if (newState.status === 'playing') {
    await updateGameBoard(ctx, newState, chatId, wasCurrentPlayer);
  }
}

/**
 * Handle admin kicking a player
 */
async function handleKick(
  ctx: Context,
  state: GameState,
  chatId: number,
  adminId: number,
  playerIdStr?: string,
): Promise<void> {
  // Check if user is admin
  const isAdmin = await checkIsAdmin(ctx, chatId, adminId);
  if (!isAdmin) {
    await ctx.answerCallbackQuery({ text: 'רק מנהלים יכולים להעיף שחקנים!' });
    return;
  }

  const playerId = playerIdStr ? Number.parseInt(playerIdStr, 10) : undefined;
  if (!playerId || Number.isNaN(playerId)) {
    await ctx.answerCallbackQuery({ text: 'שגיאה' });
    return;
  }

  // Check if player is in the game
  if (!state.playerOrder.includes(playerId)) {
    await ctx.answerCallbackQuery({ text: 'השחקן כבר לא במשחק!' });
    // Remove the kick button
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: undefined });
    } catch {
      // Ignore
    }
    return;
  }

  const playerName = state.playersData[playerId]?.name || 'שחקן';
  const wasCurrentPlayer = getCurrentPlayerId(state) === playerId;

  const newState = removePlayer(state, playerId);

  // Check if game should end
  if (newState.playerOrder.length < 1) {
    await ctx.answerCallbackQuery({ text: `${playerName} הועף/ה!` });
    await ctx.api.sendMessage(chatId, `🚫 <b>${playerName}</b> הועף/ה מהמשחק.\n🛑 המשחק הסתיים - אין מספיק שחקנים.`, {
      parse_mode: 'HTML',
    });
    await deleteGameState(chatId);
    // Remove the kick button
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: undefined });
    } catch {
      // Ignore
    }
    return;
  }

  // If kicked player was current, reset turn timer
  if (wasCurrentPlayer) {
    newState.turnStartTime = Date.now();
  }

  await saveGameState(chatId, newState);

  await ctx.answerCallbackQuery({ text: `${playerName} הועף/ה!` });
  await ctx.api.sendMessage(chatId, `🚫 <b>${playerName}</b> הועף/ה מהמשחק על ידי מנהל.`, { parse_mode: 'HTML' });

  // Remove the kick button
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: undefined });
  } catch {
    // Ignore
  }

  // Update game board if game is active
  if (newState.status === 'playing') {
    await updateGameBoard(ctx, newState, chatId, wasCurrentPlayer);
  }
}

/**
 * Handle game start
 */
async function handleGameStart(ctx: Context, state: GameState, chatId: number, userId: number): Promise<void> {
  if (state.status !== 'joining') {
    await ctx.answerCallbackQuery({ text: 'המשחק כבר התחיל!' });
    return;
  }

  if (userId !== state.startedBy) {
    await ctx.answerCallbackQuery({ text: 'רק מי שיצר את המשחק יכול להתחיל אותו!' });
    return;
  }

  if (state.playerOrder.length < 1) {
    await ctx.answerCallbackQuery({ text: 'צריך לפחות שחקן אחד!' });
    return;
  }

  // Start the game with turn timer
  state.status = 'playing';
  state.turnStartTime = Date.now();
  await saveGameState(chatId, state);

  await ctx.answerCallbackQuery({ text: 'המשחק מתחיל! 🎮' });

  // Update message with game board (new turn, trigger notification)
  await updateGameBoard(ctx, state, chatId, true);
}

/**
 * Handle letter guess
 */
async function handleLetterGuess(
  ctx: Context,
  state: GameState,
  chatId: number,
  userId: number,
  letter?: string,
): Promise<void> {
  if (state.status !== 'playing') {
    await ctx.answerCallbackQuery({ text: 'המשחק לא פעיל!' });
    return;
  }

  // Check if turn timed out
  const timeoutResult = await checkAndHandleTurnTimeout(ctx, state, chatId);
  if (timeoutResult) {
    // Turn was timed out, board already updated
    return;
  }

  const currentPlayerId = getCurrentPlayerId(state);
  if (userId !== currentPlayerId) {
    await ctx.answerCallbackQuery({ text: 'זה לא התור שלך!' });
    return;
  }

  if (!letter) {
    await ctx.answerCallbackQuery();
    return;
  }

  const normalizedLetter = normalize(letter);

  // Check if letter already guessed
  if (state.revealedLetters.includes(normalizedLetter)) {
    await ctx.answerCallbackQuery({ text: 'האות הזו כבר נוחשה!' });
    return;
  }

  // Check if letter is in the word (check both regular and final forms)
  const letterForms = getBothForms(normalizedLetter);
  const isInWord = letterForms.some((form) => state.word.includes(form));

  // Add letter to revealed
  let newState = addRevealedLetter(state, normalizedLetter);

  if (isInWord) {
    // Correct guess - add points, keep turn, reset timer with bonus time
    newState = addPoints(newState, userId, POINTS_LETTER);
    newState.turnStartTime = Date.now(); // Reset timer for another 30 seconds
    await ctx.answerCallbackQuery({ text: 'נכון! +30 שניות 🎉' });

    // Check if word is complete
    if (isWordComplete(newState)) {
      await handleWordComplete(ctx, newState, chatId, userId);
      return;
    }

    // Same player continues. Render the board in the background so rapid letter
    // taps aren't serialized behind the Telegram edit — the state is already
    // saved, so the next tap reads correct data even before the redraw lands.
    await saveGameState(chatId, newState);
    updateGameBoard(ctx, newState, chatId, false).catch((err) => console.error('Board refresh failed', err));
  } else {
    // Wrong guess - move to next player with fresh timer
    newState = nextTurn(newState);
    newState.turnStartTime = Date.now();
    await ctx.answerCallbackQuery({ text: 'לא נכון! התור עובר.' });

    // Turn changed - send new message to notify next player
    await saveGameState(chatId, newState);
    await updateGameBoard(ctx, newState, chatId, true);
  }
}

/**
 * Handle solve request
 */
async function handleSolveRequest(ctx: Context, state: GameState, chatId: number, userId: number): Promise<void> {
  if (state.status !== 'playing') {
    await ctx.answerCallbackQuery({ text: 'המשחק לא פעיל!' });
    return;
  }

  // Check if turn timed out
  const timeoutResult = await checkAndHandleTurnTimeout(ctx, state, chatId);
  if (timeoutResult) {
    return;
  }

  const currentPlayerId = getCurrentPlayerId(state);
  if (userId !== currentPlayerId) {
    await ctx.answerCallbackQuery({ text: 'זה לא התור שלך!' });
    return;
  }

  const playerName = state.playersData[userId]?.name || 'שחקן';

  await ctx.answerCallbackQuery({ text: 'יש לך דקה! השב להודעה עם הפתרון.' });

  // Send message that user needs to reply to
  const promptMessage = await ctx.api.sendMessage(
    chatId,
    `🤔 <b>${playerName}</b>, מה הפתרון שלך?\n\n<i>↩️ השב להודעה זו תוך דקה</i>`,
    {
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, selective: true },
    },
  );

  // Set awaiting solution flag with message ID and start time
  state.awaitingSolution = true;
  state.solvingPlayerId = userId;
  state.solutionMessageId = promptMessage.message_id;
  state.solutionStartTime = Date.now();
  await saveGameState(chatId, state);
}

/**
 * Handle solution attempt
 */
async function handleSolutionAttempt(
  ctx: Context,
  state: GameState,
  chatId: number,
  userId: number,
  answer: string,
): Promise<void> {
  // Check if solution attempt timed out
  if (state.solutionStartTime && Date.now() - state.solutionStartTime > SOLUTION_TIMEOUT_MS) {
    // Clear awaiting flags
    state.awaitingSolution = false;
    state.solvingPlayerId = undefined;
    state.solutionMessageId = undefined;
    state.solutionStartTime = undefined;

    // Move to next player
    const newState = nextTurn(state);
    newState.turnStartTime = Date.now();
    await saveGameState(chatId, newState);

    await ctx.reply('⏰ נגמר הזמן לפתרון! התור עובר.');
    await updateGameBoard(ctx, newState, chatId, true);
    return;
  }

  // Clear awaiting flags
  state.awaitingSolution = false;
  state.solvingPlayerId = undefined;
  state.solutionMessageId = undefined;
  state.solutionStartTime = undefined;

  // Compare answer with word (ignore spaces and final letters)
  const isCorrect = compareHebrewStrings(answer, state.word);

  if (isCorrect) {
    // Correct solution: 2 points + 1 per unrevealed letter
    const unrevealedCount = countUnrevealedLetters(state);
    const totalPoints = POINTS_SOLVE + unrevealedCount * POINTS_LETTER;
    const newState = addPoints(state, userId, totalPoints);
    await saveGameState(chatId, newState);

    const descLine = state.wordDescription ? `\nℹ️ ${state.wordDescription}` : '';
    await ctx.reply(
      `🎉 נכון! המילה היא: <b>${state.word}</b>${descLine}\n` +
        `+${totalPoints} נק' (${POINTS_SOLVE} פתרון + ${unrevealedCount} אותיות)`,
      { parse_mode: 'HTML' },
    );

    // Check for winner
    const winnerId = checkWinner(newState);
    if (winnerId) {
      await handleGameWin(ctx, newState, chatId, winnerId);
      return;
    }

    // Start new round
    await startNewRound(ctx, newState, chatId);
  } else {
    // Wrong solution - turn passes
    const newState = nextTurn(state);
    newState.turnStartTime = Date.now();
    await saveGameState(chatId, newState);

    await ctx.reply('❌ לא נכון! התור עובר.');
    await updateGameBoard(ctx, newState, chatId, true);
  }
}

/**
 * Handle word complete (all letters revealed)
 */
async function handleWordComplete(ctx: Context, state: GameState, chatId: number, solverId: number): Promise<void> {
  const newState = addPoints(state, solverId, POINTS_SOLVE);
  await saveGameState(chatId, newState);

  const descLine = state.wordDescription ? `\nℹ️ ${state.wordDescription}` : '';
  await ctx.api.sendMessage(chatId, `🎉 המילה נחשפה: <b>${state.word}</b>${descLine}`, { parse_mode: 'HTML' });

  // Check for winner
  const winnerId = checkWinner(newState);
  if (winnerId) {
    await handleGameWin(ctx, newState, chatId, winnerId);
    return;
  }

  // Start new round
  await startNewRound(ctx, newState, chatId);
}

/**
 * Handle game win
 */
async function handleGameWin(ctx: Context, state: GameState, chatId: number, winnerId: number): Promise<void> {
  const winner = state.playersData[winnerId];
  const scoreboard = buildScoreboard(state);

  await ctx.api.sendMessage(
    chatId,
    `🏆 <b>${winner?.name || 'שחקן'} ניצח/ה!</b>\n\n📊 <b>טבלת ניקוד סופית:</b>\n${scoreboard}`,
    { parse_mode: 'HTML' },
  );

  // Delete game state
  await deleteGameState(chatId);
}

/**
 * Start a new round
 */
async function startNewRound(ctx: Context, state: GameState, chatId: number): Promise<void> {
  const { word, category, description } = await getRandomWord(state.usedWords);
  const newState = newRound(state, word, category, description);
  // Reset the turn timer for the new round; otherwise the stale timestamp from
  // the previous round makes the first guess immediately "time out" and skip the turn.
  newState.turnStartTime = Date.now();
  await saveGameState(chatId, newState);

  await ctx.api.sendMessage(chatId, '🔄 סיבוב חדש!', { parse_mode: 'HTML' });
  await updateGameBoard(ctx, newState, chatId, true);
}

/**
 * Update the game board message
 * When turnChanged=true, sends new message to trigger notification
 * When turnChanged=false, edits existing message (same player continues)
 */
async function updateGameBoard(ctx: Context, state: GameState, chatId: number, turnChanged = false): Promise<void> {
  const wordDisplay = buildWordDisplay(state);
  const scoreboard = buildScoreboard(state);
  const currentPlayerId = getCurrentPlayerId(state);
  const currentPlayer = getCurrentPlayer(state);
  const revealedSet = new Set(state.revealedLetters);
  const keyboard = createLetterKeyboard(revealedSet);

  // Create mention link for current player
  const playerMention =
    currentPlayerId && currentPlayer
      ? `<a href="tg://user?id=${currentPlayerId}">${currentPlayer.name}</a>`
      : 'לא ידוע';

  const text =
    `🎡 <b>גלגל המזל</b>\n\n` +
    `📂 קטגוריה: <b>${state.category}</b>\n\n` +
    `<b>${wordDisplay}</b>\n\n` +
    `📊 <b>ניקוד:</b>\n${scoreboard}\n\n` +
    `🎮 <b>תור:</b> ${playerMention}\n` +
    `⏱ <i>30 שניות לבחירה</i>`;

  if (turnChanged) {
    // Turn changed - delete old and send new to trigger notification
    if (state.gameBoardMessageId) {
      try {
        await ctx.api.deleteMessage(chatId, state.gameBoardMessageId);
      } catch {
        // Ignore if message can't be deleted
      }
    }
    const message = await ctx.api.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
    state.gameBoardMessageId = message.message_id;
    await saveGameState(chatId, state);
  } else if (state.gameBoardMessageId) {
    // Same player continues - just edit existing message
    try {
      await ctx.api.editMessageText(chatId, state.gameBoardMessageId, text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    } catch {
      // Message might not exist, send new one
      const message = await ctx.api.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
      state.gameBoardMessageId = message.message_id;
      await saveGameState(chatId, state);
    }
  }
}

/**
 * Build word display with revealed letters
 * Uses RLM (Right-to-Left Mark) to force RTL alignment even with underscores
 */
function buildWordDisplay(state: GameState): string {
  const RLM = '\u200F'; // Right-to-Left Mark
  const revealedSet = new Set(state.revealedLetters);

  // Guard against combining marks (niqqud) orphaning onto spaces, which crashes
  // some Telegram clients. New words are already sanitized; this covers any
  // in-flight game whose word predates the fix.
  const display = stripHebrewMarks(state.word)
    .split('')
    .map((char) => {
      if (char === ' ') {
        return '   '; // Triple space for word breaks
      }
      if (!isHebrewLetter(char)) {
        return char; // Keep non-Hebrew characters as-is
      }
      const normalized = normalize(char);
      if (revealedSet.has(normalized)) {
        return char;
      }
      return '_';
    })
    .join(' ');

  // Wrap with RLM to force RTL alignment
  return `${RLM}${display}${RLM}`;
}

/**
 * Build scoreboard text
 * Uses RLM (Right-to-Left Mark) to force consistent RTL alignment
 */
function buildScoreboard(state: GameState): string {
  const RLM = '\u200F'; // Right-to-Left Mark
  return state.playerOrder
    .map((id, index) => {
      const player = state.playersData[id];
      const isCurrentTurn = index === state.turnIndex;
      const marker = isCurrentTurn ? '➡️' : '⬜';
      const score = player?.score || 0;
      const name = player?.name || 'שחקן';
      // Format: marker | score | name (RTL aligned)
      return `${RLM}${marker} ${score} נק' • ${name}`;
    })
    .join('\n');
}

/**
 * Count the number of unique unrevealed Hebrew letters in the word
 */
function countUnrevealedLetters(state: GameState): number {
  const revealedSet = new Set(state.revealedLetters);
  const unrevealedNormalized = new Set<string>();

  for (const char of state.word) {
    if (char === ' ' || !isHebrewLetter(char)) {
      continue;
    }
    const normalized = normalize(char);
    if (!revealedSet.has(normalized)) {
      unrevealedNormalized.add(normalized);
    }
  }

  return unrevealedNormalized.size;
}

/**
 * Check if the word is completely revealed
 */
function isWordComplete(state: GameState): boolean {
  const revealedSet = new Set(state.revealedLetters);

  for (const char of state.word) {
    if (char === ' ' || !isHebrewLetter(char)) {
      continue;
    }
    const normalized = normalize(char);
    if (!revealedSet.has(normalized)) {
      return false;
    }
  }

  return true;
}

/**
 * Register bot commands with Telegram
 */
export async function registerCommands(bot: Bot): Promise<void> {
  try {
    // Commands for private chats
    await bot.api.setMyCommands(
      [
        { command: 'start', description: '🎡 התחל שיחה עם הבוט' },
        { command: 'help', description: '❓ עזרה וחוקי המשחק' },
      ],
      { scope: { type: 'all_private_chats' } },
    );

    // Commands for all users in groups
    await bot.api.setMyCommands(
      [
        { command: 'start_game', description: '🎮 התחל משחק חדש' },
        { command: 'end_game', description: '🛑 סיים משחק' },
        { command: 'leave', description: '🚪 עזוב את המשחק' },
        { command: 'help', description: '❓ עזרה וחוקי המשחק' },
      ],
      { scope: { type: 'all_group_chats' } },
    );
  } catch (error) {
    console.error('Failed to register commands:', error);
  }
}

export { DEFAULT_WIN_LIMIT };

/**
 * Timeout checker for cron job
 */

import { Bot } from 'grammy';
import { type GameState, MAX_TIMEOUTS, REDIS_PREFIX, SOLUTION_TIMEOUT_MS, TURN_TIMEOUT_MS } from './types';
import { createKickKeyboard, createLetterKeyboard } from './utils/keyboard';
import {
  deleteGameState,
  getCurrentPlayer,
  getCurrentPlayerId,
  getRedisClient,
  incrementTimeout,
  nextTurn,
  removePlayer,
  saveGameState,
} from './utils/redis';

const token = process.env.BOT_TOKEN;
if (!token) {
  throw new Error('BOT_TOKEN environment variable is not set');
}

const bot = new Bot(token);

/**
 * Check all active games for timeouts
 */
export async function checkAllGameTimeouts(): Promise<{ checked: number; timedOut: number }> {
  const redis = getRedisClient();

  // Find all game keys
  const keys = await redis.keys(`${REDIS_PREFIX}game:*`);

  let checked = 0;
  let timedOut = 0;

  for (const key of keys) {
    const data = await redis.get(key);
    if (!data) {
      continue;
    }

    const state: GameState = JSON.parse(data);
    checked++;

    // Only check games that are playing
    if (state.status !== 'playing') {
      continue;
    }

    const chatId = Number.parseInt(key.replace(`${REDIS_PREFIX}game:`, ''), 10);

    // Check solution timeout first
    if (state.awaitingSolution && state.solutionStartTime) {
      if (Date.now() - state.solutionStartTime > SOLUTION_TIMEOUT_MS) {
        await handleSolutionTimeout(chatId, state);
        timedOut++;
        continue;
      }
    }

    // Check turn timeout
    if (state.turnStartTime && Date.now() - state.turnStartTime > TURN_TIMEOUT_MS) {
      await handleTurnTimeout(chatId, state);
      timedOut++;
    }
  }

  return { checked, timedOut };
}

/**
 * Handle turn timeout via cron
 */
async function handleTurnTimeout(chatId: number, state: GameState): Promise<void> {
  const timedOutPlayerId = getCurrentPlayerId(state);
  const timedOutPlayer = getCurrentPlayer(state);
  const timedOutPlayerName = timedOutPlayer?.name || 'השחקן';

  if (!timedOutPlayerId) {
    return;
  }

  // Increment timeout count
  let newState = incrementTimeout(state, timedOutPlayerId);
  const timeoutCount = newState.playersData[timedOutPlayerId]?.timeouts || 0;

  // Check if player should be kicked
  if (timeoutCount >= MAX_TIMEOUTS) {
    newState = removePlayer(newState, timedOutPlayerId);

    await bot.api.sendMessage(chatId, `🚫 <b>${timedOutPlayerName}</b> הוסר/ה מהמשחק לאחר ${MAX_TIMEOUTS} פסילות!`, {
      parse_mode: 'HTML',
    });

    // Check if game should end (no players left or only 1)
    if (newState.playerOrder.length < 1) {
      await bot.api.sendMessage(chatId, '🛑 המשחק הסתיים - אין מספיק שחקנים.');
      await deleteGameState(chatId);
      return;
    }
  } else {
    // Just move to next player
    newState = nextTurn(newState);

    // Send timeout message with admin kick option
    const kickKeyboard = createKickKeyboard(timedOutPlayerId, timedOutPlayerName);
    await bot.api.sendMessage(
      chatId,
      `⏰ נגמר הזמן ל-<b>${timedOutPlayerName}</b>! (${timeoutCount}/${MAX_TIMEOUTS}) התור עובר.\n<i>מנהלים יכולים להעיף:</i>`,
      { parse_mode: 'HTML', reply_markup: kickKeyboard },
    );
  }

  newState.turnStartTime = Date.now();
  await saveGameState(chatId, newState);

  // Send updated game board
  await sendGameBoard(chatId, newState);
}

/**
 * Handle solution timeout via cron
 */
async function handleSolutionTimeout(chatId: number, state: GameState): Promise<void> {
  const timedOutPlayerId = state.solvingPlayerId;
  const timedOutPlayer = timedOutPlayerId ? state.playersData[timedOutPlayerId] : undefined;
  const timedOutPlayerName = timedOutPlayer?.name || 'השחקן';

  // Clear solution flags
  state.awaitingSolution = false;
  state.solvingPlayerId = undefined;
  state.solutionMessageId = undefined;
  state.solutionStartTime = undefined;

  if (!timedOutPlayerId) {
    return;
  }

  // Increment timeout count
  let newState = incrementTimeout(state, timedOutPlayerId);
  const timeoutCount = newState.playersData[timedOutPlayerId]?.timeouts || 0;

  // Check if player should be kicked
  if (timeoutCount >= MAX_TIMEOUTS) {
    newState = removePlayer(newState, timedOutPlayerId);

    await bot.api.sendMessage(chatId, `🚫 <b>${timedOutPlayerName}</b> הוסר/ה מהמשחק לאחר ${MAX_TIMEOUTS} פסילות!`, {
      parse_mode: 'HTML',
    });

    // Check if game should end
    if (newState.playerOrder.length < 1) {
      await bot.api.sendMessage(chatId, '🛑 המשחק הסתיים - אין מספיק שחקנים.');
      await deleteGameState(chatId);
      return;
    }
  } else {
    // Just move to next player
    newState = nextTurn(newState);

    // Send timeout message with admin kick option
    const kickKeyboard = createKickKeyboard(timedOutPlayerId, timedOutPlayerName);
    await bot.api.sendMessage(
      chatId,
      `⏰ נגמר הזמן לפתרון ל-<b>${timedOutPlayerName}</b>! (${timeoutCount}/${MAX_TIMEOUTS}) התור עובר.\n<i>מנהלים יכולים להעיף:</i>`,
      { parse_mode: 'HTML', reply_markup: kickKeyboard },
    );
  }

  newState.turnStartTime = Date.now();
  await saveGameState(chatId, newState);

  // Send updated game board
  await sendGameBoard(chatId, newState);
}

/**
 * Send game board message
 * Always sends new message to trigger notification for mentioned player
 */
async function sendGameBoard(chatId: number, state: GameState): Promise<void> {
  const wordDisplay = buildWordDisplay(state);
  const scoreboard = buildScoreboard(state);
  const currentPlayerId = getCurrentPlayerId(state);
  const currentPlayer = getCurrentPlayer(state);
  const revealedSet = new Set(state.revealedLetters);
  const keyboard = createLetterKeyboard(revealedSet);

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
    `⏱ <i>דקה לבחירה</i>`;

  // Try to delete old message to reduce clutter
  if (state.gameBoardMessageId) {
    try {
      await bot.api.deleteMessage(chatId, state.gameBoardMessageId);
    } catch {
      // Ignore if message can't be deleted
    }
  }

  // Send new message to trigger notification
  const message = await bot.api.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });

  // Update message ID in state
  state.gameBoardMessageId = message.message_id;
  await saveGameState(chatId, state);
}

/**
 * Build word display with revealed letters
 * Uses RLM (Right-to-Left Mark) to force RTL alignment even with underscores
 */
function buildWordDisplay(state: GameState): string {
  const RLM = '\u200F'; // Right-to-Left Mark
  const revealedSet = new Set(state.revealedLetters);
  const FINAL_TO_REGULAR: Record<string, string> = { ך: 'כ', ם: 'מ', ן: 'נ', ף: 'פ', ץ: 'צ' };

  const display = state.word
    .split('')
    .map((char) => {
      if (char === ' ') {
        return '   ';
      }
      const code = char.charCodeAt(0);
      const isHebrew = code >= 0x05d0 && code <= 0x05ea;
      if (!isHebrew) {
        return char;
      }
      const normalized = FINAL_TO_REGULAR[char] ?? char;
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

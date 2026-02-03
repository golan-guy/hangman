/**
 * Timeout checker for cron job
 */

import { Bot } from 'grammy';
import { type GameState, REDIS_PREFIX, SOLUTION_TIMEOUT_MS, TURN_TIMEOUT_MS } from './types';
import { createLetterKeyboard } from './utils/keyboard';
import { getCurrentPlayer, getCurrentPlayerId, getRedisClient, nextTurn, saveGameState } from './utils/redis';

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
  const timedOutPlayer = getCurrentPlayer(state);
  const timedOutPlayerName = timedOutPlayer?.name || 'השחקן';

  // Move to next player with fresh timer
  const newState = nextTurn(state);
  newState.turnStartTime = Date.now();
  await saveGameState(chatId, newState);

  // Send timeout message
  await bot.api.sendMessage(chatId, `⏰ נגמר הזמן ל-<b>${timedOutPlayerName}</b>! התור עובר.`, {
    parse_mode: 'HTML',
  });

  // Send updated game board
  await sendGameBoard(chatId, newState);
}

/**
 * Handle solution timeout via cron
 */
async function handleSolutionTimeout(chatId: number, state: GameState): Promise<void> {
  const timedOutPlayer = state.solvingPlayerId ? state.playersData[state.solvingPlayerId] : undefined;
  const timedOutPlayerName = timedOutPlayer?.name || 'השחקן';

  // Clear solution flags and move to next player
  state.awaitingSolution = false;
  state.solvingPlayerId = undefined;
  state.solutionMessageId = undefined;
  state.solutionStartTime = undefined;

  const newState = nextTurn(state);
  newState.turnStartTime = Date.now();
  await saveGameState(chatId, newState);

  // Send timeout message
  await bot.api.sendMessage(chatId, `⏰ נגמר הזמן לפתרון ל-<b>${timedOutPlayerName}</b>! התור עובר.`, {
    parse_mode: 'HTML',
  });

  // Send updated game board
  await sendGameBoard(chatId, newState);
}

/**
 * Send game board message
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
    `<code>${wordDisplay}</code>\n\n` +
    `📊 <b>ניקוד:</b>\n${scoreboard}\n\n` +
    `🎮 <b>תור:</b> ${playerMention}`;

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
 */
function buildWordDisplay(state: GameState): string {
  const revealedSet = new Set(state.revealedLetters);
  const FINAL_TO_REGULAR: Record<string, string> = { ך: 'כ', ם: 'מ', ן: 'נ', ף: 'פ', ץ: 'צ' };

  return state.word
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

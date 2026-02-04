/**
 * Inline keyboard utilities for the game
 */

import { InlineKeyboard } from 'grammy';
import { HEBREW_LETTERS, normalize } from './normalize';

/** Number of letters per row in the keyboard */
const LETTERS_PER_ROW = 5;

/**
 * Create the join phase keyboard
 * @returns InlineKeyboard with join and start buttons
 */
export function createJoinKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('🎮 הצטרפות', 'action:join').row().text('▶️ התחל משחק', 'action:start');
}

/**
 * Create the letter selection keyboard
 * @param revealedLetters - Set of normalized letters already guessed
 * @returns InlineKeyboard with available letters and solve button
 */
export function createLetterKeyboard(revealedLetters: Set<string>): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  // Filter out already guessed letters (keep original א-ת order)
  const availableLetters = HEBREW_LETTERS.filter((letter) => !revealedLetters.has(normalize(letter)));

  // Split into rows and reverse each row for RTL display
  // So א ב ג ד ה becomes ה ד ג ב א (reads right-to-left as א ב ג ד ה)
  for (let i = 0; i < availableLetters.length; i += LETTERS_PER_ROW) {
    const row = availableLetters.slice(i, i + LETTERS_PER_ROW).reverse();
    for (const letter of row) {
      keyboard.text(letter, `letter:${letter}`);
    }
    if (i + LETTERS_PER_ROW < availableLetters.length) {
      keyboard.row();
    }
  }

  // Add solve and leave buttons on new row
  keyboard.row().text('💡 פתרון המילה', 'action:solve').text('🚪 עזיבה', 'action:leave');

  return keyboard;
}

/**
 * Create an empty keyboard (for non-turn players)
 * @returns InlineKeyboard with just a message
 */
export function createWaitingKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('⏳ ממתין לתורך...', 'action:wait');
}

/**
 * Create game over keyboard
 * @returns InlineKeyboard with new game option
 */
export function createGameOverKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('🔄 משחק חדש', 'action:new_game');
}

/**
 * Create admin kick button keyboard
 * @param playerId - ID of player to kick
 * @param playerName - Name of player for display
 * @returns InlineKeyboard with kick option
 */
export function createKickKeyboard(playerId: number, playerName: string): InlineKeyboard {
  return new InlineKeyboard().text(`🚫 להעיף את ${playerName}`, `kick:${playerId}`);
}

/**
 * Parse callback data from button press
 * @param data - Callback data string
 * @returns Parsed action and optional letter
 */
export function parseCallbackData(data: string): { action: string; value?: string } {
  const [action, value] = data.split(':');
  return { action, value };
}

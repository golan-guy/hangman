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

  // Filter out already guessed letters
  const availableLetters = HEBREW_LETTERS.filter((letter) => !revealedLetters.has(normalize(letter)));

  // Add letters in rows (RTL friendly layout)
  for (let i = 0; i < availableLetters.length; i++) {
    const letter = availableLetters[i];
    keyboard.text(letter, `letter:${letter}`);

    // Add row break after every LETTERS_PER_ROW letters
    if ((i + 1) % LETTERS_PER_ROW === 0 && i < availableLetters.length - 1) {
      keyboard.row();
    }
  }

  // Add solve button on new row
  keyboard.row().text('💡 פתרון המילה', 'action:solve');

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
 * Parse callback data from button press
 * @param data - Callback data string
 * @returns Parsed action and optional letter
 */
export function parseCallbackData(data: string): { action: string; value?: string } {
  const [action, value] = data.split(':');
  return { action, value };
}

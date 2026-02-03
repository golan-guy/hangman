/**
 * Hebrew letter normalization utilities
 * Handles final letters (אותיות סופיות) conversion
 */

/** Mapping of final letters to their regular form */
const FINAL_TO_REGULAR: Record<string, string> = {
  ך: 'כ',
  ם: 'מ',
  ן: 'נ',
  ף: 'פ',
  ץ: 'צ',
};

/** Mapping of regular letters to their final form */
const REGULAR_TO_FINAL: Record<string, string> = {
  כ: 'ך',
  מ: 'ם',
  נ: 'ן',
  פ: 'ף',
  צ: 'ץ',
};

/** All Hebrew letters (non-final, for keyboard) */
export const HEBREW_LETTERS = [
  'א',
  'ב',
  'ג',
  'ד',
  'ה',
  'ו',
  'ז',
  'ח',
  'ט',
  'י',
  'כ',
  'ל',
  'מ',
  'נ',
  'ס',
  'ע',
  'פ',
  'צ',
  'ק',
  'ר',
  'ש',
  'ת',
];

/**
 * Normalize a Hebrew character to its regular (non-final) form
 * @param char - Single Hebrew character
 * @returns Normalized character (final letters become regular)
 */
export function normalize(char: string): string {
  return FINAL_TO_REGULAR[char] ?? char;
}

/**
 * Get both regular and final forms of a letter
 * @param letter - A Hebrew letter (can be either form)
 * @returns Array containing both forms [regular, final] or just [letter] if no final form
 */
export function getBothForms(letter: string): string[] {
  const normalized = normalize(letter);
  const finalForm = REGULAR_TO_FINAL[normalized];
  return finalForm ? [normalized, finalForm] : [normalized];
}

/**
 * Normalize an entire string (for comparison)
 * Converts all final letters to regular and removes spaces
 * @param str - Hebrew string
 * @returns Normalized string
 */
export function normalizeString(str: string): string {
  return str
    .split('')
    .map((char) => normalize(char))
    .join('')
    .replace(/\s/g, '');
}

/**
 * Check if a character is a Hebrew letter
 * @param char - Character to check
 * @returns True if Hebrew letter
 */
export function isHebrewLetter(char: string): boolean {
  const code = char.charCodeAt(0);
  // Hebrew Unicode range: 0x0590 - 0x05FF
  return code >= 0x05d0 && code <= 0x05ea;
}

/**
 * Compare two Hebrew strings for equality (ignoring spaces and final letters)
 * @param str1 - First string
 * @param str2 - Second string
 * @returns True if strings match
 */
export function compareHebrewStrings(str1: string, str2: string): boolean {
  return normalizeString(str1) === normalizeString(str2);
}

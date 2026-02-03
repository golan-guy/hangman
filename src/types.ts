/**
 * TypeScript interfaces for the Wheel of Fortune Telegram Bot
 */

/** Game status phases */
export type GameStatus = 'joining' | 'playing';

/** Player data stored in Redis */
export interface PlayerData {
  name: string;
  score: number;
}

/** Complete game state stored in Redis */
export interface GameState {
  /** The secret word to guess */
  word: string;
  /** Category of the current word */
  category: string;
  /** Set of normalized letters that have been revealed */
  revealedLetters: string[];
  /** Ordered array of player IDs representing turn order */
  playerOrder: number[];
  /** Map of player ID to their data (name, score) */
  playersData: Record<number, PlayerData>;
  /** Current turn index in playerOrder array */
  turnIndex: number;
  /** Points needed to win the game */
  winLimit: number;
  /** Current game phase */
  status: GameStatus;
  /** ID of the user who started the game (admin) */
  startedBy: number;
  /** Message ID of the game board for editing */
  gameBoardMessageId?: number;
  /** Flag indicating we're waiting for a solution attempt */
  awaitingSolution?: boolean;
  /** Player ID who is attempting to solve */
  solvingPlayerId?: number;
  /** Message ID of the solution prompt (to verify reply) */
  solutionMessageId?: number;
  /** Timestamp when current turn started (ms) */
  turnStartTime?: number;
  /** Timestamp when solution attempt started (ms) */
  solutionStartTime?: number;
}

/** Timeout duration in milliseconds */
export const TURN_TIMEOUT_MS = 30_000; // 30 seconds
export const SOLUTION_TIMEOUT_MS = 30_000; // 30 seconds

/** Word entry in the word bank */
export interface WordEntry {
  word: string;
  category: string;
}

/** Hebrew letter mapping for final letters */
export interface LetterMapping {
  regular: string;
  final: string;
}

/** Callback data structure for inline keyboard */
export interface CallbackData {
  action: 'join' | 'start' | 'guess' | 'solve';
  letter?: string;
}

/** Redis key prefix for this bot */
export const REDIS_PREFIX = 'hangman:';

/** Get Redis key for a game */
export const getRedisKey = (chatId: number): string => `${REDIS_PREFIX}game:${chatId}`;

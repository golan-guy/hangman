/**
 * Redis state management utilities
 */

import Redis from 'ioredis';
import type { GameState, PlayerData } from '../types';
import { getRedisKey } from '../types';

/** Redis client singleton */
let redisClient: Redis | null = null;

/** Redis database number for this bot */
const REDIS_DB = 3;

/**
 * Get or create Redis client
 * @returns Redis client instance
 */
export function getRedisClient(): Redis {
  if (!redisClient) {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      throw new Error('REDIS_URL environment variable is not set');
    }
    redisClient = new Redis(redisUrl, { db: REDIS_DB });
  }
  return redisClient;
}

/**
 * Get game state from Redis
 * @param chatId - Telegram chat ID
 * @returns Game state or null if not found
 */
export async function getGameState(chatId: number): Promise<GameState | null> {
  const redis = getRedisClient();
  const key = getRedisKey(chatId);
  const data = await redis.get(key);

  if (!data) {
    return null;
  }

  return JSON.parse(data) as GameState;
}

/**
 * Save game state to Redis
 * @param chatId - Telegram chat ID
 * @param state - Game state to save
 */
export async function saveGameState(chatId: number, state: GameState): Promise<void> {
  const redis = getRedisClient();
  const key = getRedisKey(chatId);
  // Set with 24 hour expiry
  await redis.set(key, JSON.stringify(state), 'EX', 86400);
}

/**
 * Delete game state from Redis
 * @param chatId - Telegram chat ID
 */
export async function deleteGameState(chatId: number): Promise<void> {
  const redis = getRedisClient();
  const key = getRedisKey(chatId);
  await redis.del(key);
}

/**
 * Create initial game state
 * @param word - Secret word
 * @param category - Word category
 * @param startedBy - User ID who started the game
 * @param winLimit - Points needed to win
 * @returns Initial game state
 */
export function createInitialState(word: string, category: string, startedBy: number, winLimit: number): GameState {
  return {
    word,
    category,
    revealedLetters: [],
    playerOrder: [],
    playersData: {},
    turnIndex: 0,
    winLimit,
    status: 'joining',
    startedBy,
  };
}

/**
 * Add a player to the game
 * @param state - Current game state
 * @param playerId - Player's Telegram ID
 * @param playerName - Player's display name
 * @returns Updated game state
 */
export function addPlayer(state: GameState, playerId: number, playerName: string): GameState {
  // Don't add if already in game
  if (state.playerOrder.includes(playerId)) {
    return state;
  }

  return {
    ...state,
    playerOrder: [...state.playerOrder, playerId],
    playersData: {
      ...state.playersData,
      [playerId]: { name: playerName, score: 0, timeouts: 0 },
    },
  };
}

/**
 * Add a revealed letter to the game state
 * @param state - Current game state
 * @param letter - Normalized letter to add
 * @returns Updated game state
 */
export function addRevealedLetter(state: GameState, letter: string): GameState {
  if (state.revealedLetters.includes(letter)) {
    return state;
  }

  return {
    ...state,
    revealedLetters: [...state.revealedLetters, letter],
  };
}

/**
 * Move to next player's turn
 * @param state - Current game state
 * @returns Updated game state
 */
export function nextTurn(state: GameState): GameState {
  const nextIndex = (state.turnIndex + 1) % state.playerOrder.length;
  return {
    ...state,
    turnIndex: nextIndex,
  };
}

/**
 * Add points to a player
 * @param state - Current game state
 * @param playerId - Player ID
 * @param points - Points to add
 * @returns Updated game state
 */
export function addPoints(state: GameState, playerId: number, points: number): GameState {
  const playerData = state.playersData[playerId];
  if (!playerData) {
    return state;
  }

  return {
    ...state,
    playersData: {
      ...state.playersData,
      [playerId]: {
        ...playerData,
        score: playerData.score + points,
      },
    },
  };
}

/**
 * Get current player ID
 * @param state - Current game state
 * @returns Current player's ID
 */
export function getCurrentPlayerId(state: GameState): number | undefined {
  return state.playerOrder[state.turnIndex];
}

/**
 * Get current player data
 * @param state - Current game state
 * @returns Current player's data
 */
export function getCurrentPlayer(state: GameState): PlayerData | undefined {
  const playerId = getCurrentPlayerId(state);
  return playerId !== undefined ? state.playersData[playerId] : undefined;
}

/**
 * Check if a player has won
 * @param state - Current game state
 * @returns Winner's ID or undefined
 */
export function checkWinner(state: GameState): number | undefined {
  for (const [playerId, data] of Object.entries(state.playersData)) {
    if (data.score >= state.winLimit) {
      return Number(playerId);
    }
  }
  return undefined;
}

/**
 * Start a new round with a new word
 * @param state - Current game state
 * @param word - New secret word
 * @param category - New category
 * @returns Updated game state
 */
export function newRound(state: GameState, word: string, category: string): GameState {
  return {
    ...state,
    word,
    category,
    revealedLetters: [],
    awaitingSolution: false,
    solvingPlayerId: undefined,
    solutionMessageId: undefined,
  };
}

/**
 * Increment timeout count for a player
 * @param state - Current game state
 * @param playerId - Player ID
 * @returns Updated game state
 */
export function incrementTimeout(state: GameState, playerId: number): GameState {
  const playerData = state.playersData[playerId];
  if (!playerData) {
    return state;
  }

  return {
    ...state,
    playersData: {
      ...state.playersData,
      [playerId]: {
        ...playerData,
        timeouts: (playerData.timeouts || 0) + 1,
      },
    },
  };
}

/**
 * Remove a player from the game
 * @param state - Current game state
 * @param playerId - Player ID to remove
 * @returns Updated game state
 */
export function removePlayer(state: GameState, playerId: number): GameState {
  const playerIndex = state.playerOrder.indexOf(playerId);
  if (playerIndex === -1) {
    return state;
  }

  const newPlayerOrder = state.playerOrder.filter((id) => id !== playerId);
  const { [playerId]: _, ...remainingPlayers } = state.playersData;

  // Adjust turn index if needed
  let newTurnIndex = state.turnIndex;
  if (playerIndex < state.turnIndex) {
    // Removed player was before current turn, shift back
    newTurnIndex = Math.max(0, state.turnIndex - 1);
  } else if (playerIndex === state.turnIndex) {
    // Removed player was current turn, keep same index but wrap if needed
    newTurnIndex = newPlayerOrder.length > 0 ? state.turnIndex % newPlayerOrder.length : 0;
  }

  return {
    ...state,
    playerOrder: newPlayerOrder,
    playersData: remainingPlayers,
    turnIndex: newTurnIndex,
  };
}

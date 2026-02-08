/**
 * Wikidata integration for fetching Hebrew words by category.
 * Uses SPARQL queries against the Wikidata Query Service, with Redis caching.
 */

import type { WordEntry } from '../types';
import { getRedisClient } from '../utils/redis';

/** Wikidata SPARQL endpoint */
const SPARQL_ENDPOINT = 'https://query.wikidata.org/sparql';

/** Redis cache key prefix for word lists */
const WORDS_CACHE_PREFIX = 'hangman:words:';

/** Cache TTL: 24 hours */
const CACHE_TTL_SECONDS = 86400;

/** Max words to fetch per category */
const WORDS_PER_CATEGORY = 500;

// ---------------------------------------------------------------------------
// Category definitions
// ---------------------------------------------------------------------------

/** Wikidata category definition */
interface WikidataCategory {
  /** Wikidata item ID (e.g. "Q6256" for countries) */
  id: string;
  /** Hebrew display name shown to players */
  name: string;
  /**
   * Optional custom SPARQL triple pattern.
   * When omitted the default `?item wdt:P31 wd:{id}` is used.
   * Use this for occupation-based queries or subclass traversal.
   */
  pattern?: string;
}

/** All categories available for the game */
export const CATEGORIES: WikidataCategory[] = [
  // --- People ---
  { id: 'Q5', name: 'אישים' },
  {
    id: 'Q937857',
    name: 'כדורגלנים',
    pattern: '?item wdt:P31 wd:Q5 . ?item wdt:P106 wd:Q937857 .',
  },
  {
    id: 'Q33999',
    name: 'שחקנים',
    pattern: '?item wdt:P31 wd:Q5 . ?item wdt:P106 wd:Q33999 .',
  },
  {
    id: 'Q177220',
    name: 'זמרים',
    pattern: '?item wdt:P31 wd:Q5 . ?item wdt:P106 wd:Q177220 .',
  },

  // --- Geography ---
  { id: 'Q515', name: 'ערים' },
  { id: 'Q6256', name: 'מדינות' },
  { id: 'Q8502', name: 'הרים' },
  { id: 'Q4022', name: 'נהרות' },
  { id: 'Q23397', name: 'אגמים' },
  { id: 'Q23442', name: 'איים' },
  { id: 'Q8514', name: 'מדבריות' },
  { id: 'Q165', name: 'ימים ואוקיינוסים' },
  { id: 'Q46831', name: 'רכסי הרים' },

  // --- Nature & Science ---
  { id: 'Q729', name: 'בעלי חיים' },
  { id: 'Q10874', name: 'פירות' },
  { id: 'Q11004', name: 'ירקות' },
  { id: 'Q578521', name: 'גזעי כלבים' },
  { id: 'Q11344', name: 'יסודות כימיים' },
  { id: 'Q756', name: 'צמחים' },

  // --- Culture & Entertainment ---
  { id: 'Q11424', name: 'סרטים' },
  { id: 'Q5398426', name: 'סדרות טלוויזיה' },
  { id: 'Q7889', name: 'משחקי וידאו' },
  { id: 'Q571', name: 'ספרים' },
  { id: 'Q188451', name: 'סגנונות מוזיקה' },

  // --- Food ---
  { id: 'Q2095', name: 'מאכלים' },

  // --- Music & Art ---
  { id: 'Q34371', name: 'כלי נגינה' },

  // --- Sports ---
  { id: 'Q349', name: 'ענפי ספורט' },

  // --- Knowledge & Language ---
  { id: 'Q34770', name: 'שפות' },
  { id: 'Q11862829', name: 'תחומי לימוד' },

  // --- Professions & Organisations ---
  { id: 'Q1273707', name: 'מקצועות' },
  { id: 'Q4830453', name: 'חברות עסקיות' },
  { id: 'Q476028', name: 'מועדוני כדורגל' },
];

// ---------------------------------------------------------------------------
// SPARQL helpers
// ---------------------------------------------------------------------------

/**
 * Build a SPARQL query that fetches Hebrew labels for a given category.
 * Only returns items that have a Hebrew Wikipedia article (ensures notability
 * and a proper Hebrew name).
 */
function buildQuery(category: WikidataCategory): string {
  const triplePattern = category.pattern ?? `?item wdt:P31 wd:${category.id} .`;

  return `
SELECT DISTINCT ?itemLabel WHERE {
  ${triplePattern}
  ?item rdfs:label ?itemLabel .
  FILTER(LANG(?itemLabel) = "he")
  ?article schema:about ?item ;
           schema:isPartOf <https://he.wikipedia.org/> .
}
LIMIT ${WORDS_PER_CATEGORY}`.trim();
}

/** Response shape from the Wikidata SPARQL endpoint */
interface SparqlResponse {
  results: {
    bindings: Array<{ itemLabel: { value: string } }>;
  };
}

/**
 * Fetch words from Wikidata for a single category.
 * Returns an array of Hebrew strings suitable for the game.
 */
async function fetchFromWikidata(category: WikidataCategory): Promise<string[]> {
  const query = buildQuery(category);
  const url = `${SPARQL_ENDPOINT}?query=${encodeURIComponent(query)}&format=json`;

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'HangmanTelegramBot/1.0 (https://github.com)',
      Accept: 'application/sparql-results+json',
    },
  });

  if (!response.ok) {
    throw new Error(`Wikidata SPARQL query failed with status ${response.status}`);
  }

  const data = (await response.json()) as SparqlResponse;

  return data.results.bindings.map((b) => b.itemLabel.value).filter(isValidGameWord);
}

// ---------------------------------------------------------------------------
// Word validation
// ---------------------------------------------------------------------------

/** Hebrew Unicode range regex */
const HEBREW_CHAR = /[\u0590-\u05FF]/;

/**
 * Only allow Hebrew letters, spaces, apostrophe/geresh, double-quote/gershayim,
 * and hyphens (both ASCII and Hebrew maqaf ־).
 */
const VALID_WORD = /^[\u0590-\u05FF\s'"\-\u05BE\u05F3\u05F4]+$/;

/**
 * Check whether a label from Wikidata is a good word for the game.
 */
function isValidGameWord(word: string): boolean {
  if (word.length < 4 || word.length > 30) {
    return false;
  }
  if (word.includes('(') || word.includes(')')) {
    return false;
  }
  if (!HEBREW_CHAR.test(word)) {
    return false;
  }
  if (!VALID_WORD.test(word)) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Cache layer (Redis)
// ---------------------------------------------------------------------------

/**
 * Get the cached word list for a category, or fetch & cache it from Wikidata.
 */
async function getWordsForCategory(category: WikidataCategory): Promise<string[]> {
  const redis = getRedisClient();
  const cacheKey = `${WORDS_CACHE_PREFIX}${category.id}`;

  // Try cache first
  const cached = await redis.get(cacheKey);
  if (cached) {
    const words = JSON.parse(cached) as string[];
    if (words.length > 0) {
      return words;
    }
  }

  // Fetch from Wikidata
  const words = await fetchFromWikidata(category);

  // Cache even if empty (with shorter TTL) so we don't keep hammering Wikidata
  const ttl = words.length > 0 ? CACHE_TTL_SECONDS : 3600; // 1 h for empty
  await redis.set(cacheKey, JSON.stringify(words), 'EX', ttl);

  return words;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Small hardcoded fallback in case Wikidata AND Redis are both unreachable.
 */
const FALLBACK_WORDS: WordEntry[] = [
  { word: 'חתול', category: 'בעלי חיים' },
  { word: 'ירושלים', category: 'ערים' },
  { word: 'פסנתר', category: 'כלי נגינה' },
  { word: 'שוקולד', category: 'מאכלים' },
  { word: 'כדורגל', category: 'ספורט' },
  { word: 'אריה', category: 'בעלי חיים' },
  { word: 'תל אביב', category: 'ערים' },
  { word: 'גיטרה', category: 'כלי נגינה' },
  { word: 'פיצה', category: 'מאכלים' },
  { word: 'דולפין', category: 'בעלי חיים' },
];

/**
 * Get a random word + category from Wikidata.
 *
 * 1. Pick a random category
 * 2. Fetch (or read from cache) the word list
 * 3. Filter out already-used words
 * 4. Return a random word from the remaining list
 *
 * Falls back to a small hardcoded list if all else fails.
 *
 * @param exclude - Words already used in the current game (to prevent repeats)
 */
export async function getRandomWord(exclude?: string[]): Promise<WordEntry> {
  const excludeSet = new Set(exclude ?? []);

  // Shuffle categories so we don't always hit the same one on failure
  const shuffled = [...CATEGORIES].sort(() => Math.random() - 0.5);

  for (const category of shuffled) {
    try {
      const allWords = await getWordsForCategory(category);
      const available = allWords.filter((w) => !excludeSet.has(w));
      if (available.length > 0) {
        const word = available[Math.floor(Math.random() * available.length)];
        return { word, category: category.name };
      }
    } catch (error) {
      console.error(`[wikidata] Failed to get words for "${category.name}" (${category.id}):`, error);
    }
  }

  // Ultimate fallback
  console.warn('[wikidata] All categories failed – using hardcoded fallback');
  const fallback = FALLBACK_WORDS.filter((w) => !excludeSet.has(w.word));
  if (fallback.length > 0) {
    return fallback[Math.floor(Math.random() * fallback.length)];
  }
  return FALLBACK_WORDS[Math.floor(Math.random() * FALLBACK_WORDS.length)];
}

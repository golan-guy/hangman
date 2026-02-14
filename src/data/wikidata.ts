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

/**
 * Minimum number of Wikipedia sitelinks an item must have to be considered
 * "well-known enough" for the game. Items with more sitelinks have Wikipedia
 * articles in more languages, which is a strong proxy for popularity.
 */
const MIN_SITELINKS_DEFAULT = 15;

/** People (Q5) is an extremely broad category – require higher notability */
const MIN_SITELINKS_PEOPLE = 40;

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
  /**
   * Optional minimum sitelinks override for this category.
   * Categories with naturally fewer items (e.g. chemical elements, deserts)
   * can lower this threshold so they still return enough words.
   * Defaults to MIN_SITELINKS_DEFAULT (15).
   */
  minSitelinks?: number;
}

/** All categories available for the game */
export const CATEGORIES: WikidataCategory[] = [
  // --- People ---
  { id: 'Q5', name: 'אישים' },
  {
    id: 'Q937857',
    name: 'כדורגלנים',
    pattern: '?item wdt:P31 wd:Q5 . ?item wdt:P106 wd:Q937857 .',
    minSitelinks: 30,
  },
  {
    id: 'Q33999',
    name: 'שחקנים',
    pattern: '?item wdt:P31 wd:Q5 . ?item wdt:P106 wd:Q33999 .',
    minSitelinks: 30,
  },
  {
    id: 'Q177220',
    name: 'זמרים',
    pattern: '?item wdt:P31 wd:Q5 . ?item wdt:P106 wd:Q177220 .',
    minSitelinks: 30,
  },
  {
    id: 'Q901',
    name: 'מדענים',
    pattern: '?item wdt:P31 wd:Q5 . ?item wdt:P106 wd:Q901 .',
    minSitelinks: 30,
  },
  {
    id: 'Q1028181',
    name: 'צייירים',
    pattern: '?item wdt:P31 wd:Q5 . ?item wdt:P106 wd:Q1028181 .',
    minSitelinks: 25,
  },
  {
    id: 'Q36180',
    name: 'סופרים',
    pattern: '?item wdt:P31 wd:Q5 . ?item wdt:P106 wd:Q36180 .',
    minSitelinks: 30,
  },
  {
    id: 'Q82955',
    name: 'פוליטיקאים',
    pattern: '?item wdt:P31 wd:Q5 . ?item wdt:P106 wd:Q82955 .',
    minSitelinks: 35,
  },
  {
    id: 'Q3665646',
    name: 'כדורסלנים',
    pattern: '?item wdt:P31 wd:Q5 . ?item wdt:P106 wd:Q3665646 .',
    minSitelinks: 25,
  },
  {
    id: 'Q10843263',
    name: 'טניסאים',
    pattern: '?item wdt:P31 wd:Q5 . ?item wdt:P106 wd:Q10843263 .',
    minSitelinks: 25,
  },

  // --- Geography ---
  { id: 'Q515', name: 'ערים' },
  { id: 'Q6256', name: 'מדינות' },
  { id: 'Q8502', name: 'הרים' },
  { id: 'Q4022', name: 'נהרות' },
  { id: 'Q23397', name: 'אגמים' },
  { id: 'Q23442', name: 'איים' },
  { id: 'Q8514', name: 'מדבריות', minSitelinks: 8 },
  { id: 'Q165', name: 'ימים ואוקיינוסים' },
  { id: 'Q46831', name: 'רכסי הרים' },
  { id: 'Q46169', name: 'פארקים לאומיים', minSitelinks: 10 },
  {
    id: 'Q5119',
    name: 'בירות העולם',
    pattern: '?item wdt:P31 wd:Q5119 .',
    minSitelinks: 10,
  },

  // --- Nature & Science ---
  { id: 'Q729', name: 'בעלי חיים' },
  { id: 'Q10874', name: 'פירות' },
  { id: 'Q11004', name: 'ירקות' },
  { id: 'Q578521', name: 'גזעי כלבים' },
  { id: 'Q11344', name: 'יסודות כימיים', minSitelinks: 5 },
  { id: 'Q756', name: 'צמחים' },
  { id: 'Q2102', name: 'גזעי חתולים', minSitelinks: 8 },

  // --- Culture & Entertainment ---
  { id: 'Q11424', name: 'סרטים' },
  { id: 'Q5398426', name: 'סדרות טלוויזיה' },
  { id: 'Q7889', name: 'משחקי וידאו' },
  { id: 'Q571', name: 'ספרים' },
  { id: 'Q188451', name: 'סגנונות מוזיקה', minSitelinks: 8 },
  { id: 'Q215380', name: 'להקות מוזיקה' },
  { id: 'Q1344', name: 'אופרות', minSitelinks: 10 },
  { id: 'Q95074', name: 'דמויות בדיוניות', minSitelinks: 15 },

  // --- Food & Drink ---
  { id: 'Q2095', name: 'מאכלים' },
  { id: 'Q40050', name: 'משקאות', minSitelinks: 8 },
  { id: 'Q13580', name: 'תבלינים', minSitelinks: 8 },

  // --- Music & Art ---
  { id: 'Q34371', name: 'כלי נגינה', minSitelinks: 8 },

  // --- Sports ---
  { id: 'Q349', name: 'ענפי ספורט', minSitelinks: 8 },
  { id: 'Q476028', name: 'מועדוני כדורגל' },
  { id: 'Q18558301', name: 'אולימפיאדות', minSitelinks: 8 },

  // --- Knowledge & Language ---
  { id: 'Q34770', name: 'שפות' },
  { id: 'Q11862829', name: 'תחומי לימוד', minSitelinks: 8 },
  { id: 'Q9174', name: 'דתות', minSitelinks: 5 },

  // --- Health ---
  { id: 'Q12136', name: 'מחלות', minSitelinks: 10 },

  // --- Education ---
  { id: 'Q3918', name: 'אוניברסיטאות' },

  // --- Transportation ---
  { id: 'Q3041255', name: 'יצרני רכב', minSitelinks: 10 },
  { id: 'Q46970', name: 'חברות תעופה', minSitelinks: 10 },

  // --- Economics & Finance ---
  { id: 'Q8142', name: 'מטבעות', minSitelinks: 5 },

  // --- Professions & Organisations ---
  { id: 'Q1273707', name: 'מקצועות', minSitelinks: 8 },
  { id: 'Q4830453', name: 'חברות עסקיות' },
];

// ---------------------------------------------------------------------------
// SPARQL helpers
// ---------------------------------------------------------------------------

/** Cached word entry with optional description */
interface CachedWord {
  word: string;
  description?: string;
}

/**
 * Build a SPARQL query that fetches Hebrew labels and descriptions for a given category.
 * Only returns items that have a Hebrew Wikipedia article (ensures notability
 * and a proper Hebrew name).
 *
 * Results are ordered by number of Wikipedia sitelinks (descending) so the most
 * well-known items come first, and a minimum sitelinks threshold filters out
 * obscure entries that players are unlikely to recognise.
 */
function buildQuery(category: WikidataCategory): string {
  const triplePattern = category.pattern ?? `?item wdt:P31 wd:${category.id} .`;
  const minSitelinks = category.id === 'Q5' ? MIN_SITELINKS_PEOPLE : (category.minSitelinks ?? MIN_SITELINKS_DEFAULT);

  return `
SELECT DISTINCT ?itemLabel ?desc WHERE {
  ${triplePattern}
  ?item wikibase:sitelinks ?sitelinks .
  FILTER(?sitelinks >= ${minSitelinks})
  ?item rdfs:label ?itemLabel .
  FILTER(LANG(?itemLabel) = "he")
  OPTIONAL { ?item schema:description ?desc . FILTER(LANG(?desc) = "he") }
  ?article schema:about ?item ;
           schema:isPartOf <https://he.wikipedia.org/> .
}
ORDER BY DESC(?sitelinks)
LIMIT ${WORDS_PER_CATEGORY}`.trim();
}

/** Response shape from the Wikidata SPARQL endpoint */
interface SparqlResponse {
  results: {
    bindings: Array<{ itemLabel: { value: string }; desc?: { value: string } }>;
  };
}

/**
 * Fetch words from Wikidata for a single category.
 * Returns an array of word entries with optional descriptions.
 */
async function fetchFromWikidata(category: WikidataCategory): Promise<CachedWord[]> {
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

  return data.results.bindings
    .filter((b) => isValidGameWord(b.itemLabel.value))
    .map((b) => ({
      word: b.itemLabel.value,
      description: b.desc?.value,
    }));
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
async function getWordsForCategory(category: WikidataCategory): Promise<CachedWord[]> {
  const redis = getRedisClient();
  const cacheKey = `${WORDS_CACHE_PREFIX}${category.id}`;

  // Try cache first
  const cached = await redis.get(cacheKey);
  if (cached) {
    const parsed = JSON.parse(cached);
    // Handle both old format (string[]) and new format (CachedWord[])
    if (Array.isArray(parsed) && parsed.length > 0) {
      if (typeof parsed[0] === 'string') {
        return (parsed as string[]).map((w) => ({ word: w }));
      }
      return parsed as CachedWord[];
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
  { word: 'חתול', category: 'בעלי חיים', description: 'יונק מבויית' },
  { word: 'ירושלים', category: 'ערים', description: 'בירת ישראל' },
  { word: 'פסנתר', category: 'כלי נגינה', description: 'כלי נגינה עם קלידים' },
  { word: 'שוקולד', category: 'מאכלים', description: 'מאכל מתוק מקקאו' },
  { word: 'כדורגל', category: 'ספורט', description: 'ענף ספורט פופולרי' },
  { word: 'אריה', category: 'בעלי חיים', description: 'מלך החיות' },
  { word: 'תל אביב', category: 'ערים', description: 'עיר בישראל' },
  { word: 'גיטרה', category: 'כלי נגינה', description: 'כלי מיתר פרוט' },
  { word: 'פיצה', category: 'מאכלים', description: 'מאכל איטלקי' },
  { word: 'דולפין', category: 'בעלי חיים', description: 'יונק ימי' },
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
      const available = allWords.filter((w) => !excludeSet.has(w.word));
      if (available.length > 0) {
        const entry = available[Math.floor(Math.random() * available.length)];
        return { word: entry.word, category: category.name, description: entry.description };
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

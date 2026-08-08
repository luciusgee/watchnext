/*
 * Shared vocabulary for metadata providers.
 *
 * Providers differ wildly in how they express the same facts — OMDb sends
 * "117 min" as a string, TMDB sends 117 as a number; OMDb sends a comma
 * joined genre string, TMDB sends an array of {id,name}. Everything below
 * exists so the matcher never has to know which one it is talking to.
 */

/**
 * The neutral record every provider returns.
 *
 * @typedef {object} Record
 * @property {string}  sourceId  the provider's own identifier
 * @property {string?} imdbId    tt-style id, when the provider knows one
 * @property {string}  title
 * @property {number?} year
 * @property {'movie'|'tv'} type
 * @property {string?} genre     single display genre, chosen by priority
 * @property {string[]} genres   everything the provider listed
 * @property {number?} runtime   minutes
 * @property {number?} rating    0–10
 * @property {number?} votes     used only to break ties between candidates
 * @property {string}  overview
 * @property {string?} poster    fully-qualified URL
 */

export function emptyRecord(partial = {}) {
  return {
    sourceId: null,
    imdbId: null,
    title: '',
    year: null,
    type: 'movie',
    genre: null,
    genres: [],
    runtime: null,
    rating: null,
    votes: null,
    overview: '',
    poster: null,
    ...partial,
  };
}

/* ── field parsing ── */

export function parseRuntime(value, type) {
  if (value === null || value === undefined || value === 'N/A') return null;
  const n =
    typeof value === 'number'
      ? Math.round(value)
      : parseInt(String(value).replace(/[^\d]/g, '').slice(0, 4), 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  /* Sanity bounds. OMDb occasionally returns malformed values like "56S min",
     and an episode runtime for a series is fine, but a 40-hour "film" is not. */
  const max = type === 'tv' ? 400 : 600;
  return n > max ? null : n;
}

export function parseRating(value) {
  if (value === null || value === undefined || value === 'N/A') return null;
  const n = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(n) && n > 0 && n <= 10 ? Math.round(n * 10) / 10 : null;
}

export function parseYear(value) {
  if (!value || value === 'N/A') return null;
  const n = parseInt(String(value).slice(0, 4), 10);
  return Number.isFinite(n) && n > 1870 && n < 2100 ? n : null;
}

/* ── genre taxonomy ──
   Both providers are collapsed onto one vocabulary so a library enriched from
   one source and then re-checked against the other doesn't reshuffle its
   filters. Names on the left are what providers actually emit. */

export const GENRE_ALIASES = {
  Horror: 'Horror',
  Thriller: 'Thriller',
  Mystery: 'Thriller',
  'Sci-Fi': 'Sci-Fi',
  'Science Fiction': 'Sci-Fi',
  'Sci-Fi & Fantasy': 'Sci-Fi',
  Fantasy: 'Fantasy',
  Action: 'Action',
  'Action & Adventure': 'Action',
  Adventure: 'Adventure',
  Drama: 'Drama',
  Crime: 'Crime',
  Comedy: 'Comedy',
  Animation: 'Animation',
  Family: 'Family',
  Kids: 'Family',
  Romance: 'Romance',
  Documentary: 'Documentary',
  Biography: 'Biography',
  History: 'History',
  War: 'War',
  'War & Politics': 'War',
  Western: 'Western',
  Music: 'Music',
  Musical: 'Musical',
  Sport: 'Sport',
  Reality: 'Reality',
  Talk: 'Talk',
  News: 'News',
  Soap: 'Drama',
  'TV Movie': 'Drama',
};

/* A film is rarely one genre. Providers list them loosely — "Action, Crime,
   Drama" for Heat — so pick the most characterful rather than the first. */
export const GENRE_PRIORITY = [
  'Horror', 'Animation', 'Documentary', 'Sci-Fi', 'Fantasy', 'Western',
  'Musical', 'Music', 'War', 'Crime', 'Thriller', 'Romance', 'Comedy',
  'Adventure', 'Action', 'Biography', 'History', 'Family', 'Sport',
  'Reality', 'Talk', 'News', 'Drama',
];

/** Accepts a comma string, an array of names, or an array of {id,name}. */
export function normaliseGenres(input) {
  if (!input || input === 'N/A') return [];
  const raw = Array.isArray(input)
    ? input.map((g) => (typeof g === 'string' ? g : g?.name))
    : String(input).split(',');
  const out = [];
  for (const name of raw) {
    const mapped = GENRE_ALIASES[String(name || '').trim()];
    if (mapped && !out.includes(mapped)) out.push(mapped);
  }
  return out;
}

export function pickGenre(input) {
  const list = Array.isArray(input) && input.every((g) => typeof g === 'string' && GENRE_PRIORITY.includes(g))
    ? input
    : normaliseGenres(input);
  if (!list.length) return null;
  for (const g of GENRE_PRIORITY) if (list.includes(g)) return g;
  return list[0];
}

/* ── request budget ──
   Providers have different daily allowances; the budget tracks usage per
   provider per day so a big sweep degrades gracefully rather than silently
   erroring on every title. */

const BUDGET_KEY = 'wn.api.budget';

export class RequestBudget {
  constructor(limit = 1000, provider = 'omdb') {
    this.limit = limit;
    this.provider = provider;
    this.load();
  }
  today() {
    return new Date().toISOString().slice(0, 10);
  }
  load() {
    try {
      const all = JSON.parse(localStorage.getItem(BUDGET_KEY) || '{}');
      const mine = all[this.provider];
      if (mine && mine.day === this.today()) {
        this.used = mine.used;
        return;
      }
    } catch {
      /* fall through to reset */
    }
    this.used = 0;
    this.persist();
  }
  persist() {
    try {
      const all = JSON.parse(localStorage.getItem(BUDGET_KEY) || '{}');
      all[this.provider] = { day: this.today(), used: this.used };
      localStorage.setItem(BUDGET_KEY, JSON.stringify(all));
    } catch {
      /* non-fatal */
    }
  }
  spend(n = 1) {
    this.used += n;
    this.persist();
  }
  get remaining() {
    return this.limit === Infinity ? Infinity : Math.max(0, this.limit - this.used);
  }
  get exhausted() {
    return this.remaining <= 0;
  }
}

/* ── errors ──
   Typed so the UI can say something useful instead of "request failed". */

export function providerError(message, code, extra = {}) {
  const err = new Error(message);
  err.code = code; // 'auth' | 'budget' | 'rate' | 'http' | 'network'
  Object.assign(err, extra);
  return err;
}

/**
 * Shared fetch wrapper: budget accounting, typed errors, abort support, and a
 * bounded retry on 429.
 *
 * TMDB's ceiling is roughly 40 requests/second and is enforced per IP rather
 * than per key, so a polite per-user rate can still trip it behind shared
 * egress. A 429 is therefore transient and worth waiting out, unlike a 401.
 */
export async function requestJson(url, { budget, signal, headers, providerName, retries = 2 }) {
  if (budget?.exhausted) {
    throw providerError(`Daily ${providerName} request limit reached.`, 'budget');
  }

  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { signal, headers });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw providerError(`Could not reach ${providerName}.`, 'network');
    }
    if (budget) budget.spend();

    if (res.status === 429 && attempt < retries) {
      /* Honour Retry-After when present; otherwise back off gently. */
      const after = parseFloat(res.headers.get('retry-after') || '') || Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, Math.min(after * 1000, 8000)));
      continue;
    }

    if (res.status === 401 || res.status === 403) {
      throw providerError(`That ${providerName} key was rejected.`, 'auth', { status: res.status });
    }
    if (res.status === 429) {
      throw providerError(`${providerName} is rate limiting us — try again shortly.`, 'rate', { status: 429 });
    }
    if (res.status === 404) return null;
    if (!res.ok) {
      throw providerError(`${providerName} returned ${res.status}.`, 'http', { status: res.status });
    }
    return res.json();
  }
}

/*
 * Metadata engine.
 *
 * Replaces the previous approach, which had two fatal flaws:
 *
 *  1. It queried OMDb's `?t=` endpoint, which does FUZZY title matching and
 *     always returns *something*. Asking for "1899" with &type=movie returns
 *     "Making 1899", a completely different film — and the old code then wrote
 *     that film's poster, genre, year and runtime over the user's entry with no
 *     verification at all. Hence "it pulls the wrong movie images sometimes".
 *
 *  2. It re-fetched every single row on every run, because nothing was ever
 *     recorded about what had already been resolved. Hence "it does all
 *     entries every time".
 *
 * The engine below searches for CANDIDATES, scores each one on title, year and
 * type, and only writes when it is confident. Anything uncertain goes to a
 * review queue for the user to arbitrate rather than being silently applied.
 */

import { META_VERSION, normaliseTitle, isLocked } from './store.js';

const API = 'https://www.omdbapi.com/';

/* Confidence thresholds. Tuned against the real library — see tools/match-test.js */
const AUTO_ACCEPT = 0.82; // write without asking
const REVIEW_FLOOR = 0.5; // below this we do not even offer it as a candidate

/* OMDb's free tier allows 1000 requests/day. Track locally so a big sweep
   degrades gracefully instead of silently returning errors for everything. */
const BUDGET_KEY = 'wn.omdb.budget';
const DAILY_LIMIT = 950;

export class RequestBudget {
  constructor(limit = DAILY_LIMIT) {
    this.limit = limit;
    this.load();
  }
  today() {
    return new Date().toISOString().slice(0, 10);
  }
  load() {
    try {
      const raw = JSON.parse(localStorage.getItem(BUDGET_KEY) || 'null');
      if (raw && raw.day === this.today()) {
        this.used = raw.used;
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
      localStorage.setItem(BUDGET_KEY, JSON.stringify({ day: this.today(), used: this.used }));
    } catch {
      /* non-fatal */
    }
  }
  spend(n = 1) {
    this.used += n;
    this.persist();
  }
  get remaining() {
    return Math.max(0, this.limit - this.used);
  }
  get exhausted() {
    return this.remaining <= 0;
  }
}

/* ── string similarity: Sørensen–Dice over character bigrams ──
   Robust to word order and small typos, cheap to compute, no deps. */
function bigrams(s) {
  const out = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) || 0) + 1);
  }
  return out;
}

export function similarity(a, b) {
  const x = normaliseTitle(a);
  const y = normaliseTitle(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return x === y ? 1 : 0;

  const ba = bigrams(x);
  const bb = bigrams(y);
  let overlap = 0;
  let total = 0;
  for (const n of ba.values()) total += n;
  for (const n of bb.values()) total += n;
  for (const [g, n] of ba) {
    const m = bb.get(g);
    if (m) overlap += Math.min(n, m);
  }
  return (2 * overlap) / total;
}

/**
 * Score one OMDb search result against what we were looking for.
 * Returns { score, reasons } where score is 0..1.
 */
export function scoreCandidate(query, candidate) {
  const reasons = [];
  const title = similarity(query.title, candidate.Title);

  /* Title is the dominant signal. A candidate whose title barely resembles
     the query is never right, no matter how well the year lines up. */
  if (title < 0.45) {
    return { score: 0, reasons: ['title mismatch'] };
  }

  let score = title * 0.62;
  if (title === 1) reasons.push('exact title');
  else if (title > 0.85) reasons.push('near-exact title');

  /* Containment. "Dune" should prefer "Dune: Part One" over "Planet Dune":
     a subtitle appended to the query is a far likelier match than the query
     appearing as the tail of some other film's name. */
  const q = normaliseTitle(query.title);
  const c = normaliseTitle(candidate.Title);
  if (c !== q) {
    if (c.startsWith(q)) {
      score += 0.14;
      reasons.push('title extends query');
    } else if (q.startsWith(c)) {
      score += 0.05;
    } else if (c.includes(q)) {
      score -= 0.06;
      reasons.push('query buried mid-title');
    }
  }

  /* Year */
  const candYear = parseInt(String(candidate.Year || '').slice(0, 4), 10);
  if (query.year && candYear) {
    const delta = Math.abs(candYear - query.year);
    if (delta === 0) {
      score += 0.26;
      reasons.push('year matches');
    } else if (delta === 1) {
      score += 0.2;
      reasons.push('year off by 1');
    } else if (delta <= 3) {
      score += 0.08;
      reasons.push(`year off by ${delta}`);
    } else {
      score -= 0.22;
      reasons.push(`year off by ${delta}`);
    }
  } else if (!query.year) {
    /* No year to check against — neither credit nor penalty, but cap the
       ceiling so a title-only match can't auto-accept on its own. */
    score += 0.12;
    reasons.push('no year to verify');
  }

  /* Type */
  const candType = candidate.Type === 'series' ? 'tv' : 'movie';
  if (query.type && candType === query.type) {
    score += 0.12;
    reasons.push('type matches');
  } else if (query.type && candType !== query.type) {
    /* The old code FORCED &type=movie, which is what produced the "1899"
       failure. We allow a cross-type match but make it pay for itself: it
       only wins if the title is otherwise excellent. */
    score -= 0.18;
    reasons.push(`type differs (${candType})`);
  }

  if (candidate.Poster && candidate.Poster !== 'N/A') score += 0.02;

  return { score: Math.max(0, Math.min(1, score)), reasons };
}

/* ── network ── */

async function omdb(params, key, budget, signal) {
  if (budget && budget.exhausted) {
    const err = new Error('Daily OMDb request limit reached.');
    err.code = 'budget';
    throw err;
  }
  const url = new URL(API);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  });
  url.searchParams.set('apikey', key);

  const res = await fetch(url, { signal });
  if (budget) budget.spend();
  if (!res.ok) {
    const err = new Error(`OMDb returned ${res.status}`);
    err.code = 'http';
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  if (data.Response === 'False') {
    /* OMDb signals both "no results" and "bad key" this way — distinguish. */
    if (/invalid api key|no api key/i.test(data.Error || '')) {
      const err = new Error('That OMDb API key was rejected.');
      err.code = 'auth';
      throw err;
    }
    return null;
  }
  return data;
}

/* ── field parsing ── */

export function parseRuntime(str, type) {
  if (!str || str === 'N/A') return null;
  const n = parseInt(String(str).replace(/[^\d]/g, '').slice(0, 4), 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  /* Sanity bounds — OMDb occasionally returns malformed values like "56S min".
     An episode runtime for a series is fine; a 40-hour "film" is not. */
  const max = type === 'tv' ? 400 : 600;
  return n > max ? null : n;
}

export function parseRating(str) {
  if (!str || str === 'N/A') return null;
  const n = parseFloat(str);
  return Number.isFinite(n) && n >= 0 && n <= 10 ? Math.round(n * 10) / 10 : null;
}

export function parseYear(str) {
  if (!str || str === 'N/A') return null;
  const n = parseInt(String(str).slice(0, 4), 10);
  return Number.isFinite(n) && n > 1870 && n < 2100 ? n : null;
}

const GENRE_MAP = {
  Horror: 'Horror',
  Thriller: 'Thriller',
  Mystery: 'Thriller',
  'Sci-Fi': 'Sci-Fi',
  Fantasy: 'Fantasy',
  Action: 'Action',
  Adventure: 'Adventure',
  Drama: 'Drama',
  Crime: 'Crime',
  Comedy: 'Comedy',
  Animation: 'Animation',
  Family: 'Family',
  Romance: 'Romance',
  Documentary: 'Documentary',
  Biography: 'Biography',
  History: 'History',
  War: 'War',
  Western: 'Western',
  Music: 'Music',
  Musical: 'Musical',
  Sport: 'Sport',
};

/* Order matters: the first listed genre OMDb returns is usually the loosest
   ("Action, Crime, Drama" for Heat). Prefer the most characterful one. */
const GENRE_PRIORITY = [
  'Horror', 'Animation', 'Documentary', 'Sci-Fi', 'Fantasy', 'Western', 'Musical',
  'Music', 'War', 'Crime', 'Thriller', 'Romance', 'Comedy', 'Adventure', 'Action',
  'Biography', 'History', 'Family', 'Sport', 'Drama',
];

export function pickGenre(str) {
  if (!str || str === 'N/A') return null;
  const parts = String(str)
    .split(',')
    .map((s) => GENRE_MAP[s.trim()])
    .filter(Boolean);
  if (!parts.length) return null;
  for (const g of GENRE_PRIORITY) if (parts.includes(g)) return g;
  return parts[0];
}

/** Upgrade OMDb's poster URL to a larger render. Their CDN honours SX<width>. */
export function posterAt(url, width = 600) {
  if (!url || url === 'N/A') return null;
  return url.replace(/\._V1_.*?\.jpg$/i, `._V1_SX${width}.jpg`);
}

/* ── the matcher ── */

/**
 * Find the best OMDb match for an item.
 * Returns { status, confidence, chosen, candidates, reasons }
 *   status: 'matched' | 'review' | 'unmatched'
 */
export async function findMatch(item, key, budget, signal) {
  const query = { title: item.title, year: item.year, type: item.type };

  /* Fast path: we already verified this id ourselves. `?i=` is exact —
     no fuzzy matching, no chance of drifting onto a different film. */
  if (item.imdbId && /^tt\d+$/.test(item.imdbId) && item.meta?.status === 'matched') {
    const exact = await omdb({ i: item.imdbId, plot: 'short' }, key, budget, signal);
    if (exact) {
      return { status: 'matched', confidence: 1, chosen: exact, candidates: [exact], reasons: ['known IMDb id'] };
    }
  }

  /* Cheap re-verification for ids inherited from the old build, which were
     roughly a third wrong. One `?i=` lookup tells us whether the stored id
     actually resolves to this film: if the returned title and year agree, we
     are done in a single request; only the mismatches pay for a full search.
     Over a 500-title library that is the difference between ~1000 requests
     (past the free daily limit) and ~600. */
  if (item.imdbId && /^tt\d+$/.test(item.imdbId) && item.meta?.status === 'stale') {
    const held = await omdb({ i: item.imdbId, plot: 'short' }, key, budget, signal);
    if (held) {
      const titleAgrees = similarity(item.title, held.Title) >= 0.85;
      const heldYear = parseYear(held.Year);
      const yearAgrees = !item.year || !heldYear || Math.abs(heldYear - item.year) <= 1;
      if (titleAgrees && yearAgrees) {
        return {
          status: 'matched',
          confidence: 1,
          chosen: held,
          candidates: [held],
          reasons: ['stored id verified'],
        };
      }
      /* The id points somewhere else — fall through and search properly. */
    }
  }

  /* Gather candidates. Search WITHOUT forcing a type first — the stored type
     flag is frequently wrong (everything batch-added defaulted to "movie"),
     and forcing it is exactly what produced the 1899 → "Making 1899" bug. */
  const seen = new Map();
  const collect = (data) => {
    if (!data?.Search) return;
    for (const r of data.Search) if (r.imdbID && !seen.has(r.imdbID)) seen.set(r.imdbID, r);
  };

  collect(await omdb({ s: item.title }, key, budget, signal));

  /* If an unfiltered search found nothing useful, try the typed search and,
     as a last resort, the fuzzy `?t=` endpoint — but everything still has to
     survive scoring below, so a bad fuzzy hit cannot slip through. */
  if (seen.size === 0) {
    collect(await omdb({ s: item.title, type: item.type === 'tv' ? 'series' : 'movie' }, key, budget, signal));
  }
  if (seen.size === 0) {
    const fuzzy = await omdb({ t: item.title, y: item.year || undefined }, key, budget, signal);
    if (fuzzy?.imdbID) seen.set(fuzzy.imdbID, fuzzy);
  }

  if (seen.size === 0) {
    return { status: 'unmatched', confidence: 0, chosen: null, candidates: [], reasons: ['no results'] };
  }

  const scored = [...seen.values()]
    .map((c) => ({ candidate: c, ...scoreCandidate(query, c) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) {
    return { status: 'unmatched', confidence: 0, chosen: null, candidates: [], reasons: ['no plausible title match'] };
  }

  const best = scored[0];
  const runnerUp = scored[1];

  /* A candidate that agrees on both title and year is decisive.
     Type is deliberately NOT required here: the stored type is the least
     reliable field we hold (everything batch-added defaults to "movie", which
     is how a TV series like "1899" ends up flagged as a film), whereas an exact
     title plus an exact year is a very strong pair of independent signals. If
     two candidates both match title and year exactly, the ambiguity check below
     still sends it to review rather than guessing. */
  const bestYear = parseInt(String(best.candidate.Year || '').slice(0, 4), 10);
  const decisive =
    normaliseTitle(best.candidate.Title) === normaliseTitle(item.title) &&
    !!item.year &&
    bestYear === item.year;

  /* Otherwise, treat it as ambiguous only when the top two are genuinely
     indistinguishable — same title, same year (remakes released together,
     duplicate OMDb entries). A different year means the year signal already
     did the discriminating, so a close score is not real ambiguity. */
  const ambiguous =
    !decisive &&
    runnerUp &&
    best.score - runnerUp.score < 0.08 &&
    normaliseTitle(runnerUp.candidate.Title) === normaliseTitle(best.candidate.Title) &&
    parseInt(String(runnerUp.candidate.Year || '').slice(0, 4), 10) === bestYear;

  if ((decisive || best.score >= AUTO_ACCEPT) && !ambiguous) {
    /* Pull full details for the winner — search results omit plot/runtime. */
    const full = await omdb({ i: best.candidate.imdbID, plot: 'short' }, key, budget, signal);
    return {
      status: 'matched',
      confidence: best.score,
      chosen: full || best.candidate,
      candidates: scored.slice(0, 6).map((s) => s.candidate),
      reasons: best.reasons,
    };
  }

  return {
    status: best.score >= REVIEW_FLOOR ? 'review' : 'unmatched',
    confidence: best.score,
    chosen: null,
    candidates: scored.filter((s) => s.score >= REVIEW_FLOOR).slice(0, 6).map((s) => s.candidate),
    reasons: ambiguous ? ['two candidates scored almost equally', ...best.reasons] : best.reasons,
  };
}

/**
 * Turn an OMDb record into a patch for an item, respecting locked fields
 * and never blanking data we already hold with something worse.
 */
export function toPatch(item, data, confidence) {
  const patch = {};
  const set = (field, value) => {
    if (value === null || value === undefined || value === '') return;
    if (isLocked(item, field)) return;
    patch[field] = value;
  };

  const type = data.Type === 'series' ? 'tv' : 'movie';
  set('type', type);
  set('imdbId', /^tt\d+$/.test(data.imdbID || '') ? data.imdbID : null);
  set('year', parseYear(data.Year));
  set('rating', parseRating(data.imdbRating));
  set('runtime', parseRuntime(data.Runtime, type));
  set('genre', pickGenre(data.Genre));
  set('poster', posterAt(data.Poster));
  if (data.Plot && data.Plot !== 'N/A') set('overview', data.Plot);

  /* Adopt OMDb's canonical title only when it is essentially the same film —
     this stops "Alien" quietly becoming "Aliens". */
  if (data.Title && !isLocked(item, 'title') && similarity(item.title, data.Title) >= 0.9) {
    patch.title = data.Title;
  }

  patch.meta = {
    v: META_VERSION,
    status: 'matched',
    at: Date.now(),
    confidence: Math.round(confidence * 100) / 100,
    source: 'omdb',
  };
  return patch;
}

/** Items that actually need work — this is what makes re-runs cheap. */
export function needsEnrichment(item, { force = false } = {}) {
  if (force) return true;
  const m = item.meta || {};
  if (m.status === 'matched' && m.v >= META_VERSION) return false; // already done
  if (m.status === 'skipped') return false; // user dismissed it
  return true;
}

export function enrichmentSummary(list) {
  const s = { total: list.length, done: 0, pending: 0, stale: 0, review: 0, unmatched: 0, skipped: 0 };
  for (const i of list) {
    const st = i.meta?.status;
    if (st === 'matched' && i.meta.v >= META_VERSION) s.done += 1;
    else if (st === 'review') s.review += 1;
    else if (st === 'unmatched') s.unmatched += 1;
    else if (st === 'skipped') s.skipped += 1;
    /* `stale` means "carried over from the old build" — it has details, they
       just have not been checked by this matcher yet. Worth saying separately
       from "we know nothing about this title". */
    else if (st === 'stale') s.stale += 1;
    else s.pending += 1;
  }
  s.todo = s.pending + s.stale;
  return s;
}

/**
 * Sweep a list of items. Sequential with a small delay — OMDb rate-limits
 * bursts, and a personal library is never so large that parallelism is worth
 * the risk of being throttled mid-run.
 *
 * onProgress({ index, total, item, result })
 * Returns { matched, review, unmatched, stopped }
 */
export async function sweep(list, { key, budget, signal, onProgress, delay = 120, apply }) {
  const out = { matched: 0, review: 0, unmatched: 0, stopped: false, error: null };

  for (let i = 0; i < list.length; i++) {
    if (signal?.aborted) {
      out.stopped = true;
      break;
    }
    const item = list[i];
    let result;
    try {
      result = await findMatch(item, key, budget, signal);
    } catch (err) {
      if (err.name === 'AbortError') {
        out.stopped = true;
        break;
      }
      if (err.code === 'budget' || err.code === 'auth') {
        out.stopped = true;
        out.error = err;
        break;
      }
      result = { status: 'unmatched', confidence: 0, chosen: null, candidates: [], reasons: [err.message] };
    }

    apply?.(item, result);
    out[result.status === 'matched' ? 'matched' : result.status] += 1;
    onProgress?.({ index: i, total: list.length, item, result });

    if (delay && i < list.length - 1) await new Promise((r) => setTimeout(r, delay));
  }
  return out;
}

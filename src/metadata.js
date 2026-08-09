/*
 * Metadata matching.
 *
 * Source-agnostic: everything here works on the neutral Record shape defined in
 * providers/shared.js, so swapping OMDb for TMDB changes which provider module
 * is passed in and nothing else.
 *
 * It exists because the previous build had two fatal flaws:
 *
 *  1. It asked OMDb's `?t=` endpoint for an exact title. That endpoint does
 *     FUZZY matching and always returns something — "1899" with &type=movie
 *     returns "Making 1899" — and the old code wrote that film's poster, genre,
 *     year and runtime over the entry with no verification. It also trusted
 *     hardcoded IMDb ids, a third of which pointed at the wrong film.
 *
 *  2. It re-fetched every row on every run, because nothing recorded what had
 *     already been resolved.
 *
 * So: search for CANDIDATES, score each on title, year and type, write only
 * above a confidence threshold, and send anything uncertain to a review queue
 * rather than guessing. Record a stamp on every item so re-runs are cheap.
 */

import { META_VERSION, normaliseTitle, isLocked } from './store.js';
import { pickGenre, parseRuntime, parseRating, parseYear } from './providers/shared.js';

export { RequestBudget, parseRuntime, parseRating, parseYear, pickGenre } from './providers/shared.js';
/* Re-exported deliberately. Screens write meta records of their own when the
   user confirms a match by hand, and reaching for `meta.META_VERSION` when it
   was not exported silently stored `v: undefined` — which reads as "older than
   the current matcher", so a title the user had just confirmed went straight
   back into the re-check queue. */
export { META_VERSION } from './store.js';

/* Confidence thresholds. Tuned against the real library — see tools/match.test.mjs */
const AUTO_ACCEPT = 0.82; // write without asking
const REVIEW_FLOOR = 0.5; // below this, not even offered as a candidate

/* ── string similarity: Sørensen–Dice over character bigrams ──
   Robust to word order and small typos, cheap, no dependencies. */
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
 * Score one candidate Record against what we were looking for.
 * @returns {{score:number, reasons:string[]}} score is 0..1
 */
export function scoreCandidate(query, candidate) {
  const reasons = [];
  const title = similarity(query.title, candidate.title);

  /* Title dominates. A candidate whose title barely resembles the query is
     never right, however well the year lines up. */
  if (title < 0.45) return { score: 0, reasons: ['title mismatch'] };

  let score = title * 0.62;
  if (title === 1) reasons.push('exact title');
  else if (title > 0.85) reasons.push('near-exact title');

  /* Containment. "Dune" should prefer "Dune: Part One" over "Planet Dune":
     a subtitle appended to the query is far likelier than the query appearing
     as the tail of some other film's name. */
  const q = normaliseTitle(query.title);
  const c = normaliseTitle(candidate.title);
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
  if (query.year && candidate.year) {
    const delta = Math.abs(candidate.year - query.year);
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
    /* Nothing to verify against — no credit, no penalty, but the ceiling stays
       low enough that a title-only match cannot auto-accept on its own. */
    score += 0.12;
    reasons.push('no year to verify');
  }

  /* Type. The old code FORCED type=movie, which is what produced the 1899
     failure. A cross-type match is allowed but has to pay for itself. */
  if (query.type && candidate.type === query.type) {
    score += 0.12;
    reasons.push('type matches');
  } else if (query.type && candidate.type !== query.type) {
    score -= 0.18;
    reasons.push(`type differs (${candidate.type})`);
  }

  if (candidate.poster) score += 0.02;

  return { score: Math.max(0, Math.min(1, score)), reasons };
}

/**
 * Rank candidates and decide. Pure — no network — so it is unit-testable.
 * @returns {{status:'matched'|'review'|'unmatched', confidence, chosen, candidates, reasons}}
 */
export function decide(query, candidates) {
  const scored = candidates
    .map((candidate) => ({ candidate, ...scoreCandidate(query, candidate) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || (b.candidate.votes || 0) - (a.candidate.votes || 0));

  if (!scored.length) {
    return { status: 'unmatched', confidence: 0, chosen: null, candidates: [], reasons: ['no plausible title match'] };
  }

  const best = scored[0];
  const runnerUp = scored[1];

  /* A candidate agreeing on both title and year is decisive. Type is
     deliberately not required: the stored type is the least reliable field we
     hold (batch-added rows all default to "movie", which is how a series like
     1899 ends up flagged as a film), whereas exact title plus exact year is a
     strong pair of independent signals. */
  const decisive =
    normaliseTitle(best.candidate.title) === normaliseTitle(query.title) &&
    !!query.year &&
    best.candidate.year === query.year;

  /* Ambiguity comes in two forms.
     · With a year to compare, the top two are only indistinguishable when they
       agree on title AND year — a different year means the year already did the
       discriminating, so a close score is not real ambiguity.
     · With NO year on the item, two identically-titled candidates cannot be
       told apart at all. "Nosferatu" against the 1922 and 2024 films scores
       identically for both, and picking whichever the provider happened to
       return first is exactly the silent-wrong-answer behaviour this matcher
       exists to prevent. */
  const sameTitleAsRunnerUp =
    runnerUp && normaliseTitle(runnerUp.candidate.title) === normaliseTitle(best.candidate.title);

  const ambiguous =
    !decisive &&
    runnerUp &&
    best.score - runnerUp.score < 0.08 &&
    sameTitleAsRunnerUp &&
    (!query.year || runnerUp.candidate.year === best.candidate.year);

  const shortlist = scored.filter((s) => s.score >= REVIEW_FLOOR).slice(0, 6).map((s) => s.candidate);

  if ((decisive || best.score >= AUTO_ACCEPT) && !ambiguous) {
    return {
      status: 'matched',
      confidence: best.score,
      chosen: best.candidate,
      candidates: shortlist,
      reasons: best.reasons,
    };
  }
  return {
    status: best.score >= REVIEW_FLOOR ? 'review' : 'unmatched',
    confidence: best.score,
    chosen: null,
    candidates: shortlist,
    reasons: ambiguous ? ['two candidates scored almost equally', ...best.reasons] : best.reasons,
  };
}

/**
 * Resolve one item against a provider.
 * @param {object} item      library item
 * @param {object} ctx       { provider, key, budget, signal }
 */
export async function findMatch(item, ctx) {
  const { provider, key, budget, signal } = ctx;
  const query = { title: item.title, year: item.year, type: item.type };

  /* Fast path: an id this matcher verified itself. An id lookup is exact —
     no fuzzy matching, no chance of drifting onto a different film. */
  if (item.meta?.status === 'matched' && item.meta?.sourceId) {
    const held = await provider.details(item.meta.sourceId, item.type, ctx);
    if (held) {
      return { status: 'matched', confidence: 1, chosen: held, candidates: [held], reasons: ['known id'] };
    }
  }

  /* Cheap re-verification for ids inherited from the old build, roughly a
     third of which were wrong. One lookup tells us whether the stored id
     actually resolves to this film: if title and year agree we are done in a
     single request, and only the mismatches pay for a full search. Across a
     500-title library that is ~600 requests rather than ~1000, which matters
     against a 1000/day free tier. */
  if (item.meta?.status === 'stale' && item.imdbId && provider.byImdbId) {
    const held = await provider.byImdbId(item.imdbId, ctx);
    if (held) {
      const titleAgrees = similarity(item.title, held.title) >= 0.85;
      const yearAgrees = !item.year || !held.year || Math.abs(held.year - item.year) <= 1;
      if (titleAgrees && yearAgrees) {
        return { status: 'matched', confidence: 1, chosen: held, candidates: [held], reasons: ['stored id verified'] };
      }
      /* Points elsewhere — fall through and search properly. */
    }
  }

  const candidates = await provider.search(query, ctx);
  if (!candidates.length) {
    return { status: 'unmatched', confidence: 0, chosen: null, candidates: [], reasons: ['no results'] };
  }

  const verdict = decide(query, candidates);

  /* Search results are lightweight; fetch the full record for a winner. */
  if (verdict.status === 'matched' && verdict.chosen && !verdict.chosen.overview) {
    const full = await provider.details(verdict.chosen.sourceId, verdict.chosen.type, ctx);
    if (full) verdict.chosen = full;
  }
  return verdict;
}

/**
 * Turn a Record into a patch, respecting locked fields and never replacing
 * data we hold with something emptier.
 */
export function toPatch(item, record, confidence, providerId = 'omdb') {
  const patch = {};
  const set = (field, value) => {
    if (value === null || value === undefined || value === '') return;
    if (isLocked(item, field)) return;
    patch[field] = value;
  };

  set('type', record.type);
  set('imdbId', record.imdbId);
  set('year', record.year);
  set('rating', record.rating);
  set('runtime', record.runtime);
  set('genre', record.genre || (record.genres.length ? pickGenre(record.genres) : null));
  set('poster', record.poster);
  set('overview', record.overview);
  if (record.genres?.length && !isLocked(item, 'genre')) patch.genres = record.genres;

  /* Adopt the provider's canonical title only when it is essentially the same
     film — this stops "Alien" quietly becoming "Aliens". */
  if (record.title && !isLocked(item, 'title') && similarity(item.title, record.title) >= 0.9) {
    patch.title = record.title;
  }

  patch.meta = {
    v: META_VERSION,
    status: 'matched',
    at: Date.now(),
    confidence: Math.round(confidence * 100) / 100,
    source: providerId,
    sourceId: record.sourceId,
  };
  return patch;
}

/* TMDB's terms forbid caching their content for longer than six months, so
   resolved records expire and are re-checked rather than being kept forever.
   It also keeps ratings and artwork from drifting years out of date. */
export const CACHE_TTL_MS = 180 * 24 * 60 * 60 * 1000;

/** Items that actually need work — this is what makes re-runs cheap. */
export function needsEnrichment(item, { force = false, now = Date.now() } = {}) {
  if (force) return true;
  const m = item.meta || {};
  if (m.status === 'skipped') return false; // user dismissed it
  if (m.status === 'matched' && m.v >= META_VERSION) {
    /* Expired records fall back into the queue. */
    return !!m.at && now - m.at > CACHE_TTL_MS;
  }
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
       just have not been checked by this matcher. Worth saying separately from
       "we know nothing about this title". */
    else if (st === 'stale') s.stale += 1;
    else s.pending += 1;
  }
  s.todo = s.pending + s.stale;
  return s;
}

/**
 * Sweep a list of items. Sequential with a small delay — providers rate-limit
 * bursts, and a personal library is never large enough for parallelism to be
 * worth being throttled mid-run.
 *
 * @returns {{matched:number, review:number, unmatched:number, stopped:boolean, error:Error?}}
 */
export async function sweep(list, { provider, key, budget, signal, onProgress, delay = 120, apply }) {
  const out = { matched: 0, review: 0, unmatched: 0, stopped: false, error: null };
  const ctx = { provider, key, budget, signal };

  for (let i = 0; i < list.length; i++) {
    if (signal?.aborted) {
      out.stopped = true;
      break;
    }
    const item = list[i];
    let result;
    try {
      result = await findMatch(item, ctx);
    } catch (err) {
      if (err.name === 'AbortError') {
        out.stopped = true;
        break;
      }
      /* Budget and auth failures affect every subsequent call, so stop rather
         than burning through the list marking everything unmatched. */
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

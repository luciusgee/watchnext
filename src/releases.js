/*
 * When the films in Spotlight come out — in the UK, at the cinema and at
 * home — so the two of you can plan a trip to the pictures.
 *
 * Spotlight is mostly what you are waiting for: things starred from the
 * Feed's Coming soon. Each one's UK release dates are looked up from TMDB
 * (the key the Feed already uses) and kept on the film as
 * `release: { cinema, digital, at }`, which syncs, so both phones show the
 * same dates. Looked up again every few days: a UK date often appears, or
 * moves, only weeks before it happens.
 *
 * With them, its UK title where that is different — "Zootropolis 2" for
 * "Zootopia 2" — kept as `release.titles`, so the Savoy's listings (which
 * use the UK title) find it.
 */

import * as store from './store.js';
import { tmdbGet } from './providers/tmdb.js';
import { RequestBudget } from './providers/shared.js';

const FRESH_MS = 3 * 864e5;
const PER_RUN = 12;

/* The UK dates from TMDB's release_dates. UK only: a US date is usually
   earlier, and would say a film is out here when it is not. */
export function ukDates(results) {
  const gb = (results || []).find((r) => r.iso_3166_1 === 'GB')?.release_dates || [];
  const first = (...types) =>
    gb
      .filter((r) => types.includes(r.type) && r.release_date)
      .map((r) => r.release_date.slice(0, 10))
      .sort()[0] || null;
  return { cinema: first(3) || first(2), digital: first(4) };
}

/* Its other titles in the UK, from TMDB's alternative titles. */
export function ukTitles(results, title) {
  const own = String(title || '').trim().toLowerCase();
  const seen = new Set([own]);
  return (results || [])
    .filter((t) => t.iso_3166_1 === 'GB' && t.title)
    .map((t) => String(t.title).trim())
    .filter((t) => !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()))
    .slice(0, 3);
}

/* TMDB's id for a film: kept on it when it came from TMDB (the Feed, or a
   TMDB match); otherwise found from its IMDb id. */
async function tmdbIdFor(item, ctx) {
  const sid = String(item.meta?.sourceId || '');
  if (/^\d+$/.test(sid)) return sid;
  if (!item.imdbId) return null;
  const found = await tmdbGet(`/find/${item.imdbId}`, { external_source: 'imdb_id' }, ctx);
  return found?.movie_results?.[0]?.id || null;
}

let running = false;

/** Look up the films in Spotlight whose dates are missing or old. */
export async function refreshReleases({ force = false } = {}) {
  const key = store.settings().dataKeys?.tmdb;
  if (!key || running) return 0;
  const due = store
    .spotlit()
    .filter((i) => i.type !== 'tv' && (force || !i.release || Date.now() - (i.release.at || 0) > FRESH_MS))
    .slice(0, PER_RUN);
  if (!due.length) return 0;
  running = true;
  const ctx = { key, budget: new RequestBudget(20000, 'tmdb') };
  let changed = 0;
  try {
    for (const item of due) {
      try {
        const id = await tmdbIdFor(item, ctx);
        /* Nothing to look up by: say so, so it is not asked again for a few
           days. */
        const dates = id ? ukDates((await tmdbGet(`/movie/${id}/release_dates`, {}, ctx))?.results) : { cinema: null, digital: null };
        let titles = [];
        if (id) {
          try {
            titles = ukTitles((await tmdbGet(`/movie/${id}/alternative_titles`, { country: 'GB' }, ctx))?.titles, item.title);
          } catch {
            /* the dates are what matter */
          }
        }
        store.update(item.uid, { release: { ...dates, ...(titles.length ? { titles } : {}), at: Date.now() } });
        changed += 1;
      } catch {
        /* offline, or TMDB said no: next time */
      }
    }
  } finally {
    running = false;
  }
  if (changed) {
    store.saveNow();
    store.emit('item');
  }
  return changed;
}

let timer = null;
/** Soon, and once: after starting up, or after Spotlight changes. */
export function refreshReleasesSoon(ms = 2500) {
  clearTimeout(timer);
  timer = setTimeout(() => refreshReleases().catch(() => {}), ms);
}

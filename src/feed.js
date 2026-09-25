/*
 * The feed: an endless run of films to scroll, one at a time.
 *
 * Made for the moment you would otherwise open Instagram. Every card is a
 * film you do not already have, with enough on it to decide — poster, year,
 * running time, rating, genres, tagline, synopsis, who made it and who is in
 * it — and the scroll stops on each one.
 *
 * All from TMDB. Lists (trending, popular, a genre) give the card its basics
 * in one request per twenty films; the details — running time, credits,
 * certificate, trailer — are fetched for the card on screen and the next
 * couple, never for the whole list.
 *
 * "For you" leans on what this shelf already holds and on what gets starred
 * or added here, and drifts away from what gets flicked past.
 */

import * as store from './store.js';
import { tmdbGet, toRecord, posterUrl } from './providers/tmdb.js';
import { RequestBudget } from './providers/shared.js';

export const FILTERS = [
  { id: 'foryou', label: 'For you' },
  { id: 'trending', label: 'Trending' },
  { id: 'new', label: 'New' },
  { id: 'horror', label: 'Horror', genre: 27 },
  { id: 'thriller', label: 'Thriller', genre: 53 },
  { id: 'comedy', label: 'Comedy', genre: 35 },
  { id: 'scifi', label: 'Sci-fi', genre: 878 },
  { id: 'drama', label: 'Drama', genre: 18 },
  { id: 'action', label: 'Action', genre: 28 },
  { id: 'crime', label: 'Crime', genre: 80 },
  { id: 'mystery', label: 'Mystery', genre: 9648 },
  { id: 'animation', label: 'Animation', genre: 16 },
  { id: 'romance', label: 'Romance', genre: 10749 },
  { id: 'documentary', label: 'Documentary', genre: 99 },
  { id: 'gems', label: 'Hidden gems' },
  { id: 'classics', label: 'Classics' },
  { id: 'series', label: 'Series' },
];

/* TMDB's genre ids. Lists carry ids only, and one fixed table saves a request
   per session for a list that has not changed in years. Series have their
   own ids for some. */
const GENRES = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime', 99: 'Documentary',
  18: 'Drama', 10751: 'Family', 14: 'Fantasy', 36: 'History', 27: 'Horror', 10402: 'Music',
  9648: 'Mystery', 10749: 'Romance', 878: 'Sci-Fi', 10770: 'TV Movie', 53: 'Thriller', 10752: 'War',
  37: 'Western', 10759: 'Action & Adventure', 10762: 'Kids', 10763: 'News', 10764: 'Reality',
  10765: 'Sci-Fi & Fantasy', 10766: 'Soap', 10767: 'Talk', 10768: 'War & Politics',
};

/* The shelf's genre names, however they were spelt when they were looked
   up, onto the ids "For you" can ask TMDB for. */
const GENRE_IDS = {
  action: 28, adventure: 12, animation: 16, comedy: 35, crime: 80, documentary: 99, drama: 18,
  family: 10751, fantasy: 14, history: 36, horror: 27, music: 10402, musical: 10402, mystery: 9648,
  romance: 10749, 'sci-fi': 878, 'science fiction': 878, thriller: 53, war: 10752, western: 37,
};

const SEEN_KEY = 'wn.feed.seen';
const TASTE_KEY = 'wn.feed.taste';
const SEEN_MAX = 4000;

/* Per phone, and never synced: what this phone has already been shown, and
   how its scrolling has leant. Storage can throw (private mode, cleared site
   data), and the feed must work without it. */
function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* the feed still works; it just forgets */
  }
}

let seen = null;
function seenSet() {
  if (!seen) seen = new Set(readJson(SEEN_KEY, []));
  return seen;
}
/** This card has been on screen. */
export function markSeen(film) {
  const s = seenSet();
  if (s.has(film.key)) return;
  s.add(film.key);
  if (s.size > SEEN_MAX) {
    const trimmed = [...s].slice(-SEEN_MAX);
    seen = new Set(trimmed);
  }
  writeJson(SEEN_KEY, [...seenSet()]);
}

/* ── taste ──
   A score per genre id. The shelf supplies the starting point; the feed
   nudges it: starred or added pushes a film's genres up, a quick flick past
   nudges them down, and lingering nudges them up a little. */
export function nudge(film, amount) {
  const t = readJson(TASTE_KEY, {});
  for (const g of film.genreIds || []) t[g] = Math.max(-6, Math.min(12, (t[g] || 0) + amount));
  writeJson(TASTE_KEY, t);
}

function genreWeights() {
  const w = {};
  for (const item of store.items()) {
    const names = item.genres?.length ? item.genres : item.genre ? [item.genre] : [];
    const worth = item.spotlight ? 3 : item.owned && !item.watched ? 2 : 1;
    for (const n of names) {
      const id = GENRE_IDS[String(n).toLowerCase()];
      if (id) w[id] = (w[id] || 0) + worth;
    }
  }
  /* The shelf is hundreds of titles and the feed's nudges are single steps,
     so the shelf is scaled to a comparable range before they are added. */
  const top = Math.max(1, ...Object.values(w));
  for (const id of Object.keys(w)) w[id] = (w[id] / top) * 8;
  for (const [id, v] of Object.entries(readJson(TASTE_KEY, {}))) w[id] = (w[id] || 0) + v;
  const muted = new Set((store.tastePrefs?.().genres || []).map((n) => GENRE_IDS[String(n).toLowerCase()]));
  for (const id of muted) delete w[id];
  return w;
}

/** The genres "For you" leans towards, strongest first. */
export function favouriteGenres(n = 4) {
  return Object.entries(genreWeights())
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([id]) => Number(id));
}

/* ── lists ── */

function lite(r, typeHint) {
  if (!r || !r.id) return null;
  const type = r.media_type === 'tv' || typeHint === 'tv' ? 'tv' : 'movie';
  if (r.media_type && r.media_type !== 'tv' && r.media_type !== 'movie') return null;
  const date = r.release_date || r.first_air_date || '';
  return {
    key: `${type}:${r.id}`,
    id: r.id,
    type,
    title: r.title || r.name || '',
    year: date ? Number(date.slice(0, 4)) || null : null,
    overview: r.overview || '',
    poster: posterUrl(r.poster_path, 'w780'),
    thumb: posterUrl(r.poster_path, 'w342'),
    backdrop: posterUrl(r.backdrop_path, 'w1280'),
    rating: Number.isFinite(r.vote_average) && r.vote_count > 20 ? Math.round(r.vote_average * 10) / 10 : null,
    votes: r.vote_count || 0,
    genreIds: Array.isArray(r.genre_ids) ? r.genre_ids : [],
    genres: (r.genre_ids || []).map((g) => GENRES[g]).filter(Boolean),
  };
}

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

/* What to ask TMDB for, per filter. Each is a function of the page number
   so a feed can keep going for as long as there are pages. */
function sourceFor(filter, page, pick) {
  const base = { include_adult: false, page };
  switch (filter.id) {
    case 'trending':
      return ['/trending/movie/week', base];
    case 'series':
      return ['/trending/tv/week', base, 'tv'];
    case 'new':
      return ['/discover/movie', { ...base, sort_by: 'popularity.desc', 'primary_release_date.gte': daysAgo(150), 'primary_release_date.lte': today(), 'vote_count.gte': 40 }];
    case 'gems':
      return ['/discover/movie', { ...base, sort_by: 'vote_average.desc', 'vote_average.gte': 7.2, 'vote_count.gte': 150, 'vote_count.lte': 2500 }];
    case 'classics':
      return ['/discover/movie', { ...base, sort_by: 'vote_average.desc', 'primary_release_date.lte': '1989-12-31', 'vote_count.gte': 1200 }];
    case 'foryou':
      return pick(page);
    default:
      if (filter.genre) {
        return ['/discover/movie', { ...base, with_genres: filter.genre, sort_by: 'popularity.desc', 'vote_count.gte': 150 }];
      }
      return ['/movie/popular', base];
  }
}

/**
 * One feed. Keeps its own place in each list it draws from, and never
 * shows a film twice, one already on the shelf, or one this phone has been
 * shown before.
 */
export function createFeed(filterId, { key, signal } = {}) {
  const filter = FILTERS.find((f) => f.id === filterId) || FILTERS[0];
  const ctx = { key, signal, budget: new RequestBudget(20000, 'tmdb') };
  const shown = new Set();
  let n = 0; // how many lists this feed has asked for
  let dry = 0; // lists in a row that added nothing
  const pages = {}; // per list, the next page to ask for

  /* "For you" takes turns: a favourite genre, what is trending, the next
     favourite, something like a film you starred, and so on — so it is never
     only the one genre, and never only the charts. */
  const favourites = filter.id === 'foryou' ? favouriteGenres(4) : [];
  const seeds = store
    .items()
    .filter((i) => i.spotlight && /^\d+$/.test(String(i.meta?.sourceId || '')))
    .slice(0, 6);
  const pick = () => {
    const slot = n % 6;
    const base = { include_adult: false };
    const genre = favourites.length ? favourites[Math.floor(n / 2) % favourites.length] : null;
    if ((slot === 0 || slot === 2 || slot === 4) && genre) {
      return ['/discover/movie', { ...base, with_genres: genre, sort_by: 'popularity.desc', 'vote_count.gte': 200 }, null, `g${genre}`];
    }
    if (slot === 3 && seeds.length) {
      const seed = seeds[Math.floor(n / 6) % seeds.length];
      return [`/${seed.type === 'tv' ? 'tv' : 'movie'}/${seed.meta.sourceId}/recommendations`, base, seed.type === 'tv' ? 'tv' : null, `r${seed.uid}`];
    }
    if (slot === 5) return ['/movie/top_rated', base, null, 'top'];
    return ['/trending/movie/week', base, null, 'trend'];
  };

  const inLibrary = (f) =>
    store.items().some((i) => String(i.meta?.sourceId || '') === String(f.id) && i.type === f.type) ||
    !!store.findDuplicate(f.title, f.year, f.type);

  /** The next batch of films, or [] when TMDB has run out. */
  async function more() {
    for (let tries = 0; tries < 6; tries++) {
      const [path, params, typeHint, slot] = sourceFor(filter, 0, pick);
      const list = slot || path;
      const page = pages[list] || 1;
      if (page > 40) {
        n += 1;
        continue;
      }
      pages[list] = page + 1;
      n += 1;
      const data = await tmdbGet(path, { ...params, page }, ctx);
      const films = (data?.results || [])
        .map((r) => lite(r, typeHint))
        .filter((f) => f && f.poster && f.title && !shown.has(f.key) && !seenSet().has(f.key) && !inLibrary(f));
      films.forEach((f) => shown.add(f.key));
      if (films.length) {
        dry = 0;
        return films;
      }
      dry += 1;
      if (dry > 8) return [];
    }
    return [];
  }

  return { filter, more };
}

/* ── the rest of a card ── */

const details = new Map();

function certificate(d, type) {
  const pickFrom = (rows, field) => {
    for (const country of ['GB', 'US']) {
      const row = rows?.find((r) => r.iso_3166_1 === country);
      const value = field(row);
      if (value) return value;
    }
    return null;
  };
  if (type === 'tv') return pickFrom(d.content_ratings?.results, (r) => r?.rating || null);
  return pickFrom(d.release_dates?.results, (r) => r?.release_dates?.find((x) => x.certification)?.certification || null);
}

/**
 * Running time, credits, certificate and trailer for one film. One request,
 * cached for the session.
 */
export async function detailsFor(film, { key, signal } = {}) {
  if (details.has(film.key)) return details.get(film.key);
  const ctx = { key, signal, budget: new RequestBudget(20000, 'tmdb') };
  const tv = film.type === 'tv';
  const d = await tmdbGet(
    `/${tv ? 'tv' : 'movie'}/${film.id}`,
    { append_to_response: tv ? 'aggregate_credits,external_ids,content_ratings,videos' : 'credits,external_ids,release_dates,videos' },
    ctx
  );
  if (!d) return null;
  const credits = tv ? d.aggregate_credits : d.credits;
  const makers = tv
    ? (d.created_by || []).map((p) => p.name)
    : (credits?.crew || []).filter((p) => p.job === 'Director').map((p) => p.name);
  const video = (d.videos?.results || []).find((v) => v.site === 'YouTube' && v.type === 'Trailer') ||
    (d.videos?.results || []).find((v) => v.site === 'YouTube');
  const out = {
    record: toRecord(d, film.type),
    tagline: d.tagline || '',
    runtime: tv ? (d.episode_run_time || [])[0] || null : d.runtime || null,
    seasons: tv ? d.number_of_seasons || null : null,
    genres: (d.genres || []).map((g) => GENRES[g.id] || g.name),
    makers: [...new Set(makers)].slice(0, 2),
    cast: (credits?.cast || []).slice(0, 4).map((p) => p.name),
    certificate: certificate(d, film.type),
    imdbId: d.imdb_id || d.external_ids?.imdb_id || null,
    trailer: video ? `https://www.youtube.com/watch?v=${video.key}` : null,
  };
  details.set(film.key, out);
  return out;
}

/** Already fetched? For painting a card without waiting. */
export function cached(film) {
  return details.get(film.key) || null;
}

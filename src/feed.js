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
import { ymd, shiftDays } from './format.js';

export const FILTERS = [
  { id: 'foryou', label: 'For you' },
  { id: 'trending', label: 'Trending' },
  { id: 'new', label: 'New' },
  { id: 'soon', label: 'Coming soon' },
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

/* Film genre ids — the only ones /discover/movie understands. A series
   carries TV ids for some genres (10759 "Action & Adventure", 10765 "Sci-Fi &
   Fantasy"); starring one would otherwise teach "For you" a genre it then
   asks the film list for and gets nothing back. They are translated here. */
const FILM_GENRES = new Set([28, 12, 16, 35, 80, 99, 18, 10751, 14, 36, 27, 10402, 9648, 10749, 878, 53, 10752, 37]);
const TV_TO_FILM = { 10759: [28, 12], 10765: [878, 14], 10768: [10752], 10762: [10751] };
function filmGenres(ids) {
  return [...new Set((ids || []).flatMap((g) => TV_TO_FILM[g] || (FILM_GENRES.has(g) ? [g] : [])))];
}

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
/* A film seen before it was out is seen as "coming": it comes back, once,
   when it is — so the trailer you scrolled past in August turns up again,
   marked New, the week it can actually be watched. */
const seenKey = (film) => film.key + (film.date && film.date.slice(0, 10) > ymd() ? ':soon' : '');

/** This card has been on screen. */
export function markSeen(film) {
  const s = seenSet();
  const key = seenKey(film);
  if (s.has(key)) return;
  s.add(key);
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
  for (const g of filmGenres(film.genreIds)) t[g] = Math.max(-6, Math.min(12, (t[g] || 0) + amount));
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
    .filter(([id, v]) => v > 0 && FILM_GENRES.has(Number(id)))
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
    /* The list's date: with region=GB the UK one, otherwise the worldwide
       premiere. Details may bring a better one (release, below). */
    date: date || null,
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

/* New and coming, in the UK. TMDB's `region` + `release_date` read the UK
   release dates — cinema (2 limited, 3 wide) and digital (4) — rather than
   the one worldwide premiere, which is often a festival a year earlier. The
   primary_release_date floor keeps out re-releases of old films. No vote
   floor: a film out this week has hardly any votes yet. */
const UK = { region: 'GB', include_video: false, sort_by: 'popularity.desc' };
export function newParams({ from = -60, to = 0, types = '3|2|4' } = {}) {
  return {
    ...UK,
    with_release_type: types,
    'release_date.gte': shiftDays(from),
    'release_date.lte': shiftDays(to),
    'primary_release_date.gte': shiftDays(-730),
  };
}

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
      return ['/discover/movie', { ...base, ...newParams({ from: -60, to: 0 }) }];
    case 'soon':
      return ['/discover/movie', { ...base, ...newParams({ from: 1, to: 120, types: '3|2' }) }];
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
  const pages = {}; // per list, the next page to ask for
  const done = new Set(); // lists TMDB has no more pages of

  /* "For you" takes turns: what is new or about to be out in the genres
     you like, what is trending, a favourite genre, something like a film you
     starred, and so on — so it is never only the one genre, never only the
     charts, and the first thing it deals is what is new. */
  const favourites = filter.id === 'foryou' ? favouriteGenres(4) : [];
  const seeds = store
    .items()
    .filter((i) => i.spotlight && /^\d+$/.test(String(i.meta?.sourceId || '')))
    .slice(0, 6);
  const pick = () => {
    const slot = n % 6;
    const base = { include_adult: false };
    const genre = favourites.length ? favourites[Math.floor(n / 2) % favourites.length] : null;
    if (slot === 0) {
      /* Out in the last two months or the next two, in the three genres this
         shelf leans to most (any of them). */
      const liked = favourites.slice(0, 3).join('|');
      return ['/discover/movie', { ...base, ...newParams({ from: -60, to: 60 }), ...(liked ? { with_genres: liked } : {}) }, null, 'fresh'];
    }
    if ((slot === 2 || slot === 4) && genre) {
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

  /**
   * The next batch of films, or [] when TMDB has run out.
   *
   * A page can come back with nothing new on it — every film already seen on
   * this phone, or already on the shelf — and that is not the end: the next
   * page may be full. So it keeps going, page after page, until a list really
   * has no more (TMDB's last page, or an empty one), and gives up only after
   * MAX_ASKS requests in one go turned up nothing at all.
   */
  const MAX_ASKS = 30;
  async function more() {
    let asked = 0;
    let skipped = 0;
    while (asked < MAX_ASKS) {
      const [path, params, typeHint, slot] = sourceFor(filter, 0, pick);
      const list = slot || path;
      n += 1;
      if (done.has(list)) {
        /* Every list this feed draws from has run out. */
        if (++skipped > 12) return [];
        continue;
      }
      skipped = 0;
      const page = pages[list] || 1;
      pages[list] = page + 1;
      asked += 1;
      const data = await tmdbGet(path, { ...params, page }, ctx);
      const results = data?.results || [];
      const last = Number(data?.total_pages) || 0;
      if (!results.length || (last && page >= Math.min(last, 500))) done.add(list);
      const films = results
        .map((r) => lite(r, typeHint))
        .filter((f) => f && f.poster && f.title && !shown.has(f.key) && !seenSet().has(seenKey(f)) && !inLibrary(f));
      films.forEach((f) => shown.add(f.key));
      /* Coming soon asks for UK cinema dates only, so the date each row
         carries is one: "In cinemas Fri 14 Nov" before the details say so. */
      if (filter.id === 'soon') films.forEach((f) => (f.dateKind = 'cinema'));
      if (films.length) return films;
    }
    return [];
  }

  return { filter, more };
}

/* ── the rest of a card ── */

const details = new Map();

/** Forget the details fetched so far — on a refresh, so a certificate, a
    trailer or a release date is not days old. */
export function forgetDetails() {
  details.clear();
}

/* The UK release dates, from the release_dates the details already carry.
   UK only: a US date is usually earlier, and would say a film is out here
   when it is not. */
function ukRelease(d) {
  const gb = d.release_dates?.results?.find((r) => r.iso_3166_1 === 'GB')?.release_dates || [];
  const first = (...types) =>
    gb
      .filter((r) => types.includes(r.type) && r.release_date)
      .map((r) => r.release_date.slice(0, 10))
      .sort()[0] || null;
  return { cinema: first(3) || first(2), digital: first(4) };
}

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
    release: tv ? null : ukRelease(d),
  };
  details.set(film.key, out);
  return out;
}

/** Already fetched? For painting a card without waiting. */
export function cached(film) {
  return details.get(film.key) || null;
}

/*
 * TMDB provider.
 *
 * Preferred over OMDb for anything that might ship: OMDb's terms are
 * personal/non-commercial and its `Poster` field hotlinks IMDb's CDN rather
 * than artwork it licenses. TMDB hosts its own images, permits commercial use
 * under a licence, and its data is materially better maintained.
 *
 * API shapes verified against developer.themoviedb.org:
 *   /search/multi      results carry a `media_type` discriminator; movie rows
 *                      use title/release_date, tv rows use name/first_air_date
 *   /movie/{id}        runtime:int, genres:[{id,name}], imdb_id:string
 *   /tv/{id}           episode_run_time:int[], genres:[{id,name}], NO imdb_id
 *                      (needs append_to_response=external_ids)
 *   /find/{imdb_id}    external_source=imdb_id -> {movie_results, tv_results}
 *   images             https://image.tmdb.org/t/p/{size}{poster_path}
 */

import {
  emptyRecord,
  parseRuntime,
  parseRating,
  parseYear,
  normaliseGenres,
  pickGenre,
  requestJson,
} from './shared.js';

const BASE = 'https://api.themoviedb.org/3';
const IMAGE_BASE = 'https://image.tmdb.org/t/p/';
const POSTER_SIZE = 'w500';

/* TMDB accepts either a v3 API key as a query parameter or a v4 read access
   token as a bearer header. Users copy whichever their account page shows, so
   accept both and work out which is which: v3 keys are 32 hex characters,
   v4 tokens are long JWTs with dots. */
function isBearerToken(key) {
  return typeof key === 'string' && (key.length > 60 || key.split('.').length === 3);
}

function endpoint(path, params, key) {
  const u = new URL(BASE + path);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v);
  }
  if (!isBearerToken(key)) u.searchParams.set('api_key', key);
  return u;
}

function headersFor(key) {
  return isBearerToken(key)
    ? { Authorization: `Bearer ${key}`, accept: 'application/json' }
    : { accept: 'application/json' };
}

function call(path, params, { key, budget, signal }) {
  return requestJson(endpoint(path, params, key), {
    budget,
    signal,
    headers: headersFor(key),
    providerName: 'TMDB',
  });
}

export function posterUrl(path, size = POSTER_SIZE) {
  if (!path) return null;
  return `${IMAGE_BASE}${size}${path.startsWith('/') ? path : '/' + path}`;
}

/**
 * Map a search result or a details payload onto the neutral Record shape.
 * Handles both the movie and tv field spellings.
 */
function toRecord(d, typeHint) {
  if (!d) return null;

  const type =
    d.media_type === 'tv' || d.media_type === 'movie'
      ? d.media_type === 'tv'
        ? 'tv'
        : 'movie'
      : typeHint || (d.first_air_date !== undefined || d.name !== undefined ? 'tv' : 'movie');

  const title = d.title || d.name || d.original_title || d.original_name || '';
  const date = d.release_date || d.first_air_date || null;

  /* Movies carry `runtime` as a scalar; series carry `episode_run_time` as an
     array of per-episode lengths. That array is empty for shows with irregular
     runtimes, so it cannot be indexed blindly. */
  const rawRuntime = Array.isArray(d.episode_run_time)
    ? (d.episode_run_time.length ? d.episode_run_time[0] : null)
    : d.runtime ?? null;

  /* Details give genre objects; search results give bare ids we cannot resolve
     without the genre list, so genres stay empty until details are fetched. */
  const genres = Array.isArray(d.genres) ? normaliseGenres(d.genres) : [];

  const imdbId =
    d.imdb_id || d.external_ids?.imdb_id || null;

  return emptyRecord({
    sourceId: String(d.id),
    imdbId: /^tt\d+$/.test(imdbId || '') ? imdbId : null,
    title,
    year: parseYear(date),
    type,
    genres,
    genre: genres.length ? pickGenre(genres) : null,
    runtime: parseRuntime(rawRuntime, type),
    rating: parseRating(d.vote_average),
    votes: Number.isFinite(d.vote_count) ? d.vote_count : null,
    overview: d.overview || '',
    poster: posterUrl(d.poster_path),
  });
}

export const tmdb = {
  id: 'tmdb',
  label: 'TMDB',
  keyLabel: 'TMDB API key or read access token',
  keyHint: 'Free at themoviedb.org — Settings → API. Either the v3 key or the v4 token works.',
  keyPlaceholder: 'API key or eyJhbGciOi…',
  /* TMDB removed its published hard daily cap; keep a generous ceiling purely
     as a runaway guard rather than as a quota. */
  dailyLimit: 20000,
  /* §3 of TMDB's API terms specifies this wording verbatim, and requires it to
     sit in an "About" or "Credits" section — hence Settings → About. The terms
     also require their logo alongside it, less prominent than our own marks,
     unmodified in colour/aspect/rotation. See README before shipping. */
  attribution: {
    text: 'This product uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB.',
    url: 'https://www.themoviedb.org/',
    logoRequired: true,
  },
  commercialUse: 'licence-required',
  /* §1.C: "Cache, for longer than 6 months, any information obtained through or
     from TMDB or the TMDB APIs." Enforced via CACHE_TTL_MS in metadata.js. */
  maxCacheDays: 180,

  /**
   * One multi-search covers films and series together, so a title stored with
   * the wrong type still finds the right record. Costs 1 request.
   */
  async search(query, ctx) {
    const multi = await call('/search/multi', { query: query.title, include_adult: false }, ctx);
    let rows = (multi?.results || []).filter((r) => r.media_type === 'movie' || r.media_type === 'tv');

    /* Multi-search occasionally misses when a title collides with a person's
       name. Fall back to the typed endpoints, which also accept a year. */
    if (!rows.length) {
      const [movies, shows] = await Promise.all([
        call('/search/movie', { query: query.title, primary_release_year: query.year || undefined }, ctx),
        call('/search/tv', { query: query.title, first_air_date_year: query.year || undefined }, ctx),
      ]);
      rows = [
        ...(movies?.results || []).map((r) => ({ ...r, media_type: 'movie' })),
        ...(shows?.results || []).map((r) => ({ ...r, media_type: 'tv' })),
      ];
    }
    return rows.map((r) => toRecord(r)).filter(Boolean);
  },

  /**
   * Full record. `external_ids` is appended so series get an IMDb id too —
   * /tv/{id} does not include one on its own. Costs 1 request.
   */
  async details(sourceId, type, ctx) {
    const path = type === 'tv' ? `/tv/${sourceId}` : `/movie/${sourceId}`;
    const data = await call(path, { append_to_response: 'external_ids' }, ctx);
    return toRecord(data, type);
  },

  /** Verify a stored IMDb id without a text search. Costs 1 request. */
  async byImdbId(imdbId, ctx) {
    const found = await call(`/find/${encodeURIComponent(imdbId)}`, { external_source: 'imdb_id' }, ctx);
    const movie = found?.movie_results?.[0];
    const show = found?.tv_results?.[0];
    if (!movie && !show) return null;
    const hit = movie || show;
    /* /find returns the lightweight shape, so fetch the full record to get
       runtime and genres — the point of this call is verification, and a
       half-populated record would look like data loss. */
    return this.details(String(hit.id), movie ? 'movie' : 'tv', ctx);
  },
};

export default tmdb;

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
  keyHint: 'Free from themoviedb.org → Settings → API. Either the short key or the long token works.',
  keyPlaceholder: 'Paste your TMDB key',
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
   * A search somebody typed, where the type came off a button and a year — if
   * there is one — came off a keyboard.
   *
   * This exists because /search/multi is the wrong endpoint for it. Multi is
   * one page of TMDB's cross-entity relevance, and for a franchise that page
   * fills with fan films, commercials and behind-the-scenes featurettes.
   * Checked against TMDB on 2026-09-23: "Resident Evil" on /search/movie
   * returns the 2026 film FIRST, while twenty rows of /search/multi do not
   * contain it anywhere. No amount of re-sorting the app's end fixes that —
   * the film was never in the reply.
   *
   * So a deliberate search asks the typed endpoint, which knows what a film is
   * and accepts a year, and only falls back to multi when that comes back
   * empty. Usually one request, same as before; two when the typed endpoint
   * has nothing and a cross-type answer is better than none.
   *
   * Kept separate from search() rather than folded into it with a flag,
   * because the matcher must keep using multi: a stored type is the least
   * reliable field the app holds, and narrowing the matcher on it is what
   * produced the 1899 failure.
   */
  async searchPrecise(query, ctx) {
    const tv = query.type === 'tv';
    const path = tv ? '/search/tv' : '/search/movie';
    const params = tv
      ? { query: query.title, first_air_date_year: query.year || undefined }
      : { query: query.title, primary_release_year: query.year || undefined };

    const typed = await call(path, params, ctx);
    const rows = (typed?.results || []).map((r) => ({ ...r, media_type: tv ? 'tv' : 'movie' }));
    if (rows.length) return rows.map((r) => toRecord(r)).filter(Boolean);

    /* Nothing of that type under that name. Ask the broad endpoint rather than
       report an empty result — the screen can say it relaxed the filter. */
    return this.search({ ...query, precise: false }, ctx);
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

  /**
   * Is this key usable right now? /configuration is TMDB's cheapest authorised
   * endpoint and returns 401 for a bad key or a v4 token pasted where a v3 key
   * belongs, which is the mistake people actually make.
   */
  async verifyKey(key, { signal } = {}) {
    try {
      await call('/configuration', {}, { key, signal });
      return { ok: true };
    } catch (err) {
      if (err.code === 'network') return { ok: null, message: 'Could not reach TMDB. Check your connection.' };
      /* Only a rejection means a bad key. A 503 or an HTML error page used to
         be saved as the key's verdict and shown in red on every later visit. */
      if (err.code !== 'auth') {
        return { ok: null, message: 'TMDB didn’t answer properly just now. Your key is saved — try again in a minute.' };
      }
      return { ok: false, message: err.message };
    }
  },
};

export default tmdb;

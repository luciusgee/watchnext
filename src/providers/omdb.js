/*
 * OMDb provider.
 *
 * Note for anyone extending this: OMDb's `?t=` endpoint is deliberately NOT
 * used as a matching primitive. It does fuzzy title matching and always returns
 * something — asking for "1899" with &type=movie returns "Making 1899" — which
 * is exactly how the previous build put the wrong poster on a third of the
 * library. `search()` uses `?s=`, and every result is scored by the matcher
 * before anything is written.
 *
 * OMDb's terms are personal/non-commercial. Fine for a private build; see
 * README before charging for anything.
 */

import {
  emptyRecord,
  parseRuntime,
  parseRating,
  parseYear,
  normaliseGenres,
  pickGenre,
  requestJson,
  providerError,
} from './shared.js';

const BASE = 'https://www.omdbapi.com/';

function url(params, key) {
  const u = new URL(BASE);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v);
  }
  u.searchParams.set('apikey', key);
  return u;
}

/** OMDb reports both "no results" and "bad key" as Response:"False". */
function unwrap(data) {
  if (!data) return null;
  if (data.Response === 'False') {
    if (/invalid api key|no api key/i.test(data.Error || '')) {
      /* OMDb returns this identical error for a made-up key and for a real key
         that has never been activated — they email the key and a separate
         activation link, and the key does nothing until that link is clicked.
         Saying only "rejected" sends people off to request another key, which
         then fails with "a key has already been assigned to that email". */
      throw providerError(
        'OMDb rejected that key. If it is new, click the activation link in the email OMDb sent you — keys do nothing until you do.',
        'auth'
      );
    }
    if (/request limit reached/i.test(data.Error || '')) {
      throw providerError('This OMDb key has hit its daily limit.', 'budget');
    }
    return null;
  }
  return data;
}

/** Their CDN honours an SX<width> segment; the default is a small render. */
export function posterUrl(raw, width = 600) {
  if (!raw || raw === 'N/A') return null;
  return raw.replace(/\._V1_.*?\.jpg$/i, `._V1_SX${width}.jpg`);
}

function toRecord(d, { full = false } = {}) {
  if (!d) return null;
  const type = d.Type === 'series' ? 'tv' : 'movie';
  const genres = full ? normaliseGenres(d.Genre) : [];
  return emptyRecord({
    sourceId: d.imdbID,
    imdbId: /^tt\d+$/.test(d.imdbID || '') ? d.imdbID : null,
    title: d.Title || '',
    year: parseYear(d.Year),
    type,
    genres,
    genre: genres.length ? pickGenre(genres) : null,
    runtime: full ? parseRuntime(d.Runtime, type) : null,
    rating: full ? parseRating(d.imdbRating) : null,
    votes: full ? parseInt(String(d.imdbVotes || '').replace(/[^\d]/g, ''), 10) || null : null,
    overview: full && d.Plot && d.Plot !== 'N/A' ? d.Plot : '',
    poster: posterUrl(d.Poster),
  });
}

export const omdb = {
  id: 'omdb',
  label: 'OMDb',
  keyLabel: 'OMDb API key',
  keyHint: 'Free at omdbapi.com — takes a minute and is yours alone.',
  keyPlaceholder: 'e.g. 1a2b3c4d',
  dailyLimit: 950, // free tier is 1000; leave headroom
  /* OMDb hotlinks IMDb's media CDN rather than hosting artwork itself. */
  attribution: { text: 'Film data from OMDb', url: 'https://www.omdbapi.com/' },
  commercialUse: false,

  /**
   * Candidate search. Returns lightweight records — title/year/type/poster —
   * which is all the matcher needs to score. Costs 1 request.
   */
  async search(query, { key, budget, signal }) {
    const attempt = async (params) => {
      const data = unwrap(await requestJson(url(params, key), { budget, signal, providerName: 'OMDb' }));
      return data?.Search ? data.Search.map((r) => toRecord(r)) : [];
    };

    /* Search untyped first. The stored type is the least reliable field we
       hold — everything batch-added defaults to "movie" — and constraining on
       it is what produced the 1899 failure. */
    let results = await attempt({ s: query.title });
    if (!results.length && query.type) {
      results = await attempt({ s: query.title, type: query.type === 'tv' ? 'series' : 'movie' });
    }
    if (!results.length) {
      /* Last resort: the fuzzy endpoint. Anything it returns still has to
         survive scoring, so a bad hit cannot slip through unchecked. */
      const one = unwrap(
        await requestJson(url({ t: query.title, y: query.year || undefined }, key), {
          budget,
          signal,
          providerName: 'OMDb',
        })
      );
      if (one?.imdbID) results = [toRecord(one, { full: true })];
    }
    return results;
  },

  /** Full record for one id. Costs 1 request. */
  async details(sourceId, _type, { key, budget, signal }) {
    const data = unwrap(
      await requestJson(url({ i: sourceId, plot: 'short' }, key), { budget, signal, providerName: 'OMDb' })
    );
    return toRecord(data, { full: true });
  },

  /** OMDb is keyed on IMDb ids already, so this is the same call. */
  async byImdbId(imdbId, opts) {
    return this.details(imdbId, null, opts);
  },

  /**
   * Is this key usable right now? One lookup of a fixed, permanent id.
   *
   * Worth the single request: without it the only signal a key is bad arrives
   * part-way through a several-hundred-title sweep, and a saved-but-dead key
   * otherwise sits in the UI labelled "Connected".
   */
  async verifyKey(key, { signal } = {}) {
    try {
      await this.details('tt0111161', null, { key, signal });
      return { ok: true };
    } catch (err) {
      /* A dead network is not a bad key — do not tell someone to go and get a
         new one because their train went into a tunnel. */
      if (err.code === 'network') return { ok: null, message: 'Could not reach OMDb — check your connection.' };
      if (err.code === 'budget') {
        return { ok: true, message: 'Key works, but it has already hit today’s limit. It resets tomorrow.' };
      }
      return { ok: false, message: err.message };
    }
  },
};

export default omdb;

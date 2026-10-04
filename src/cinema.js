/*
 * What is on at the Savoy, Corby — your local cinema — for films on your
 * list, with a link to buy tickets on the Savoy's own site.
 *
 * The Savoy's site cannot be read from a phone (it sends no CORS headers),
 * so a GitHub Action in your private sync repo reads it a few times a day
 * and saves cinema/savoy-corby.json there (see cinemaSender.js). This reads
 * that file — through the same token as the library — keeps the last copy
 * on the phone, and matches the Savoy's films to yours by title.
 */

import * as store from './store.js';
import * as sync from './sync.js';
import { ymd } from './format.js';

export const CINEMA = {
  name: 'Savoy, Corby',
  site: 'https://savoycorby.co.uk/',
  whatsOn: 'https://savoycorby.co.uk/SavoyCorby.dll/WhatsOn',
};
export const LISTINGS_PATH = 'cinema/savoy-corby.json';

const CACHE_KEY = 'wn.cinema';
const FRESH_MS = 3 * 3600e3;

let listings = null;
function readCache() {
  if (listings) return listings;
  try {
    listings = JSON.parse(localStorage.getItem(CACHE_KEY)) || null;
  } catch {
    listings = null;
  }
  return listings;
}

/** The last listings this phone has, or null. */
export function current() {
  return readCache();
}

let fetching = null;
/** Fetch the listings from the repo, if the copy here is a few hours old. */
export async function refreshListings({ force = false } = {}) {
  if (!sync.configured()) return null;
  const have = readCache();
  if (!force && have?.checkedAt && Date.now() - have.checkedAt < FRESH_MS) return have;
  if (fetching) return fetching;
  fetching = (async () => {
    try {
      const file = await sync.readRepoFile(LISTINGS_PATH);
      if (!file) return have;
      const data = JSON.parse(file.text);
      if (!data || !Array.isArray(data.films)) return have;
      listings = { ...data, checkedAt: Date.now() };
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(listings));
      } catch {
        /* kept for this session */
      }
      store.emit('cinema');
      return listings;
    } catch {
      return have;
    } finally {
      fetching = null;
    }
  })();
  return fetching;
}

/* A title as the Savoy writes it, and as the library does, brought to the
   same shape: "Wicked: For Good (2D)", "WICKED - FOR GOOD", "Wicked: For
   Good" are one film. */
export function cinemaKey(title) {
  return String(title || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\((?:2d|3d|imax|subtitled|subs?|dubbed|autism friendly|relaxed|parent ?& ?baby|silver screen|\d{4})\)/g, ' ')
    .replace(/\b(?:2d|3d)\b/g, ' ')
    .replace(/[-–—:]\s*the imax experience\b/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/^(the|a|an)\s+/, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

/** The Savoy's film for one of yours, or null. */
export function filmFor(item) {
  const l = readCache();
  if (!l?.films?.length || !item) return null;
  const key = cinemaKey(item.title);
  if (!key) return null;
  const hits = l.films.filter((f) => cinemaKey(f.title) === key);
  if (!hits.length) return null;
  /* Two with one title (a re-release and a remake): the year decides. */
  return hits.find((f) => !f.year || !item.year || Math.abs(f.year - item.year) <= 1) || null;
}

/** Showings still to come for one of your films, soonest first. */
export function showingsFor(item, now = new Date()) {
  const film = filmFor(item);
  if (!film) return [];
  const today = ymd(now);
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  return (film.showings || [])
    .filter((s) => s.date > today || (s.date === today && s.time >= hhmm))
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

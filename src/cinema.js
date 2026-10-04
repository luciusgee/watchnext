/*
 * What is on at the Savoy, Corby — your local cinema — for films on your
 * list, with a link to buy tickets on the Savoy's own site.
 *
 * The Savoy's site cannot be read from a phone (it sends no CORS headers),
 * so a GitHub Action in your private sync repo reads it a few times a day
 * and saves cinema/savoy-corby.json there (see cinemaSender.js). This reads
 * that file — through the same token as the library — keeps the last copy
 * on the phone, and matches the Savoy's films to yours by title, using the
 * same title rules the Action does (watchnext-cinema.js).
 */

import * as store from './store.js';
import * as sync from './sync.js';
import { ymd } from './format.js';
import { normaliseTitle, altTitleKeys, LISTINGS_PATH } from './watchnext-cinema.js';

export { LISTINGS_PATH };
export const CINEMA = {
  name: 'Savoy, Corby',
  site: 'https://savoycorby.co.uk/',
  whatsOn: 'https://savoycorby.co.uk/SavoyCorby.dll/WhatsOn',
};

const CACHE_KEY = 'wn.cinema';
/* Looked for again after a few hours; sooner while there is nothing yet,
   since the first listings arrive a minute or so after the job is put in
   the repo. */
const FRESH_MS = 3 * 3600e3;
const RETRY_MS = 5 * 60e3;
/* Listings this old are not trusted to say what is on: the job has stopped
   working (the Savoy changed its site, say), and the film page goes back to
   just the link. */
const STALE_MS = 4 * 864e5;

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

/** The listings this phone has, while they are recent enough to go by; or null. */
export function current(now = Date.now()) {
  const l = readCache();
  if (!l || !Array.isArray(l.films)) return null;
  const at = Date.parse(l.fetchedAt || '') || l.checkedAt || 0;
  return now - at < STALE_MS ? l : null;
}

let fetching = null;
let triedAt = 0;
/** Fetch the listings from the repo, if the copy here is a few hours old. */
export async function refreshListings({ force = false } = {}) {
  if (!sync.configured()) return null;
  const have = readCache();
  if (!force) {
    if (have?.checkedAt && Date.now() - have.checkedAt < FRESH_MS) return have;
    if (Date.now() - triedAt < RETRY_MS) return have;
  }
  if (fetching) return fetching;
  triedAt = Date.now();
  fetching = (async () => {
    try {
      const file = await sync.readRepoFile(LISTINGS_PATH);
      if (!file) return have;
      const data = JSON.parse(file.text);
      if (!data || !Array.isArray(data.films)) return have;
      listings = { ...data, checkedAt: Date.now() };
      keyed = null;
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

/* Each Savoy film's title keys, worked out here rather than trusting the
   file's: the app and the job in the repo can be a build apart. */
let keyed = null;
function keysOf(l) {
  if (keyed?.of !== l) keyed = { of: l, keys: new Map(l.films.map((f) => [f, new Set([normaliseTitle(f.title), ...altTitleKeys(f.title)])])) };
  return keyed.keys;
}

/* A showing of an older film — a re-release, an anniversary, a kids' club
   morning, an event — rather than a new one that shares its title. */
const OLDER = /\b(re-?release|anniversary|encore|rewind|classic|throwback)\b/i;
const olderShowing = (f) =>
  !!f.event || OLDER.test(f.title) || (f.showings || []).some((s) => (s.tags || []).some((t) => /re-?release|kids club|toddler club/i.test(t)));

/* The Savoy's listings carry no years, so a year can only rule a film out:
   your "Dracula" (1992) is not the Savoy's new "Dracula", unless the Savoy
   is showing it as an older film. */
function yearFits(f, item) {
  if (!item.year) return true;
  if (f.year) return Math.abs(f.year - item.year) <= 1;
  if (olderShowing(f)) return true;
  const when = f.opens || f.showings?.[0]?.date;
  return !when || item.year >= Number(when.slice(0, 4)) - 2;
}

/** The Savoy's films that are this one of yours — usually one; a film and
    its special screening can be two. */
export function filmsFor(item) {
  const l = current();
  if (!l?.films?.length || !item?.title) return [];
  const mine = normaliseTitle(item.title);
  if (!mine) return [];
  const keys = keysOf(l);
  return l.films.filter((f) => keys.get(f)?.has(mine) && yearFits(f, item));
}

/** The Savoy's film for one of yours (the one with showings first), or null. */
export function filmFor(item) {
  const films = filmsFor(item);
  return films.find((f) => f.showings?.length) || films[0] || null;
}

/** Showings still to come for one of your films, soonest first. */
export function showingsFor(item, now = new Date()) {
  const today = ymd(now);
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const seen = new Set();
  return filmsFor(item)
    .flatMap((f) => (f.showings || []).map((s) => ({ ...s, film: f })))
    .filter((s) => (s.date > today || (s.date === today && s.time > hhmm)) && !seen.has(s.id) && seen.add(s.id))
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

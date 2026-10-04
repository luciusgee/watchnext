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
  /* fetchedAt is when the job last saved them, which it does at least daily
     while it is working. */
  const at = Date.parse(l.fetchedAt || '') || l.readAt || 0;
  return now - at < STALE_MS ? l : null;
}

function keep(next) {
  listings = next;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(listings));
  } catch {
    /* kept for this session */
  }
}

let fetching = null;
let triedAt = 0;
/** Fetch the listings from the repo, if the copy here is a few hours old. */
export async function refreshListings({ force = false } = {}) {
  if (!sync.configured()) return null;
  const have = readCache();
  if (!force) {
    if (have?.readAt && Date.now() - have.readAt < FRESH_MS) return have;
    if (Date.now() - triedAt < RETRY_MS) return have;
  }
  if (fetching) return fetching;
  triedAt = Date.now();
  fetching = (async () => {
    try {
      const file = await sync.readRepoFile(LISTINGS_PATH);
      if (!file) return have;
      /* The same file as last time: noted, and nothing redrawn. */
      if (have && file.sha && file.sha === have.sha) {
        keep({ ...have, readAt: Date.now() });
        return listings;
      }
      const data = JSON.parse(file.text);
      if (!data || !Array.isArray(data.films)) return have;
      keep({ ...data, sha: file.sha, readAt: Date.now() });
      keyed = null;
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

/* Shown as an older film: a re-release, an encore, a classic. */
const OLDER = /\b(re-?release|encore|rewind|classic|throwback)\b/i;
const markedOlder = (f) => OLDER.test(f.title) || (f.showings || []).some((s) => (s.tags || []).some((t) => /re-?release/i.test(t)));
const sameLength = (f, item) => f.runtime > 0 && item.runtime > 0 && Math.abs(f.runtime - item.runtime) <= 3;

/* The Savoy's listings carry no years, so the year has to come from the
   listing itself. A film from the last couple of years is the new release
   it shares a title with. An older one has to show it is the same film:
   the anniversary adds up ("Scream 30th Anniversary" is 1996's), or the
   running times agree, or the Savoy says it is a re-release and nothing
   says otherwise. So your "Dracula" (1931) is not the Savoy's new
   "Dracula", nor "Scream" (2022) the 30th anniversary showing. */
function yearFits(f, item, l) {
  if (!item.year) return true;
  if (f.year) return Math.abs(f.year - item.year) <= 1;
  const when = f.opens || f.showings?.[0]?.date || l.fetchedAt || ymd();
  const shown = Number(String(when).slice(0, 4));
  const anniversary = /\b(\d{1,3})(?:st|nd|rd|th)\s+anniversary\b/i.exec(f.title);
  if (anniversary) return Math.abs(shown - Number(anniversary[1]) - item.year) <= 1;
  if (item.year >= shown - 2) return true;
  if (sameLength(f, item)) return true;
  return markedOlder(f) && !(f.runtime > 0 && item.runtime > 0);
}

/* Every title one of yours goes by: its own, and its UK title where that
   is different ("Zootropolis 2" for "Zootopia 2"), looked up with its
   release dates. */
function keysFor(item) {
  return new Set([item.title, ...(item.release?.titles || [])].map(normaliseTitle).filter(Boolean));
}

/** The Savoy's films that are this one of yours — usually one; a film and
    its special screening can be two. Films only: a series is never on. */
export function filmsFor(item) {
  const l = current();
  if (!l?.films?.length || !item?.title || item.type === 'tv') return [];
  const mine = keysFor(item);
  if (!mine.size) return [];
  const keys = keysOf(l);
  return l.films.filter((f) => [...mine].some((k) => keys.get(f)?.has(k)) && yearFits(f, item, l));
}

const nowParts = (now) => ({
  today: ymd(now),
  hhmm: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
});
const ahead = (s, { today, hhmm }) => s.date > today || (s.date === today && s.time > hhmm);

/** The Savoy's film for one of yours, or null: the one with times still to
    come, else the one about to open, else whichever there is. */
export function filmFor(item, now = new Date()) {
  const films = filmsFor(item);
  const t = nowParts(now);
  return (
    films.find((f) => (f.showings || []).some((s) => ahead(s, t))) ||
    films.find((f) => f.opens && f.opens > t.today) ||
    films.find((f) => f.comingSoon) ||
    films[0] ||
    null
  );
}

/** Showings still to come for one of your films, soonest first. */
export function showingsFor(item, now = new Date()) {
  const t = nowParts(now);
  const seen = new Set();
  return filmsFor(item)
    .flatMap((f) => (f.showings || []).map((s) => ({ ...s, film: f })))
    .filter((s) => ahead(s, t) && !seen.has(s.id) && seen.add(s.id))
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

/*
 * Store — the single source of truth.
 *
 * Design rules learned from the previous version:
 *  · Every item carries a stable `uid`. Nothing is ever located by title,
 *    because titles change (enrichment rewrites them) and collide
 *    ("It", "Drive", "1899" all have multiple real films).
 *  · Fields the user set by hand are recorded in `locked` and are never
 *    overwritten by metadata enrichment.
 *  · Enrichment bookkeeping lives on the item, so a re-run only touches
 *    what is actually missing or stale.
 *  · Schema is versioned and migrated forward, never silently reshaped.
 */

import { writeMirror, readMirror } from './durability.js';

const KEY = 'wn.state.v3';
const LEGACY_KEY = 'wn_lib2';
const LEGACY_ACTIVITY = 'wn_activity';
const SCHEMA = 3;

/* metadata schema version — bump to force a re-enrich sweep after
   improving the matcher. Items already at this version are skipped. */
export const META_VERSION = 2;

const listeners = new Set();
let state = null;
let saveTimer = null;

/* ── ids ── */
let seq = 0;
export function uid() {
  seq += 1;
  return 'w' + Date.now().toString(36) + seq.toString(36) + Math.floor(Math.random() * 1296).toString(36);
}

/* ── item shape ── */
export function makeItem(partial = {}) {
  return {
    uid: partial.uid || uid(),
    title: partial.title || '',
    sortTitle: sortableTitle(partial.title || ''),
    year: partial.year ?? null,
    type: partial.type === 'tv' ? 'tv' : 'movie',
    genre: partial.genre || null,
    /* Every genre the provider listed, where `genre` is the single one chosen
       for display. Declared here because makeItem is what a backup is read
       through — leaving it out meant an export/import round trip quietly
       stripped this from every title, and the Library's genre facet narrowed
       to whatever `genre` happened to be. */
    genres: Array.isArray(partial.genres) ? partial.genres : [],
    rating: partial.rating ?? null,
    runtime: partial.runtime ?? null,
    overview: partial.overview || '',
    poster: partial.poster || null,
    imdbId: partial.imdbId || null,

    quality: partial.quality || null,
    owned: partial.owned ?? false,

    /* `watched` means somebody in the household has seen it, and keeps meaning
       exactly that. Every screen, filter, statistic and the scorer read it, so
       it does not change shape — the per-person detail is added alongside. */
    watched: partial.watched ?? false,
    watchedAt: partial.watchedAt ?? null,
    /* { personId: timestamp|null }. Empty for a household of one, which is why
       a solo library is byte-identical to what it was before this existed. */
    watchedBy: partial.watchedBy && typeof partial.watchedBy === 'object' ? partial.watchedBy : {},
    /* Retired. The watchlist was a list inside a list — the library IS the
       watchlist — so nothing reads these any more.
       They are still declared, and that is the whole point: dropping them from
       here would delete the field from every existing title the moment a backup
       was read, and from the live library on the next save. Collapsing a feature
       is a code change; it is not a licence to throw away someone's data. Keeping
       them costs two nulls a title and means the decision is reversible. */
    saved: partial.saved ?? false,
    saved_at: partial.saved_at ?? null,
    seen: partial.seen ?? false,
    seenAt: partial.seenAt ?? null,

    addedAt: partial.addedAt ?? Date.now(),
    locked: partial.locked || [],
    meta: partial.meta || { v: 0, status: 'pending', at: null, confidence: null },
  };
}

/** "The Dark Knight" -> "dark knight" — for alphabetical sort and matching. */
export function sortableTitle(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/^(the|a|an)\s+/, '')
    .trim();
}

/** Aggressive normalisation used only for duplicate detection / match scoring. */
export function normaliseTitle(t) {
  return String(t || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, 'and')
    .replace(/^(the|a|an)\s+/, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

/* ── defaults ── */
function emptyState() {
  return {
    schema: SCHEMA,
    items: [],
    activity: [],
    settings: {
      name: '',
      provider: 'tmdb',
      dataKeys: {},      // { tmdb: '…', omdb: '…' } — one per source
      keyStatus: {},     // { omdb: { ok, message, at } } — did the key actually answer?
      aiKey: '',
      libraryView: 'list',
      /* Things you never want suggested. See tastePrefs(). */
      taste: { genres: [], franchises: [], never: [] },
      /* Who watches here. Empty means one person, and one person is the case
         where none of this appears anywhere in the interface. */
      people: [],
      viewer: null,
      /* No screenFit here, and no longer a setting at all — the app stays inside
         the safe area, which is what looks right on the device. It briefly lived
         here as a preference, which could not work: iOS reads the viewport meta
         before any of this is loaded. An older saved state may still carry the
         field; nothing reads it. */
      seeded: false,
    },
  };
}

/* ── persistence ── */

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.schema) return migrate(parsed);
    }
  } catch (e) {
    console.warn('[store] could not read state, starting fresh', e);
  }
  const legacy = readLegacy();
  if (legacy) return legacy;
  return emptyState();
}

/** The old build wrote "unlisted" for "I own it but didn't say what in". */
export function normaliseQuality(q) {
  if (!q || q === 'unlisted' || q === 'N/A') return null;
  const map = { '4k': '4K', uhd: '4K', '2160p': '4K', '1080p': '1080p', hd: '1080p', '720p': '720p' };
  return map[String(q).toLowerCase()] || q;
}

/** Convert one row of the old `wn_lib2` / v1-backup shape into an item. */
export function fromLegacyRow(m) {
  return makeItem({
    title: m.t || '',
    year: typeof m.y === 'number' ? m.y : parseInt(m.y) || null,
    type: m.tp === 'tv' ? 'tv' : 'movie',
    genre: m.g || null,
    rating: typeof m.r === 'number' ? m.r : null,
    runtime: m.runtime ?? null,
    overview: m.d || '',
    poster: m.poster || null,
    imdbId: typeof m.id === 'string' && /^tt\d+$/.test(m.id) ? m.id : null,
    quality: normaliseQuality(m.q),
    owned: !!m.downloaded || m.q === '4K' || m.q === '1080p' || m.q === 'unlisted',
    watched: !!m.watched,
    watchedAt: m.watchedAt || null,
    saved: !!m.watchlist,
    saved_at: null,
    seen: !!(m.swipedSeen || m.swiped),
    seenAt: m.swipedAt || null,
    /* Legacy rows were enriched by the old, unreliable matcher — roughly a
       third of their ids point at a different film. Mark them for
       re-verification rather than trusting them. */
    meta: { v: 1, status: 'stale', at: null, confidence: null },
  });
}

/** One-time import of the v1/v2 `wn_lib2` array so existing users keep their data. */
function readLegacy() {
  let old;
  try {
    old = JSON.parse(localStorage.getItem(LEGACY_KEY) || 'null');
  } catch {
    return null;
  }
  if (!Array.isArray(old) || !old.length) return null;

  const s = emptyState();
  s.items = old.map(fromLegacyRow);
  s.settings.seeded = true;

  try {
    const acts = JSON.parse(localStorage.getItem(LEGACY_ACTIVITY) || '[]');
    if (Array.isArray(acts)) s.activity = acts.slice(0, 60);
  } catch {
    /* activity is disposable */
  }

  s.migratedFrom = 'wn_lib2';
  return s;
}

function migrate(s) {
  /* Settings gained a provider choice; anyone who already saved an OMDb key
     keeps it and stays on OMDb rather than silently losing their setup. */
  if (s.settings && !s.settings.dataKeys) {
    s.settings.dataKeys = {};
    if (s.settings.omdbKey) {
      s.settings.dataKeys.omdb = s.settings.omdbKey;
      s.settings.provider = 'omdb';
    }
    delete s.settings.omdbKey;
  }
  if (s.settings && !s.settings.provider) s.settings.provider = 'tmdb';

  if (s.schema === SCHEMA) return s;
  /* future schema migrations land here, oldest first */
  s.schema = SCHEMA;
  return s;
}

let lastMirror = 0;
const MIRROR_EVERY_MS = 30_000;

/** Second copy in IndexedDB, throttled. Never blocks the primary write. */
function mirror(force = false) {
  const now = Date.now();
  if (!force && now - lastMirror < MIRROR_EVERY_MS) return;
  lastMirror = now;
  writeMirror(state).catch(() => {
    /* a missing mirror is not worth surfacing; the primary write succeeded */
  });
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    mirror();
    return true;
  } catch (e) {
    /* Quota — almost always the poster URLs on a very large library.
       Drop overviews first (re-fetchable), then warn. */
    console.warn('[store] persist failed', e);
    try {
      const slim = {
        ...state,
        items: state.items.map((i) => ({ ...i, overview: i.overview.slice(0, 160) })),
      };
      localStorage.setItem(KEY, JSON.stringify(slim));
      return true;
    } catch {
      emit('quota-exceeded');
      return false;
    }
  }
}

/** Coalesced write — many mutations in one tick cost one serialise. */
export function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 120);
}

export function saveNow() {
  clearTimeout(saveTimer);
  return persist();
}

/* ── subscription ── */

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit(reason = 'change') {
  listeners.forEach((fn) => {
    try {
      fn(reason);
    } catch (e) {
      console.error('[store] listener failed', e);
    }
  });
}

/* ── access ── */

/**
 * Boot the store.
 *
 * Order matters and is the whole point: localStorage, then the legacy key,
 * then the IndexedDB mirror, and only then the starter seed. Seeding before
 * checking the mirror would hand someone whose storage was evicted a fresh
 * 228-title starter library and quietly bury the 500 titles they actually had.
 *
 * Async because reading the mirror is, and callers await it before first
 * paint. That costs one IndexedDB `get` on a cold start, and only when
 * localStorage came back empty.
 */
/**
 * Load the starter sample on request.
 *
 * Kept as an explicit action rather than a first-run side effect: a library
 * someone chose is theirs, and one they were handed is clutter they have to
 * work out how to delete.
 */
export function loadSample(seedFn) {
  if (typeof seedFn !== 'function') return 0;
  const rows = seedFn().map(makeItem);
  let added = 0;
  for (const row of rows) {
    if (findDuplicate(row.title, row.year, row.type)) continue;
    state.items.push(row);
    added += 1;
  }
  saveNow();
  mirror(true);
  emit('item');
  return added;
}

export async function init(seedFn) {
  state = read();

  if (!state.items.length) {
    const snapshot = await readMirror();
    if (snapshot?.state?.items?.length) {
      state = migrate(snapshot.state);
      saveNow();
      console.warn(
        `[store] primary storage was empty; restored ${state.items.length} titles from the on-device backup`
      );
      emit('recovered');
      return state;
    }
  }

  /* A new install starts empty.
     It used to arrive holding 228 titles from the author's own shelf, marked as
     owned, with no way to clear them — so the first thing a stranger saw was
     somebody else's horror collection presented as theirs, and "what should I
     watch tonight" answered from films they do not have. The sample is still
     here and still one tap away from the empty state; it is just no longer
     imposed. Anyone already carrying it keeps it: seeded is only ever set, and
     this branch cannot run once it is. */
  if (!state.settings.seeded && !state.items.length) {
    state.settings.seeded = true;
    saveNow();
  } else if (state.migratedFrom) {
    /* A library was just imported from the old `wn_lib2` format. Write it out
       immediately — otherwise nothing persists until the user happens to make
       a change, and every reload re-runs the migration (regenerating uids and
       discarding anything derived since). The old key is deliberately left in
       place as a safety net. */
    saveNow();
    mirror(true);
  }

  return state;
}

export function getState() {
  return state;
}
export function items() {
  return state.items;
}
export function settings() {
  return state.settings;
}

export function byUid(id) {
  return state.items.find((i) => i.uid === id) || null;
}

export function indexOfUid(id) {
  return state.items.findIndex((i) => i.uid === id);
}

/** Update by uid with a patch or updater fn. Returns the updated item. */
export function update(id, patch) {
  const idx = indexOfUid(id);
  if (idx < 0) return null;
  const next =
    typeof patch === 'function'
      ? { ...state.items[idx], ...patch(state.items[idx]) }
      : { ...state.items[idx], ...patch };
  if (patch && (patch.title || (typeof patch === 'function' && next.title !== state.items[idx].title))) {
    next.sortTitle = sortableTitle(next.title);
  }
  state.items[idx] = next;
  save();
  return next;
}

/** Mark fields as user-authored so enrichment leaves them alone. */
export function lockFields(id, fields) {
  const item = byUid(id);
  if (!item) return;
  const locked = new Set(item.locked || []);
  fields.forEach((f) => locked.add(f));
  update(id, { locked: [...locked] });
}

export function isLocked(item, field) {
  return Array.isArray(item.locked) && item.locked.includes(field);
}

export function add(partial) {
  const item = makeItem(partial);
  state.items.push(item);
  save();
  return item;
}

export function remove(id) {
  const idx = indexOfUid(id);
  if (idx < 0) return null;
  const [gone] = state.items.splice(idx, 1);
  save();
  return gone;
}

export function updateSettings(patch) {
  Object.assign(state.settings, patch);
  save();
}

/* ── duplicate detection ──
   Matches on normalised title AND year proximity, so "Dune (1984)" and
   "Dune (2021)" are correctly treated as different films. */
export function findDuplicate(title, year, type) {
  const n = normaliseTitle(title);
  if (!n) return null;
  return (
    state.items.find((i) => {
      if (normaliseTitle(i.title) !== n) return false;
      if (type && i.type !== type) return false;
      if (year && i.year && Math.abs(i.year - year) > 1) return false;
      return true;
    }) || null
  );
}

/* ── activity log ──
   Each entry stores enough to reverse itself precisely. */

export function logActivity(kind, item, prev) {
  state.activity.unshift({
    id: uid(),
    kind,
    uid: item.uid,
    title: item.title,
    at: Date.now(),
    prev: prev || null,
  });
  if (state.activity.length > 80) state.activity.length = 80;
  save();
}

export function activity() {
  return state.activity;
}

export function undoActivity(entryId) {
  const idx = state.activity.findIndex((a) => a.id === entryId);
  if (idx < 0) return false;
  const entry = state.activity[idx];
  const item = byUid(entry.uid);
  if (!item) {
    state.activity.splice(idx, 1);
    save();
    return false;
  }
  if (entry.prev) update(entry.uid, entry.prev);
  state.activity.splice(idx, 1);
  save();
  return true;
}

export function clearActivity() {
  state.activity = [];
  save();
}

/* ── bulk operations ── */

export function bulk(fn) {
  state.items.forEach((item, i) => {
    const patch = fn(item, i);
    if (patch) state.items[i] = { ...item, ...patch };
  });
  saveNow();
}

/* ── export / import ── */

export function exportPayload() {
  return {
    app: 'watchnext',
    schema: SCHEMA,
    exportedAt: new Date().toISOString(),
    items: state.items,
    activity: state.activity,
    /* API keys are deliberately excluded — a backup file should never
       carry a secret the user may share or sync to cloud storage. */
    settings: {
      name: state.settings.name,
      libraryView: state.settings.libraryView,
    },
  };
}

/**
 * Read either backup format and return items, or null if unrecognised.
 *  · current  — { app:'watchnext', items:[ {title, year, …} ] }
 *  · v1       — { version:1, library:[ {t, y, g, …} ], posterCache, apiKey }
 * The v1 shape is what the previous build exported, so files people already
 * have on disk must keep working.
 */
export function readBackup(payload) {
  if (!payload || typeof payload !== 'object') return null;

  if (Array.isArray(payload.items)) {
    return payload.items.map((raw) => makeItem(raw));
  }
  if (Array.isArray(payload.library)) {
    return payload.library.map(fromLegacyRow);
  }
  /* A bare array of either shape is also accepted. */
  if (Array.isArray(payload)) {
    return payload.map((raw) => (raw && raw.t !== undefined ? fromLegacyRow(raw) : makeItem(raw)));
  }
  return null;
}

/**
 * Merge an exported payload. Returns a summary.
 * `mode` is 'merge' (default, keeps existing) or 'replace'.
 */
export function importPayload(payload, mode = 'merge') {
  const incoming = readBackup(payload);
  if (!incoming) throw new Error('That file does not look like a Watch Next backup.');

  if (mode === 'replace') {
    state.items = incoming;
    state.activity = Array.isArray(payload.activity) ? payload.activity : [];
    /* Put back the settings the backup actually carries. exportPayload has
       always written these and nothing ever read them, so a full restore
       silently dropped your name and your list/grid choice.
       Whitelisted field by field rather than merged wholesale: a backup is a
       plain JSON file the user can edit, and settings is where the API keys
       live — restoring one must not be a way to plant a key. */
    const incomingSettings = payload.settings;
    if (incomingSettings && typeof incomingSettings === 'object') {
      if (typeof incomingSettings.name === 'string') {
        state.settings.name = incomingSettings.name;
      }
      if (incomingSettings.libraryView === 'list' || incomingSettings.libraryView === 'grid') {
        state.settings.libraryView = incomingSettings.libraryView;
      }
    }
    saveNow();
    return { added: incoming.length, merged: 0, skipped: 0 };
  }
  /* Merging someone else's library into yours is not a reason to take their
     name or their view preference, so settings are deliberately ignored below. */

  let added = 0;
  let merged = 0;
  for (const inc of incoming) {
    const existing =
      (inc.imdbId && state.items.find((i) => i.imdbId === inc.imdbId)) ||
      findDuplicate(inc.title, inc.year, inc.type);
    if (existing) {
      /* keep the more advanced watch state, prefer richer metadata */
      Object.assign(existing, {
        watched: existing.watched || inc.watched,
        watchedAt: existing.watchedAt || inc.watchedAt,
        saved: existing.saved || inc.saved,
        seen: existing.seen || inc.seen,
        owned: existing.owned || inc.owned,
        poster: existing.poster || inc.poster,
        overview: existing.overview || inc.overview,
        rating: existing.rating ?? inc.rating,
        runtime: existing.runtime ?? inc.runtime,
        imdbId: existing.imdbId || inc.imdbId,
        /* Richer wins, same as every other field here: a backup carrying the
           full genre list should fill in a record that only ever got one. */
        genres: existing.genres?.length ? existing.genres : inc.genres || [],
      });
      merged += 1;
    } else {
      state.items.push(inc);
      added += 1;
    }
  }
  saveNow();
  return { added, merged, skipped: 0 };
}

/* ── derived selectors ── */

export function stats() {
  const all = state.items;
  const watched = all.filter((i) => i.watched);
  const owned = all.filter((i) => i.owned);
  return {
    total: all.length,
    watched: watched.length,
    unwatched: all.length - watched.length,
    /* The pile: bought and never played. Replaces a watchlist count, back when
       the watchlist was a separate list. */
    pile: all.filter((i) => i.owned && !i.watched).length,
    owned: owned.length,
    movies: all.filter((i) => i.type === 'movie').length,
    shows: all.filter((i) => i.type === 'tv').length,
    hoursWatched: Math.round(
      watched.reduce((sum, i) => sum + (i.runtime || 0), 0) / 60
    ),
    /* The number that lands: how long the pile would take to get through.
       Titles with no runtime contribute nothing rather than an invented
       average — an estimate presented as a fact is how a stat stops being
       trusted. */
    hoursUnwatched: Math.round(
      all.filter((i) => !i.watched).reduce((sum, i) => sum + (i.runtime || 0), 0) / 60
    ),
    pctWatched: all.length ? Math.round((watched.length / all.length) * 100) : 0,
    fourK: all.filter((i) => i.owned && i.quality === '4K').length,
    watchedThisYear: watched.filter(
      (i) => i.watchedAt && new Date(i.watchedAt).getFullYear() === new Date().getFullYear()
    ).length,
    /* Whether the watch dates describe history or just describe setup.
       Every timestamp is written when someone TELLS the app they have seen
       something, so a library imported and triaged over a weekend carries five
       hundred dates from that weekend. Presenting that as "films watched this
       year" is a claim the data cannot support — the same mistake as dating a
       shelf by when a title entered the app. A real spread of more than about
       two months is the cheapest honest test, and it becomes true on its own
       once the app has been used for a while. */
    datesAreHistory: (() => {
      const stamps = watched.map((i) => i.watchedAt).filter(Boolean);
      if (stamps.length < 5) return false;
      return Math.max(...stamps) - Math.min(...stamps) > 60 * 24 * 3600 * 1000;
    })(),
  };
}

/**
 * How the library breaks down by decade, and by genre.
 * Returned as sorted [label, count] pairs so a caller can render without
 * knowing anything about the shape of an item.
 */
export function breakdown() {
  const decade = new Map();
  const genre = new Map();
  for (const i of state.items) {
    if (i.year) {
      const d = `${Math.floor(i.year / 10) * 10}s`;
      decade.set(d, (decade.get(d) || 0) + 1);
    }
    if (i.genre) genre.set(i.genre, (genre.get(i.genre) || 0) + 1);
  }
  return {
    decades: [...decade.entries()].sort((a, b) => parseInt(a[0]) - parseInt(b[0])),
    genres: [...genre.entries()].sort((a, b) => b[1] - a[1]),
  };
}

/**
 * What you have told the app not to suggest.
 *
 * Three kinds, because they are three different feelings: a genre you never
 * watch, a franchise you are done with, and one specific film you are tired of
 * being offered. Read through here rather than off settings directly so a
 * library saved before this existed gets the empty shape rather than undefined.
 */
export function tastePrefs() {
  const t = state.settings.taste || {};
  return {
    genres: Array.isArray(t.genres) ? t.genres : [],
    franchises: Array.isArray(t.franchises) ? t.franchises : [],
    never: Array.isArray(t.never) ? t.never : [],
  };
}

/** Add or remove one entry. Returns the new list. */
export function setTaste(kind, value, on) {
  const prefs = tastePrefs();
  const list = new Set(prefs[kind] || []);
  if (on) list.add(value);
  else list.delete(value);
  updateSettings({ taste: { ...prefs, [kind]: [...list] } });
  return [...list];
}

/* ── who watches here ──
   A household shares a shelf but not a watch history: the useful question on a
   sofa is "something I have seen and she has not", and one boolean cannot
   answer it. So `watched` keeps meaning "somebody here has seen this" and a
   per-person record is kept beside it.

   Nothing below appears in the interface until a second person exists. A
   library of one stores an empty object per item and behaves exactly as it did
   before any of this was written. */

export function people() {
  const list = state.settings.people;
  return Array.isArray(list) ? list : [];
}

/** The person the app is currently answering for, or null when there is one. */
export function viewer() {
  const list = people();
  if (list.length < 2) return null;
  const id = state.settings.viewer;
  return list.some((p) => p.id === id) ? id : list[0].id;
}

export function setViewer(id) {
  updateSettings({ viewer: id });
}

export function addPerson(name) {
  const clean = String(name || '').trim().slice(0, 24);
  if (!clean) return null;
  const list = people();
  const person = { id: 'p' + Date.now().toString(36) + list.length, name: clean };

  /* The first person added inherits the existing history, because it is theirs:
     everything marked watched before there was more than one person was watched
     by whoever has been using the app. Handing it to nobody would silently
     empty a watch history, and handing it to everybody would invent one. */
  if (!list.length) {
    for (const item of state.items) {
      if (item.watched) item.watchedBy = { ...(item.watchedBy || {}), [person.id]: item.watchedAt ?? null };
    }
  }

  updateSettings({ people: [...list, person] });
  saveNow();
  return person;
}

export function removePerson(id) {
  const list = people().filter((p) => p.id !== id);
  /* Their marks go with them — leaving orphaned ids behind would quietly count
     a departed person's viewing towards "everyone here has seen this". */
  for (const item of state.items) {
    if (item.watchedBy && id in item.watchedBy) {
      const next = { ...item.watchedBy };
      delete next[id];
      item.watchedBy = next;
    }
  }
  updateSettings({ people: list, viewer: list.length ? list[0].id : null });
  saveNow();
}

/** Has this person seen it? With nobody named, falls back to the shared flag. */
export function seenBy(item, personId = viewer()) {
  if (!personId) return !!item.watched;
  return !!(item.watchedBy && personId in item.watchedBy);
}

/** Record one person's viewing, keeping the shared flag in step. */
export function setSeenBy(uid, personId, on) {
  const item = byUid(uid);
  if (!item) return null;
  const next = { ...(item.watchedBy || {}) };
  if (on) next[personId] = Date.now();
  else delete next[personId];

  /* The shared flag is the OR of everyone's, so the rest of the app — filters,
     statistics, the scorer's re-watch rule — keeps working untouched. */
  const anyone = Object.keys(next).length > 0;
  return update(uid, {
    watchedBy: next,
    watched: anyone,
    watchedAt: anyone ? item.watchedAt ?? Date.now() : null,
  });
}

/** Genres present in the library, most common first. */
export function genresInUse() {
  const counts = new Map();
  for (const i of state.items) {
    if (!i.genre) continue;
    counts.set(i.genre, (counts.get(i.genre) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g);
}

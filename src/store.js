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
import { cleanTitleLine, looksNumberedList } from './format.js';
import { collapseDuplicates } from './merge.js';

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
    /* When this record last changed, as opposed to when it arrived. The merge
       in merge.js decides which of two copies of a title wins by comparing
       these, so anything that mutates an item has to move it — see update(),
       bulk() and applySync(). Falls back to addedAt for the several hundred
       records that predate the field. */
    updatedAt: partial.updatedAt ?? partial.addedAt ?? Date.now(),
    locked: partial.locked || [],
    meta: partial.meta || { v: 0, status: 'pending', at: null, confidence: null },
    /* In the shared shortlist — "this weekend" — and who put it there:
       { at, by, device }, or null. Declared here, like every field, so a
       backup read through makeItem keeps it. */
    spotlight: partial.spotlight && typeof partial.spotlight === 'object' ? partial.spotlight : null,
    /* 'YYYY-MM-DD': when a film added before it was out can be watched at
       home (its UK digital date, else its cinema date). Tonight does not
       suggest it before then. Null for nearly everything. */
    released: typeof partial.released === 'string' ? partial.released.slice(0, 10) : null,
    /* A superlike — "we have to watch this" — and who gave it: { at, by,
       device }, or null. Stronger than Spotlight, and puts the film there. */
    superlike: partial.superlike && typeof partial.superlike === 'object' ? partial.superlike : null,
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
    /* { uid, at } for every title deleted here. A deleted film and a film this
       device has never heard of look identical without this, so a sync would
       hand back everything the other person threw away. Pruned in merge.js. */
    tombstones: [],
    /* Comments on films, shared through sync: { id, uid, film, text, by,
       device, at }. Kept apart from the items because two phones commenting
       on the same film at once would otherwise overwrite each other — items
       merge last-write-wins, notes merge as a union. */
    notes: [],
    settings: {
      /* What this phone's comments are signed with. Per phone, never synced. */
      name: '',
      /* Which phone a comment or a Spotlight came from, so the other one
         knows it is news. Made on first load. */
      deviceId: 'd' + uid(),
      /* uid -> when this phone last read that film's comments. */
      threadSeen: {},
      /* Ids of the other phone's comments this phone has read. By id, not by
         time: a comment written an hour ago that only synced now is still
         new. */
      seenNotes: [],
      /* Things this phone did that the other phone should hear about, waiting
         for the next sync to carry them. See sync.js and notify.js. */
      pendingNotify: [],
      provider: 'tmdb',
      dataKeys: {},      // { tmdb: '…', omdb: '…' } — one per source
      keyStatus: {},     // { omdb: { ok, message, at } } — did the key actually answer?
      aiKey: '',
      /* Which Claude answers. Empty means the app's default — see ai.js, which
         also treats an unknown id as the default, so neither an old saved state
         nor a hand-edited backup can point this at a model that does not
         exist. */
      aiModel: '',
      libraryView: 'list',
      /* Two phones, one shelf — see sync.js. The token lives here with the
         other keys, which is also why the sync payload is built by
         syncSnapshot() rather than from settings: this object must never be
         the thing that gets written to a repo. */
      sync: { repo: '', token: '', path: 'library.json', enabled: false },
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

/* Titles migrate() repaired on this load, so init() can write the fix out
   rather than repeating it in memory on every launch. */
let repairedOnLoad = 0;
/* How many duplicate records that repair folded away, so main.js can say so. */
let collapsedOnLoad = 0;

/** Read once: the count of duplicates merged on this load, then zero. */
export function takeCollapsed() {
  const n = collapsedOnLoad;
  collapsedOnLoad = 0;
  return n;
}

/* Fold duplicates in the live library. Returns how many records went. */
function collapseHere() {
  const out = collapseDuplicates({ items: state.items, tombstones: state.tombstones || [] });
  if (!out.collapsed) return 0;
  state.items = out.items;
  state.tombstones = out.tombstones;
  return out.collapsed;
}

/* Does another record already hold this film? */
function heldElsewhere(item) {
  return (
    !!item?.imdbId &&
    state.items.some((o) => o !== item && o.uid !== item.uid && o.imdbId === item.imdbId && o.type === item.type)
  );
}

/* After a fold, the record a caller asked about may be the one that went.
   Hand back whichever record now stands for that film. */
function standingFor(item) {
  return byUid(item.uid) || state.items.find((i) => i.imdbId === item.imdbId && i.type === item.type) || null;
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
  /* Added with sync. Absent on every state saved before it, and read on every
     merge, so it is defaulted here rather than guarded at each use. */
  if (!Array.isArray(s.tombstones)) s.tombstones = [];
  if (!Array.isArray(s.notes)) s.notes = [];
  if (s.settings) {
    if (!s.settings.deviceId) {
      /* Saved straight away (see init): an id made fresh on every launch is
         not an id, and notifications are addressed by it. */
      s.settings.deviceId = 'd' + uid();
      repairedOnLoad += 1;
    }
    if (!Array.isArray(s.settings.seenNotes)) s.settings.seenNotes = [];
    if (!s.settings.threadSeen || typeof s.settings.threadSeen !== 'object') s.settings.threadSeen = {};
    if (!Array.isArray(s.settings.pendingNotify)) s.settings.pendingNotify = [];
  }

  /* Titles pasted from a bulleted list kept the bullet — "•\tThe Power" was
     stored, displayed and exported that way. Repaired on every load rather
     than behind a schema bump, because a backup restored from before the fix
     carries the same damage, and because running it on both devices means a
     sync converges on the clean title without either side writing. */
  if (Array.isArray(s.items)) {
    const numbered = looksNumberedList(s.items.map((i) => i && i.title));
    for (const item of s.items) {
      if (!item || typeof item.title !== 'string') continue;
      const clean = cleanTitleLine(item.title, { numbered });
      if (!clean || clean === item.title) continue;
      item.title = clean;
      item.sortTitle = sortableTitle(clean);
      repairedOnLoad += 1;
    }

    /* Two records of one film, folded into one. The library brought over
       from the old app carried seven; see collapseDuplicates. */
    const out = collapseDuplicates({ items: s.items, tombstones: s.tombstones });
    if (out.collapsed) {
      s.items = out.items;
      s.tombstones = out.tombstones;
      repairedOnLoad += out.collapsed;
      collapsedOnLoad += out.collapsed;
    }
  }

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
    /* Bounded. This runs on every fresh install, and an IndexedDB open that
       never settles would hold the whole app behind its launch fade. */
    const snapshot = await Promise.race([
      readMirror().catch(() => null),
      new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
    ]);
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
  if (repairedOnLoad) {
    repairedOnLoad = 0;
    saveNow();
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
  const prev = state.items[idx];
  const next =
    typeof patch === 'function'
      ? { ...state.items[idx], ...patch(state.items[idx]) }
      : { ...state.items[idx], ...patch };
  if (patch && (patch.title || (typeof patch === 'function' && next.title !== state.items[idx].title))) {
    next.sortTitle = sortableTitle(next.title);
  }
  next.updatedAt = Date.now();
  state.items[idx] = next;
  /* A lookup — or picking the right match by hand — can give a record the
     IMDb id of a film already here: a misspelt title resolving to the one
     spelt properly. That is the moment it becomes a duplicate, so fold it. */
  if (next.imdbId !== prev.imdbId && heldElsewhere(next)) {
    collapseHere();
    save();
    return standingFor(next);
  }
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
  if (heldElsewhere(item)) {
    collapseHere();
    save();
    return standingFor(item);
  }
  save();
  return item;
}

export function remove(id) {
  const idx = indexOfUid(id);
  if (idx < 0) return null;
  const [gone] = state.items.splice(idx, 1);
  bury(gone.uid);
  /* Gone before the sync: a comment on it need not be sent. */
  forgetQueued(gone.uid);
  save();
  return gone;
}

/** Record that a uid was deleted here, so a sync cannot resurrect it. */
function bury(id) {
  if (!id) return;
  if (!Array.isArray(state.tombstones)) state.tombstones = [];
  const at = Date.now();
  const held = state.tombstones.find((t) => t.uid === id);
  if (held) held.at = at;
  else state.tombstones.push({ uid: id, at });
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
  const at = Date.now();
  state.items.forEach((item, i) => {
    const patch = fn(item, i);
    /* Stamped here as well as in update(), which this deliberately does not go
       through — a bulk edit is still an edit, and a sync that could not see it
       would hand back the old version of every title it touched. */
    if (patch) state.items[i] = { ...item, ...patch, updatedAt: at };
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
    notes: state.notes || [],
    /* API keys are deliberately excluded — a backup file should never
       carry a secret the user may share or sync to cloud storage. */
    settings: {
      name: state.settings.name,
      libraryView: state.settings.libraryView,
      /* Which model, but never the key that pays for it. */
      aiModel: state.settings.aiModel,
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
    /* A restore is a claim about what the library should be, so the titles it
       drops are deletions and have to be recorded as such. Without this,
       restoring last month's backup onto one phone and syncing gets you
       everything you restored *plus* everything you were trying to undo. */
    const keeping = new Set(incoming.map((i) => i.uid));
    for (const held of state.items) {
      if (!keeping.has(held.uid)) bury(held.uid);
    }
    state.items = incoming;
    state.activity = Array.isArray(payload.activity) ? payload.activity : [];
    takeNotes(payload.notes);
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
      /* Not validated against the model list here — store.js knowing about
         ai.js would be a cycle, and it does not need to: an id nothing
         recognises resolves to the default at the point of use. Length-capped
         so a hand-edited file cannot stuff the settings blob. */
      if (typeof incomingSettings.aiModel === 'string' && incomingSettings.aiModel.length <= 64) {
        state.settings.aiModel = incomingSettings.aiModel;
      }
    }
    const folded = collapseHere();
    saveNow();
    return { added: incoming.length - folded, merged: folded, skipped: 0 };
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
  takeNotes(payload.notes);
  /* The loop above checks each incoming title against the library, not
     against the others arriving with it — a backup carrying the same film
     twice put both in. */
  const folded = collapseHere();
  saveNow();
  return { added: added - folded, merged: merged + folded, skipped: 0 };
}

/* ── setting up another phone ──
   One file that makes a second phone this one: the library, the film
   database key, the Claude key, and the sync repo with its token. Unlike a
   backup it carries secrets on purpose, so it has its own kind, is only
   ever read field by field, and says what it holds before it is applied. */

export function exportSetup() {
  const s = state.settings;
  const sync = s.sync || {};
  return {
    ...exportPayload(),
    kind: 'setup',
    setup: {
      provider: s.provider,
      dataKeys: { ...(s.dataKeys || {}) },
      keyStatus: { ...(s.keyStatus || {}) },
      aiKey: s.aiKey || '',
      aiModel: s.aiModel || '',
      sync: sync.repo && sync.token ? { repo: sync.repo, token: sync.token, path: sync.path || 'library.json' } : null,
    },
  };
}

/** The settings a setup file carries, checked field by field — or null if it
    is not one. Nothing outside this whitelist is ever taken from it. */
export function readSetup(payload) {
  if (!payload || payload.kind !== 'setup' || !payload.setup || typeof payload.setup !== 'object') return null;
  const x = payload.setup;
  const str = (v, max = 400) => (typeof v === 'string' && v.length <= max ? v.trim() : '');
  const out = { dataKeys: {}, keyStatus: {} };
  if (x.provider === 'tmdb' || x.provider === 'omdb') out.provider = x.provider;
  for (const id of ['tmdb', 'omdb']) {
    const k = str(x.dataKeys?.[id]);
    if (!k) continue;
    out.dataKeys[id] = k;
    const v = x.keyStatus?.[id];
    if (v && typeof v === 'object') out.keyStatus[id] = { ok: !!v.ok, message: str(v.message, 200), at: Number(v.at) || null };
  }
  out.aiKey = str(x.aiKey);
  out.aiModel = str(x.aiModel, 64);
  const repo = str(x.sync?.repo, 200);
  const token = str(x.sync?.token);
  out.sync = repo && token ? { repo, token, path: str(x.sync?.path, 200) || 'library.json' } : null;
  return out;
}

/** Make this phone the one the file came from. The library is merged, never
    replaced: anything already here stays. */
export function applySetup(payload) {
  const setup = readSetup(payload);
  if (!setup) return null;
  const s = state.settings;
  if (setup.provider) s.provider = setup.provider;
  s.dataKeys = { ...(s.dataKeys || {}), ...setup.dataKeys };
  s.keyStatus = { ...(s.keyStatus || {}), ...setup.keyStatus };
  if (setup.aiKey) s.aiKey = setup.aiKey;
  if (setup.aiModel) s.aiModel = setup.aiModel;
  if (setup.sync) s.sync = { ...(s.sync || {}), ...setup.sync, enabled: true };
  const library = readBackup(payload) ? importPayload(payload, 'merge') : { added: 0, merged: 0 };
  saveNow();
  return { setup, library };
}

/* ── sync ──
   What leaves the device, and what comes back. */

/**
 * The shareable half of the state.
 *
 * Items, the record of what has been deleted, and who lives here — because
 * `watchedBy` is keyed on person ids and means nothing on the other phone
 * without them.
 *
 * Deliberately not settings. Settings is where the API keys live, including
 * the token doing the syncing, and a library file is a thing that ends up in a
 * repo. `viewer` is also left out on purpose: which of you is holding this
 * phone is a property of the phone.
 */
export function syncSnapshot() {
  return {
    items: state.items,
    tombstones: Array.isArray(state.tombstones) ? state.tombstones : [],
    people: Array.isArray(state.settings.people) ? state.settings.people : [],
    notes: Array.isArray(state.notes) ? state.notes : [],
  };
}

/**
 * Adopt a merged snapshot.
 *
 * Writes the records through untouched — no makeItem, no re-stamping of
 * updatedAt. Stamping here would make every sync look like a local edit, and
 * two phones would push each other's changes back and forth forever.
 */
export function applySync(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.items)) return false;
  state.items = snapshot.items;
  state.tombstones = Array.isArray(snapshot.tombstones) ? snapshot.tombstones : [];
  if (Array.isArray(snapshot.notes)) state.notes = snapshot.notes;
  if (Array.isArray(snapshot.people)) {
    state.settings.people = snapshot.people;
    /* The person this phone was answering for may have been removed on the
       other one. Falling back to nobody is the same state as a household of
       one, which every screen already handles. */
    if (state.settings.viewer && !snapshot.people.some((p) => p.id === state.settings.viewer)) {
      state.settings.viewer = null;
    }
  }
  saveNow();
  emit('item');
  return true;
}

/* ── comments and Spotlight ── */

/* Comments from a file: added if new, never duplicated, never trusted
   further than their shape. */
function takeNotes(list) {
  if (!Array.isArray(list)) return;
  const have = new Set(state.notes.map((n) => n.id));
  for (const n of list) {
    if (!n || typeof n.id !== 'string' || typeof n.text !== 'string' || have.has(n.id)) continue;
    state.notes.push({
      id: n.id,
      uid: String(n.uid || ''),
      film: typeof n.film === 'string' ? n.film : null,
      text: n.text.slice(0, 2000),
      by: typeof n.by === 'string' ? n.by.slice(0, 40) : '',
      device: typeof n.device === 'string' ? n.device : '',
      at: Number(n.at) || 0,
    });
    have.add(n.id);
  }
}

export function me() {
  return { name: state.settings.name || '', device: state.settings.deviceId || '' };
}

export function setName(name) {
  state.settings.name = String(name || '').trim().slice(0, 40);
  saveNow();
}

/* A film's comments follow it by IMDb id as well as by uid: the same film
   added separately on each phone has two uids until the duplicates fold, and
   a comment must not go missing in between. */
export function notesFor(item) {
  if (!item) return [];
  const key = item.imdbId || null;
  return (state.notes || [])
    .filter((n) => n.uid === item.uid || (key && n.film === key))
    .sort((a, b) => a.at - b.at);
}

/** Comments from the other phone this phone has not read yet. */
export function unreadFor(item) {
  const mine = state.settings.deviceId;
  const seen = new Set(state.settings.seenNotes || []);
  return notesFor(item).filter((n) => n.device !== mine && !seen.has(n.id)).length;
}

export function unreadTotal() {
  return (state.items || []).reduce((sum, i) => sum + unreadFor(i), 0);
}

export function markThreadSeen(uidValue) {
  const item = byUid(uidValue);
  if (!item) return;
  state.settings.threadSeen = { ...(state.settings.threadSeen || {}), [uidValue]: Date.now() };
  const seen = new Set(state.settings.seenNotes || []);
  let added = false;
  for (const n of notesFor(item)) {
    if (!seen.has(n.id)) {
      seen.add(n.id);
      added = true;
    }
  }
  if (added) state.settings.seenNotes = prune([...seen]);
  save();
}

/* ── the inbox ──
   The other phone's comments and superlikes: what the bell lists and the app
   icon counts.
   Worked out from the shared notes every time, not kept as a list of its
   own — so a comment deleted over there goes from here too — with what this
   phone has read and cleared kept per phone, by id (never by time: the two
   phones' clocks disagree). */

export const INBOX_MAX = 60;

/* A superlike's id comes from the superlike itself, not the record: when
   two copies of a film fold into one (merge.js) the survivor's uid may
   differ, and one read here must not come back as new. */
const superId = (item) => `super:${item.superlike?.device || ''}:${item.superlike?.at || 0}`;

/* The read and cleared lists hold ids. They are pruned to ones that still
   exist, never to the newest N: forgetting an id that can still show makes
   it new again. */
function prune(list) {
  const live = new Set((state.notes || []).map((n) => n.id));
  for (const i of state.items) if (i.superlike) live.add(superId(i));
  return list.filter((id) => live.has(id));
}

function filmFor(n) {
  return byUid(n.uid) || (n.film ? state.items.find((i) => i.imdbId === n.film) : null) || null;
}

/**
 * Newest first, all of them: { id, kind: 'comment'|'superlike', at, by,
 * uid, title, item, text?, read }. The sheet draws the newest INBOX_MAX; the count, ×
 * and Clear all work on everything, or Clear all would leave the next sixty
 * behind.
 */
export function inbox() {
  const mine = state.settings.deviceId;
  const cleared = new Set(state.settings.inboxCleared || []);
  const seen = new Set(state.settings.seenNotes || []);
  const out = [];
  for (const n of state.notes || []) {
    if (!n.device || n.device === mine || cleared.has(n.id)) continue;
    const item = filmFor(n);
    if (!item) continue;
    out.push({ id: n.id, kind: 'comment', at: n.at, by: n.by || '', uid: item.uid, title: item.title, item, text: n.text, read: seen.has(n.id) });
  }
  const seenSupers = new Set(state.settings.seenSupers || []);
  for (const item of state.items) {
    const sup = item.superlike;
    if (!sup?.device || sup.device === mine) continue;
    const id = superId(item);
    if (cleared.has(id)) continue;
    out.push({ id, kind: 'superlike', at: sup.at, by: sup.by || '', uid: item.uid, title: item.title, item, read: seenSupers.has(id) });
  }
  return out.sort((a, b) => b.at - a.at);
}

/* Which list an entry is read in: comments share their thread's. */
const seenKey = (e) => (e.kind === 'superlike' ? 'seenSupers' : 'seenNotes');

/** A film's page seen: the other phone's superlike of it has been read. */
export function markSuperSeen(uidValue) {
  const item = byUid(uidValue);
  const sup = item?.superlike;
  if (!sup?.device || sup.device === state.settings.deviceId) return false;
  if (!remember('seenSupers', [superId(item)])) return false;
  save();
  return true;
}

/** How many in the inbox are unread: the number on the bell and the icon. */
export function inboxUnread() {
  return inbox().filter((e) => !e.read).length;
}

function remember(key, ids) {
  const set = new Set(state.settings[key] || []);
  let added = false;
  for (const id of ids) {
    if (!set.has(id)) {
      set.add(id);
      added = true;
    }
  }
  if (added) state.settings[key] = prune([...set]);
  return added;
}

/** One entry tapped: read, and on to the film or its thread. */
export function readInbox(id) {
  const entry = inbox().find((e) => e.id === id);
  if (entry && remember(seenKey(entry), [id])) saveNow();
  return entry || null;
}

/** Take one off the list (and count it read). */
export function clearInbox(id) {
  const entry = inbox().find((e) => e.id === id);
  if (!entry) return false;
  remember(seenKey(entry), [id]);
  remember('inboxCleared', [id]);
  saveNow();
  return true;
}

/** Clear the lot. What arrives afterwards still shows: cleared is by id. */
export function clearAllInbox() {
  const all = inbox();
  if (!all.length) return 0;
  remember('seenNotes', all.filter((e) => e.kind === 'comment').map((e) => e.id));
  remember('seenSupers', all.filter((e) => e.kind === 'superlike').map((e) => e.id));
  remember('inboxCleared', all.map((e) => e.id));
  saveNow();
  return all.length;
}

/* Something the other phone should hear about, worded here — where the
   film and the name are known — so the thing that sends it (a GitHub Action
   in the private repo, see notify.js) only has to pass it on. Carried by the
   next sync; see sync.js. Comments and superlikes (and the test). */
function queueNotify(kind, item, text = '', extra = {}) {
  const who = state.settings.name || 'Someone';
  const payload =
    kind === 'comment'
      ? { title: `${who} on ${item.title}`, body: text.length > 180 ? text.slice(0, 177) + '…' : text, url: `./#thread=${item.uid}`, tag: `thread-${item.uid}` }
      : kind === 'superlike'
        ? { title: `${who} superliked ${item.title}`, body: 'A must-watch — it is top of Spotlight.', url: `./#film=${item.uid}`, tag: `super-${item.uid}` }
        : { title: 'Watch Next', body: 'Notifications are working on this phone.', url: './', tag: 'test' };
  const q = Array.isArray(state.settings.pendingNotify) ? state.settings.pendingNotify : [];
  q.push({ kind, uid: item?.uid || null, noteId: extra.noteId || null, from: state.settings.deviceId, includeSelf: kind === 'test', at: Date.now(), payload });
  state.settings.pendingNotify = q.slice(-10);
}

/* A film taken off the list before the sync: nothing about it goes. */
function forgetQueued(uidValue) {
  unqueue((e) => e.uid === uidValue && e.kind !== 'test');
}

/* Taken back before it went: a deleted comment or an un-starred film must
   not still buzz the other phone. */
function unqueue(test) {
  state.settings.pendingNotify = (state.settings.pendingNotify || []).filter((e) => !test(e));
}

/** A notification to this phone as well as the other, to prove the path. */
export function queueTestNotify() {
  queueNotify('test', null);
  saveNow();
}

export function pendingNotify() {
  return (state.settings.pendingNotify || []).slice();
}

/** The first `count` have been carried; drop them. */
export function clearNotify(count) {
  state.settings.pendingNotify = (state.settings.pendingNotify || []).slice(count);
  /* Now, not on the save timer: an app closed in between would send the
     same notification again on its next launch. */
  saveNow();
}

/**
 * Comment on a film. Anything talked about joins Spotlight — the list the
 * two of you are deciding from — so a comment on a film nobody starred still
 * lands where the other person will see it.
 */
export function addNote(uidValue, text) {
  const item = byUid(uidValue);
  const body = String(text || '').trim().slice(0, 2000);
  if (!item || !body) return null;
  const note = {
    id: 'n' + uid(),
    uid: item.uid,
    film: item.imdbId || null,
    text: body,
    by: state.settings.name || '',
    device: state.settings.deviceId || '',
    at: Date.now(),
  };
  state.notes.push(note);
  if (!item.spotlight) {
    update(item.uid, { spotlight: { at: Date.now(), by: state.settings.name || '', device: state.settings.deviceId } });
  }
  state.settings.threadSeen = { ...(state.settings.threadSeen || {}), [item.uid]: Date.now() };
  queueNotify('comment', item, body, { noteId: note.id });
  saveNow();
  return note;
}

export function removeNote(id) {
  const idx = (state.notes || []).findIndex((n) => n.id === id);
  if (idx < 0) return false;
  state.notes.splice(idx, 1);
  bury(id);
  unqueue((e) => e.noteId === id);
  saveNow();
  return true;
}

export function setSpotlight(uidValue, on) {
  const item = byUid(uidValue);
  if (!item) return null;
  /* Out of Spotlight is out of the shortlist altogether: a superlike goes
     with it. */
  const next = update(uidValue, {
    spotlight: on ? { at: Date.now(), by: state.settings.name || '', device: state.settings.deviceId } : null,
    ...(on ? {} : { superlike: null }),
  });
  if (!on) unqueue((e) => e.kind === 'superlike' && e.uid === uidValue);
  saveNow();
  return next;
}

/** Superlike: "we have to watch this". Puts the film in Spotlight too. */
export function setSuperlike(uidValue, on) {
  const item = byUid(uidValue);
  if (!item) return null;
  const stamp = { at: Date.now(), by: state.settings.name || '', device: state.settings.deviceId };
  const next = update(uidValue, {
    superlike: on ? stamp : null,
    ...(on && !item.spotlight ? { spotlight: { ...stamp } } : {}),
  });
  if (on) queueNotify('superlike', item);
  else unqueue((e) => e.kind === 'superlike' && e.uid === uidValue);
  saveNow();
  return next;
}

/** The shortlist: starred and not yet watched, newest first. */
export function spotlit() {
  return (state.items || [])
    /* A watched film leaves the shortlist — unless someone has just said
       something about it that has not been read. */
    .filter((i) => i.spotlight && (!i.watched || unreadFor(i) > 0))
    /* Superliked first, then the newest. */
    .sort((a, b) => (b.superlike ? 1 : 0) - (a.superlike ? 1 : 0) || (b.spotlight.at || 0) - (a.spotlight.at || 0));
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
      /* The pile's hours — owned and never watched — because that is the
         number it sits under. Summing every unwatched title counted wishlist
         films against a headline about films you own. */
      all.filter((i) => i.owned && !i.watched).reduce((sum, i) => sum + (i.runtime || 0), 0) / 60
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

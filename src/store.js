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
    rating: partial.rating ?? null,
    runtime: partial.runtime ?? null,
    overview: partial.overview || '',
    poster: partial.poster || null,
    imdbId: partial.imdbId || null,

    quality: partial.quality || null,
    owned: partial.owned ?? false,

    watched: partial.watched ?? false,
    watchedAt: partial.watchedAt ?? null,
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
      omdbKey: '',
      aiKey: '',
      aiEnabled: false,
      libraryView: 'list',
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
  if (s.schema === SCHEMA) return s;
  /* future migrations land here, oldest first */
  s.schema = SCHEMA;
  return s;
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
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

export function init(seedFn) {
  state = read();

  if (!state.settings.seeded && !state.items.length && typeof seedFn === 'function') {
    state.items = seedFn().map(makeItem);
    state.settings.seeded = true;
    saveNow();
  } else if (state.migratedFrom) {
    /* A library was just imported from the old `wn_lib2` format. Write it out
       immediately — otherwise nothing persists until the user happens to make
       a change, and every reload re-runs the migration (regenerating uids and
       discarding anything derived since). The old key is deliberately left in
       place as a safety net. */
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
    saveNow();
    return { added: incoming.length, merged: 0, skipped: 0 };
  }

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
    saved: all.filter((i) => i.saved && !i.watched).length,
    owned: owned.length,
    movies: all.filter((i) => i.type === 'movie').length,
    shows: all.filter((i) => i.type === 'tv').length,
    hoursWatched: Math.round(
      watched.reduce((sum, i) => sum + (i.runtime || 0), 0) / 60
    ),
  };
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

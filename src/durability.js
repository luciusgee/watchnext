/*
 * Storage durability.
 *
 * The library is the only thing in this app that cannot be regenerated. Posters
 * re-fetch, metadata re-resolves, but nobody is re-entering 500 titles and
 * which ones they have watched.
 *
 * And localStorage is not safe by default. WebKit's Intelligent Tracking
 * Prevention deletes script-writable storage — localStorage, IndexedDB, service
 * worker caches — after seven days of Safari use without the user visiting the
 * site. Home-screen web apps are documented as exempt, but the WebKit issue
 * tracking whether persistence is genuinely honoured is still open, so that
 * exemption is not something to bet a user's data on.
 *
 * Three defences, in order of how much they help:
 *   1. Ask for persistent storage. Cheap, and on installed web apps it is
 *      usually granted, which takes the origin out of eviction entirely.
 *   2. Keep a second copy in IndexedDB. Does not survive a deliberate purge —
 *      ITP clears both — but it does survive the far more common case of
 *      localStorage being cleared, corrupted, or hitting quota.
 *   3. Tell the user the truth, and make exporting easy. This is the only
 *      defence that survives everything, so it is the one the UI nudges.
 */

const DB_NAME = 'watchnext';
const DB_VERSION = 1;
const STORE = 'backup';
const SNAPSHOT_KEY = 'state';

/* ── persistent storage ── */

let persistedCache = null;

/**
 * Ask the browser to exempt us from eviction. Safe to call repeatedly — it
 * resolves immediately once already granted.
 * @returns {Promise<{supported:boolean, persisted:boolean}>}
 */
export async function requestPersistence() {
  if (!navigator.storage?.persist) return { supported: false, persisted: false };
  try {
    if (await navigator.storage.persisted()) {
      persistedCache = true;
      return { supported: true, persisted: true };
    }
    const granted = await navigator.storage.persist();
    persistedCache = granted;
    return { supported: true, persisted: granted };
  } catch {
    return { supported: true, persisted: false };
  }
}

/** How much room we are using, when the browser will tell us. */
export async function storageEstimate() {
  if (!navigator.storage?.estimate) return null;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return { usage: usage ?? null, quota: quota ?? null };
  } catch {
    return null;
  }
}

export async function isPersisted() {
  if (persistedCache !== null) return persistedCache;
  if (!navigator.storage?.persisted) return false;
  try {
    persistedCache = await navigator.storage.persisted();
    return persistedCache;
  } catch {
    return false;
  }
}

/* ── IndexedDB mirror ── */

function openDb() {
  return new Promise((resolve, reject) => {
    if (!self.indexedDB) return reject(new Error('no indexedDB'));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('blocked'));
  });
}

/** Mirror a state snapshot. Failures are non-fatal — this is a second copy. */
export async function writeMirror(state) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ savedAt: Date.now(), state }, SNAPSHOT_KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    db.close();
    return true;
  } catch {
    return false;
  }
}

/** @returns {Promise<{savedAt:number, state:object}|null>} */
export async function readMirror() {
  try {
    const db = await openDb();
    const value = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(SNAPSHOT_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return value;
  } catch {
    return null;
  }
}

export async function clearMirror() {
  try {
    const db = await openDb();
    await new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(SNAPSHOT_KEY);
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
    db.close();
  } catch {
    /* nothing to clear */
  }
}

/* ── backup nudging ── */

const BACKUP_KEY = 'wn.lastBackupAt';
const NUDGE_AFTER_DAYS = 45;

export function markBackedUp(when = Date.now()) {
  try {
    localStorage.setItem(BACKUP_KEY, String(when));
  } catch {
    /* non-fatal */
  }
}

export function lastBackupAt() {
  try {
    const raw = localStorage.getItem(BACKUP_KEY);
    return raw ? parseInt(raw, 10) || null : null;
  } catch {
    return null;
  }
}

/**
 * Should we suggest a backup? Only when there is something worth losing —
 * nagging someone with an untouched seeded library is just noise.
 */
export function shouldNudgeBackup(stats) {
  if (!stats || stats.watched + stats.saved < 20) return false;
  const last = lastBackupAt();
  if (!last) return true;
  return Date.now() - last > NUDGE_AFTER_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * A plain-English summary for Settings. Honest about the risk rather than
 * reassuring — the failure mode here is silent and total.
 */
export async function storageHealth(stats) {
  const persisted = await isPersisted();
  const estimate = await storageEstimate();
  const mirror = await readMirror();
  const last = lastBackupAt();

  return {
    persisted,
    supported: !!navigator.storage?.persist,
    usage: estimate?.usage ?? null,
    quota: estimate?.quota ?? null,
    mirroredAt: mirror?.savedAt ?? null,
    lastBackupAt: last,
    nudge: shouldNudgeBackup(stats),
  };
}

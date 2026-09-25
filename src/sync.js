/*
 * Two phones, one shelf, no server.
 *
 * A private repo holds one file. Both devices read it, merge it into what they
 * have, and write it back. That is the whole design, and it is chosen over a
 * hosted database for two reasons that matter more here than latency does:
 * there is no account to make and no service to depend on, and every save is a
 * commit — so the answer to "how do I never lose it" is not "there is a copy"
 * but "there is every copy, and you can put any of them back".
 *
 * What it is not is instant. GitHub cannot push to a browser, so the other
 * phone's changes arrive on a poll — within about half a minute while the app
 * is open, and immediately when you bring it back to the foreground. For two
 * people putting films on a shelf that is indistinguishable from live. If it
 * ever needs to be genuinely live, this module is the thing to replace and
 * nothing else has to change, because everything above it talks to the store.
 *
 * The data never goes near the repo that serves the site. That one is public —
 * it has to be, for Pages on a free account — and a watch history is not.
 *
 * Correctness lives next door in merge.js, which is pure and tested on its
 * own. This file is only the plumbing: fetch, merge, write, and do not lose
 * anything when two writes race.
 */

import * as store from './store.js';
import { mergeLibraries, fingerprint } from './merge.js';

const API = 'https://api.github.com';

/* Long enough not to commit once per keystroke, short enough that putting the
   phone down after adding a film is enough to save it. */
const PUSH_DELAY = 4000;
/* Only ever runs while the app is in front of somebody. */
const POLL_EVERY = 30000;
/* A conflict means the other phone wrote between our read and our write. Re-read,
   re-merge, try again — bounded, because a loop that cannot fail is a loop that
   hammers someone's API quota when something unexpected happens. */
const MAX_ATTEMPTS = 4;

let pushTimer = null;
let pollTimer = null;
let running = false;
let started = false;

let state = { phase: 'off', at: null, message: '', lastOk: null };
/* When a sync last actually succeeded, kept across failures so an offline
   message can still say how fresh the shelf is. */
let lastOk = null;
const watchers = new Set();

/* ── configuration ── */

/**
 * "owner/name" from whatever was pasted. Copying the address bar on GitHub
 * gives https://github.com/owner/name — the natural thing to paste — and it
 * was rejected with "Use the owner/repo form."
 */
export function normaliseRepo(value) {
  return String(value || '')
    .trim()
    .replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .split('/')
    .slice(0, 2)
    .join('/');
}

export function config() {
  const s = store.settings().sync || {};
  return {
    repo: normaliseRepo(s.repo),
    token: (s.token || '').trim(),
    path: (s.path || 'library.json').trim(),
    enabled: Boolean(s.enabled),
  };
}

export function configured() {
  const c = config();
  return Boolean(c.enabled && c.repo && c.token && /^[^/\s]+\/[^/\s]+$/.test(c.repo));
}

export function status() {
  return { ...state };
}

export function watch(fn) {
  watchers.add(fn);
  return () => watchers.delete(fn);
}

function setStatus(phase, message = '') {
  if (phase === 'idle') lastOk = Date.now();
  state = { phase, at: Date.now(), message, lastOk };
  for (const fn of watchers) {
    try {
      fn(status());
    } catch {
      /* a broken status line must not break syncing */
    }
  }
}

/* ── base64 that survives an accented title ──
   btoa takes a binary string, not text, so anything outside Latin-1 throws.
   Chunked because apply() on a 300KB array overflows the call stack, which is
   exactly the size a real library reaches. */

function encode(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function decode(b64) {
  const binary = atob(String(b64).replace(/\s/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/* ── the API ── */

async function call(path, options = {}) {
  const c = config();
  const res = await fetch(`${API}/repos/${c.repo}/contents/${encodeURI(c.path)}${path}`, {
    ...options,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${c.token}`,
      'x-github-api-version': '2022-11-28',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
    },
  });
  return res;
}

/** The file as it stands, or null when it does not exist yet. */
async function readRemote() {
  /* Cache-busted: the contents API is served through a CDN and a stale read is
     a merge against a library that has already moved on. */
  const res = await call(`?ts=${Date.now()}`, { cache: 'no-store' });
  if (res.status === 404) return { snapshot: null, sha: null };
  if (!res.ok) throw await failure(res);
  const body = await res.json();
  let parsed = null;
  try {
    parsed = JSON.parse(decode(body.content || ''));
  } catch {
    /* Someone hand-edited the file into something unreadable. Treating that as
       "no remote" would overwrite it on the next push, so refuse instead. */
    throw Object.assign(new Error('The library file in the repo is not readable JSON.'), { fatal: true });
  }
  return { snapshot: parsed, sha: body.sha || null };
}

async function writeRemote(snapshot, sha, note) {
  const payload = {
    app: 'watchnext',
    updatedAt: new Date().toISOString(),
    ...snapshot,
  };
  const res = await call('', {
    method: 'PUT',
    body: JSON.stringify({
      message: note,
      content: encode(JSON.stringify(payload, null, 1)),
      ...(sha ? { sha } : {}),
    }),
  });
  /* 409 is the documented conflict; 422 is what the API actually returns when
     the sha is stale, which is not the same thing as a bad request. */
  if (res.status === 409 || res.status === 422) return false;
  if (!res.ok) throw await failure(res);
  return true;
}

async function failure(res) {
  const body = await res.json().catch(() => ({}));
  const detail = body?.message || `HTTP ${res.status}`;
  const err = new Error(detail);
  err.status = res.status;
  if (res.status === 401) err.friendly = 'GitHub rejected that token. Check it in Settings.';
  else if (res.status === 403) err.friendly = /rate limit/i.test(detail)
    ? 'GitHub rate limit reached — it will catch up shortly.'
    : 'That token is not allowed to write to this repo.';
  else if (res.status === 404) err.friendly = 'Repo not found, or the token cannot see it.';
  /* Never GitHub's raw text: "HTTP 502" in red on the Settings screen says
     nothing a person can act on. */
  else err.friendly = res.status >= 500 ? 'GitHub is having trouble. Sync will retry.' : 'Sync hit a problem and will retry.';
  return err;
}

/* ── other files in the repo ──
   The library is one file; notifications need a few more beside it — each
   phone's push address, the Action that sends them, and an outbox. Same
   token, same repo. */

function contentsUrl(path) {
  const c = config();
  return `${API}/repos/${c.repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
}

function headers(extra = {}) {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${config().token}`,
    'x-github-api-version': '2022-11-28',
    ...extra,
  };
}

/** Read a file in the sync repo: its text, or null when it is not there. */
export async function readRepoFile(path) {
  const res = await fetch(`${contentsUrl(path)}?ts=${Date.now()}`, { headers: headers(), cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw await failure(res);
  const body = await res.json();
  return { text: decode(body.content || ''), sha: body.sha };
}

/**
 * Create or replace a file in the sync repo. Leaves it alone if it already
 * says exactly this — every write is a commit, and a commit can start an
 * Action. Errors carry the HTTP status: a 403 on .github/workflows means the
 * token lacks the Workflows permission.
 */
export async function putRepoFile(path, text, message) {
  if (!config().repo || !config().token) throw Object.assign(new Error('Sync is not set up'), { code: 'nosync' });
  for (let attempt = 0; attempt < 3; attempt++) {
    const held = await readRepoFile(path);
    if (held && held.text === text) return { changed: false };
    const res = await fetch(contentsUrl(path), {
      method: 'PUT',
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ message, content: encode(text), ...(held ? { sha: held.sha } : {}) }),
    });
    if (res.status === 409 || res.status === 422) continue;
    if (!res.ok) throw await failure(res);
    return { changed: true };
  }
  throw new Error('Kept colliding with the other phone.');
}

export async function deleteRepoFile(path, message) {
  const held = await readRepoFile(path).catch(() => null);
  if (!held) return false;
  const res = await fetch(contentsUrl(path), {
    method: 'DELETE',
    headers: headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ message, sha: held.sha }),
  });
  return res.ok;
}

/* What this phone has done that the other should hear about — a comment, a
   Spotlight — goes up after the library, as a small outbox file whose commit
   message carries [notify]. The Action in the repo runs on that and sends
   the push; see notify.js. After the library, so the comment is already
   there when the other phone opens to read it. */
async function flushNotify() {
  const events = store.pendingNotify();
  if (!events.length) return;
  const first = events[0].payload?.title || 'Watch Next';
  await putRepoFile(
    'notify/last.json',
    JSON.stringify({ at: Date.now(), events }, null, 1),
    `[notify] ${first}${events.length > 1 ? ` (+${events.length - 1})` : ''}`
  );
  store.clearNotify(events.length);
}

/* ── the loop ── */

/**
 * One full exchange: read, merge, adopt, write back if we changed anything.
 *
 * Returns true when something actually moved, which is what the caller uses to
 * decide whether it is worth saying so.
 */
export async function syncNow({ note = 'Update library' } = {}) {
  if (!configured() || running) return false;
  running = true;
  setStatus('syncing');

  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const { snapshot: remote, sha } = await readRemote();
      const local = store.syncSnapshot();

      const merged = mergeLibraries(local, remote || {});
      const mergedPrint = fingerprint(merged);
      const changedHere = mergedPrint !== fingerprint(local);
      const changedThere = !remote || mergedPrint !== fingerprint(remote);

      /* Adopt before writing. If the write fails we still have their changes,
         and the next attempt merges from a more complete position. */
      if (changedHere) store.applySync(merged);

      if (!changedThere) {
        await flushNotify().catch(() => {});
        setStatus('idle', changedHere ? 'Updated from the other device' : '');
        return changedHere;
      }

      if (await writeRemote(merged, sha, note)) {
        await flushNotify().catch(() => {});
        setStatus('idle', '');
        return true;
      }
      /* Lost the race. Go round again against what they just wrote. */
    }
    setStatus('error', 'Kept colliding with the other device. It will retry.');
    return false;
  } catch (err) {
    /* Offline is a state, not an error. iOS words a failed fetch "Load failed",
       and that raw string used to replace "Last synced" in red every time the
       app was opened without signal. */
    const offline = navigator.onLine === false || err instanceof TypeError;
    if (offline) setStatus('offline', 'Offline — changes will sync when you’re back online.');
    else setStatus('error', err.friendly || err.message || 'Sync failed');
    return false;
  } finally {
    running = false;
  }
}

function schedulePush() {
  if (!configured()) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => syncNow({ note: 'Update library' }), PUSH_DELAY);
}

/**
 * Wire it up. Idempotent, so Settings can call it again after the repo or the
 * token changes without stacking a second set of timers.
 */
export function start() {
  if (!started) {
    started = true;

    store.subscribe((reason) => {
      /* 'item' covers every library mutation. A settings change is not
         something the other phone needs, and syncing on it would mean typing a
         token triggered a push with a half-typed token. */
      if (reason === 'item') schedulePush();
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        poll();
        if (navigator.onLine !== false) syncNow({ note: 'Update library' });
      } else {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    });

    window.addEventListener('online', () => syncNow({ note: 'Update library' }));
  }

  poll();
  if (configured()) syncNow({ note: 'Update library' });
  else setStatus('off');
}

function poll() {
  clearInterval(pollTimer);
  pollTimer = null;
  if (!configured()) return;
  pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible' && navigator.onLine !== false) {
      syncNow({ note: 'Update library' });
    }
  }, POLL_EVERY);
}

/** Does this repo and token actually work? Used by the Settings button. */
export async function check() {
  const c = config();
  if (!c.repo || !c.token) return { ok: false, message: 'Repo and token are both needed.' };
  if (!/^[^/\s]+\/[^/\s]+$/.test(c.repo)) return { ok: false, message: 'Use the owner/repo form.' };
  try {
    const res = await fetch(`${API}/repos/${c.repo}`, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${c.token}`,
        'x-github-api-version': '2022-11-28',
      },
    });
    if (!res.ok) {
      const err = await failure(res);
      return { ok: false, message: err.friendly };
    }
    const repo = await res.json();
    if (!repo.permissions?.push) {
      return { ok: false, message: 'That token can read this repo but not write to it.' };
    }
    /* Worth saying out loud rather than discovering on github.com later. */
    if (repo.private === false) {
      return { ok: true, warning: 'That repo is public — anyone can read your library.' };
    }
    return { ok: true };
  } catch {
    return { ok: false, message: 'Could not reach GitHub. Check your connection.' };
  }
}

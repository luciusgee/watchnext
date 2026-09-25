/*
 * Notifications: a comment or a Spotlight on one phone, a buzz on the other.
 *
 * An iPhone home-screen web app can receive Web Push (iOS 16.4 and later),
 * but something has to send it, and GitHub Pages cannot: it serves files, it
 * runs nothing. Apple's push endpoint will not take a request from a web page
 * either — no CORS, and the signing key would be sitting in the page. So the
 * sender is a GitHub Action in the same private repo the library syncs to:
 *
 *   1. Turning notifications on here subscribes this phone with its own VAPID
 *      key pair, made on the phone, and writes push/<device>.json — the push
 *      address and the key to sign for it — into the repo.
 *   2. It also writes the Action (.github/workflows/watchnext-notify.yml) and
 *      the script it runs, if they are not there yet. Writing a workflow file
 *      needs the token's "Workflows: Read and write" permission, on top of
 *      the "Contents" one sync already has; without it GitHub says 403, and
 *      the Settings row says exactly which box to tick.
 *   3. A comment or a Spotlight is queued (store.js), carried up by the next
 *      sync as notify/last.json with "[notify]" in the commit message
 *      (sync.js), and the Action — which only starts for commits that say
 *      [notify] — sends it to every phone but the one it came from.
 *
 * The keys in push/*.json can do one thing: send a notification to these two
 * phones. They live in a private repo only the two of you can read.
 */

import * as store from './store.js';
import * as sync from './sync.js';

const WORKFLOW_PATH = '.github/workflows/watchnext-notify.yml';
const SCRIPT_PATH = '.github/watchnext-notify.mjs';

export const WORKFLOW = `# Sends Watch Next notifications. Written by the app — see src/notify.js.
# Runs only for commits whose message says [notify]: a comment or a
# Spotlight on one phone. Everything else skips without starting a runner.
name: Watch Next notifications
on: push
permissions:
  contents: read
jobs:
  send:
    if: contains(github.event.head_commit.message, '[notify]')
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm install --no-save --no-package-lock web-push@3.6.7
      - run: node ${SCRIPT_PATH}
`;

export const SCRIPT = `// Sends Watch Next notifications. Written by the app — see src/notify.js.
// Reads notify/last.json (what happened) and push/*.json (who to tell).
import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';

const read = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
const outbox = read('notify/last.json') || { events: [] };
const devices = fs.existsSync('push')
  ? fs.readdirSync('push').filter((f) => f.endsWith('.json')).map((f) => read(path.join('push', f))).filter(Boolean)
  : [];

let sent = 0;
for (const event of outbox.events || []) {
  const payload = JSON.stringify(event.payload || {});
  for (const d of devices) {
    if (!d.enabled || !d.subscription?.endpoint || !d.vapid?.publicKey || !d.vapid?.privateKey) continue;
    if (d.device === event.from && !event.includeSelf) continue;
    try {
      await webpush.sendNotification(d.subscription, payload, {
        TTL: 60 * 60 * 24,
        urgency: 'high',
        vapidDetails: { subject: d.subject, publicKey: d.vapid.publicKey, privateKey: d.vapid.privateKey },
      });
      sent += 1;
      console.log('sent to', d.name || d.device);
    } catch (err) {
      console.log('could not send to', d.name || d.device, err.statusCode || '', err.body || err.message);
    }
  }
}
console.log(sent, 'sent');
`;

/* ── what this phone can do ── */

export function standalone() {
  return (
    (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches) ||
    navigator.standalone === true
  );
}

export function supported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/**
 * Where this phone stands, for the Settings row:
 *  'unsupported' | 'home-screen' | 'no-sync' | 'denied' | 'off' | 'on'
 */
export function state() {
  if (!supported()) return standalone() ? 'unsupported' : 'home-screen';
  if (!sync.configured()) return 'no-sync';
  if (Notification.permission === 'denied') return 'denied';
  return store.settings().push?.enabled && Notification.permission === 'granted' ? 'on' : 'off';
}

/* ── keys ──
   A VAPID key pair per phone, made here with WebCrypto: the public half in
   the form pushManager.subscribe wants (65 raw bytes, base64url), the private
   half as the 32-byte scalar web-push signs with. */

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

function fromB64url(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export async function makeKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const raw = await crypto.subtle.exportKey('raw', pair.publicKey);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { publicKey: b64url(raw), privateKey: jwk.d };
}

/* Everything the tap needs, found before the tap. */
let ready = { reg: null, sub: null };

/**
 * Made ahead of the tap. iOS wants pushManager.subscribe called straight
 * from the tap that asked for it — Apple: "call the push subscription method
 * immediately from the gesture's event handler" — so the key, the service
 * worker registration and any existing subscription are all looked up here,
 * when Settings shows the row, and the tap's first await is the subscribe.
 */
export async function prepare() {
  if (!supported()) return null;
  let vapid = store.settings().push?.vapid;
  try {
    if (!vapid?.publicKey || !vapid?.privateKey) {
      vapid = await makeKeys();
      store.updateSettings({ push: { ...(store.settings().push || {}), vapid } });
    }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    /* A subscription made with a different key cannot be signed for. */
    const current = sub?.options?.applicationServerKey;
    if (sub && current && b64url(current) !== vapid.publicKey) {
      await sub.unsubscribe();
      sub = null;
    }
    ready = { reg, sub };
  } catch {
    /* the row says it could not be set up */
  }
  return vapid;
}

/* The address Apple checks in the signing claim: it must be https (or
   mailto), and a real one. This app's own page. */
function subject() {
  const here = new URL('./', location.href).href;
  return here.startsWith('https://') ? here : 'https://luciusgee.github.io/watchnext/';
}

/**
 * Turn notifications on. Call from the tap itself.
 * Resolves to { ok, step?, error? } — `step` names what is missing:
 *   'permission' | 'keys' | 'subscribe' | 'device' | 'workflow'
 */
export async function enable() {
  const vapid = store.settings().push?.vapid;
  if (!vapid?.publicKey) return { ok: false, step: 'keys' };

  let subscription;
  try {
    if (!ready.reg) return { ok: false, step: 'subscribe', error: 'The app is still starting — try again in a moment.' };
    /* The first await after the tap. On iOS this is the call that asks for
       permission. */
    const sub = ready.sub || (await ready.reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64url(vapid.publicKey) }));
    ready.sub = sub;
    subscription = sub.toJSON();
  } catch (err) {
    if (typeof Notification !== 'undefined' && Notification.permission === 'denied') return { ok: false, step: 'permission' };
    return { ok: false, step: 'subscribe', error: err?.message || String(err) };
  }

  const me = store.me();
  try {
    await sync.putRepoFile(
      `push/${me.device}.json`,
      JSON.stringify(
        {
          device: me.device,
          name: me.name || '',
          enabled: true,
          subject: subject(),
          subscription,
          vapid,
          at: new Date().toISOString(),
        },
        null,
        1
      ),
      `Notifications on for ${me.name || 'a phone'}`
    );
  } catch (err) {
    return { ok: false, step: 'device', error: err?.friendly || err?.message };
  }
  /* On only once the other phone can find this one: marked before the file
     was written, a failed write left the row saying "On" with nothing in the
     repo to send to. */
  store.updateSettings({ push: { ...(store.settings().push || {}), enabled: true, endpoint: subscription.endpoint } });
  store.saveNow();

  return installSender();
}

/** Put the Action and its script in the repo, if they are not already. */
export async function installSender() {
  try {
    await sync.putRepoFile(SCRIPT_PATH, SCRIPT, 'Watch Next: notification sender');
  } catch (err) {
    return { ok: false, step: 'device', error: err?.friendly || err?.message };
  }
  try {
    await sync.putRepoFile(WORKFLOW_PATH, WORKFLOW, 'Watch Next: notification workflow');
  } catch (err) {
    if (err?.status === 403 || err?.status === 404) return { ok: false, step: 'workflow' };
    return { ok: false, step: 'workflow', error: err?.friendly || err?.message };
  }
  store.updateSettings({ push: { ...(store.settings().push || {}), sender: true } });
  store.saveNow();
  return { ok: true };
}

export async function disable() {
  const me = store.me();
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    await sub?.unsubscribe();
  } catch {
    /* already gone */
  }
  ready.sub = null;
  store.updateSettings({ push: { ...(store.settings().push || {}), enabled: false, endpoint: null } });
  store.saveNow();
  await sync.deleteRepoFile(`push/${me.device}.json`, `Notifications off for ${me.name || 'a phone'}`).catch(() => {});
}

/** Queue a notification to every phone, this one included, and send it. */
export async function test() {
  store.queueTestNotify();
  await sync.syncNow({ note: 'Update library' });
}

/* ── the badge ──
   Comments from the other phone not yet read, on the app icon. */
export function paintBadge() {
  try {
    const n = store.unreadTotal();
    if (n && 'setAppBadge' in navigator) navigator.setAppBadge(n).catch(() => {});
    else if ('clearAppBadge' in navigator) navigator.clearAppBadge().catch(() => {});
    /* The service worker counts up from here when a comment arrives with the
       app closed (sw.js bumpBadge). */
    if ('caches' in self) caches.open('watchnext-badge').then((c) => c.put('./badge-count', new Response(String(n)))).catch(() => {});
  } catch {
    /* the badge is a nicety */
  }
}

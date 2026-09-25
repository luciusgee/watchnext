/*
 * The Action that sends notifications, run for real.
 *
 * The script the app writes into the repo (src/notify.js, SCRIPT) is run
 * here with the same web-push version the workflow installs, against a local
 * server standing in for Apple's push service. Keys are made the way the
 * phone makes them — WebCrypto P-256, raw public key, JWK private scalar —
 * and each push is checked end to end: sent to the right phones and not the
 * one it came from, signed with that phone's key for that endpoint's origin,
 * and decryptable by the receiving phone into exactly the notification the
 * app worded.
 *
 * Needs npm to fetch web-push the first time; skips (and says so) without it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

const here = path.dirname(new URL(import.meta.url).pathname);
const source = fs.readFileSync(path.join(here, '../src/notify.js'), 'utf8');
const SCRIPT = source.match(/export const SCRIPT = `([\s\S]*?)`;/)[1];
const WORKFLOW_VERSION = source.match(/web-push@([\d.]+)/)[1];

/* web-push, the version the workflow pins, installed once into a cache. */
const cache = path.join(os.tmpdir(), `wn-webpush-${WORKFLOW_VERSION}`);
if (!fs.existsSync(path.join(cache, 'node_modules/web-push'))) {
  try {
    fs.mkdirSync(cache, { recursive: true });
    execFileSync('npm', ['install', '--prefix', cache, '--no-save', '--no-package-lock', '--silent', `web-push@${WORKFLOW_VERSION}`], { stdio: 'pipe', timeout: 120000 });
  } catch (err) {
    console.log(`  skip  web-push@${WORKFLOW_VERSION} could not be installed (${err.message.split('\n')[0]}) — the Action is untested here`);
    process.exit(0);
  }
}
const require = createRequire(path.join(cache, 'node_modules/'));
const ece = require('http_ece');

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/* A phone's VAPID keys, exactly as notify.js makeKeys() makes them. */
async function vapidKeys() {
  const { subtle } = globalThis.crypto;
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const raw = await subtle.exportKey('raw', pair.publicKey);
  const jwk = await subtle.exportKey('jwk', pair.privateKey);
  return { publicKey: b64url(raw), privateKey: jwk.d };
}

/* A phone's subscription: the browser's ECDH key and auth secret. */
function subscriber() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return { ecdh, auth, keys: { p256dh: b64url(ecdh.getPublicKey()), auth: b64url(auth) } };
}

/* Apple, standing in: records every push. HTTPS, because web-push only
   speaks HTTPS — a throwaway certificate, trusted by the script's process
   alone (NODE_TLS_REJECT_UNAUTHORIZED, set only for that child below). */
const tls = fs.mkdtempSync(path.join(os.tmpdir(), 'wn-tls-'));
try {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
    '-keyout', path.join(tls, 'key.pem'), '-out', path.join(tls, 'cert.pem')], { stdio: 'pipe' });
} catch (err) {
  console.log('  skip  openssl is needed for a local HTTPS push service — the Action is untested here');
  process.exit(0);
}
const received = [];
const server = https.createServer({ key: fs.readFileSync(path.join(tls, 'key.pem')), cert: fs.readFileSync(path.join(tls, 'cert.pem')) }, (req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    received.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    const gone = req.url.includes('gone');
    res.writeHead(gone ? 410 : 201).end();
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `https://127.0.0.1:${server.address().port}`;

async function device(id, name, { enabled = true, endpoint } = {}) {
  const sub = subscriber();
  return {
    file: {
      device: id,
      name,
      enabled,
      subject: 'https://luciusgee.github.io/watchnext/',
      subscription: { endpoint: endpoint || `${origin}/push/${id}`, keys: sub.keys },
      vapid: await vapidKeys(),
    },
    sub,
  };
}

function run(repo) {
  fs.mkdirSync(path.join(repo, '.github'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.github/watchnext-notify.mjs'), SCRIPT);
  fs.rmSync(path.join(repo, 'node_modules'), { force: true, recursive: true });
  fs.symlinkSync(path.join(cache, 'node_modules'), path.join(repo, 'node_modules'), 'dir');
  return new Promise((resolve) => {
    import('node:child_process').then(({ execFile }) =>
      execFile('node', ['.github/watchnext-notify.mjs'], { cwd: repo, timeout: 30000, env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0', NODE_NO_WARNINGS: '1' } }, (err, stdout, stderr) =>
        resolve({ code: err ? err.code || 1 : 0, out: stdout + stderr })
      )
    );
  });
}

function repoWith(devices, events) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wn-repo-'));
  fs.mkdirSync(path.join(repo, 'push'));
  fs.mkdirSync(path.join(repo, 'notify'));
  for (const d of devices) fs.writeFileSync(path.join(repo, 'push', `${d.file.device}.json`), JSON.stringify(d.file));
  fs.writeFileSync(path.join(repo, 'notify/last.json'), JSON.stringify({ at: Date.now(), events }));
  return repo;
}

function verifyJwt(authHeader, publicKey) {
  const m = /^vapid t=([^,]+),\s*k=(.+)$/.exec(authHeader || '');
  if (!m) return { ok: false, why: 'no vapid header' };
  const [h, p, s] = m[1].split('.');
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  const key = crypto.createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: b64url(Buffer.from(publicKey, 'base64url').subarray(1, 33)), y: b64url(Buffer.from(publicKey, 'base64url').subarray(33, 65)) },
    format: 'jwk',
  });
  const ok = crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
  return { ok, claims, k: m[2] };
}

console.log('\n─── a comment ───');
{
  const luke = await device('dLUKE', 'Luke');
  const sam = await device('dSAM', 'Sam');
  const payload = { title: 'Luke on Alien', body: 'Saturday?', url: './#thread=w1', tag: 'thread-w1' };
  const repo = repoWith([luke, sam], [{ kind: 'comment', from: 'dLUKE', includeSelf: false, at: 1, payload }]);
  received.length = 0;
  const r = await run(repo);
  check('the script runs cleanly', r.code === 0, r.out);
  check('one push, to Sam — not back to Luke', received.length === 1 && received[0].url === '/push/dSAM', JSON.stringify(received.map((x) => x.url)));
  const push = received[0];
  check('encrypted the way browsers expect (aes128gcm)', push?.headers['content-encoding'] === 'aes128gcm');
  check('kept for a day if the phone is off, and marked urgent', push?.headers.ttl === '86400' && push?.headers.urgency === 'high', JSON.stringify(push?.headers));
  const jwt = verifyJwt(push?.headers.authorization, sam.file.vapid.publicKey);
  check('signed with Sam’s phone’s own key — the one it subscribed with', jwt.ok && jwt.k === sam.file.vapid.publicKey, jwt.why || '');
  check('for this push service, as the app’s https address', jwt.claims?.aud === origin && jwt.claims?.sub === 'https://luciusgee.github.io/watchnext/', JSON.stringify(jwt.claims));
  let clear = null;
  try {
    clear = JSON.parse(ece.decrypt(push.body, { version: 'aes128gcm', privateKey: sam.sub.ecdh, authSecret: sam.sub.auth }).toString());
  } catch (err) {
    clear = { error: err.message };
  }
  check('and Sam’s phone can decrypt it into exactly what the app wrote', JSON.stringify(clear) === JSON.stringify(payload), JSON.stringify(clear));
}

console.log('\n─── a test, and phones that cannot take one ───');
{
  const luke = await device('dLUKE', 'Luke');
  const sam = await device('dSAM', 'Sam', { enabled: false });
  const old = await device('dOLD', 'Old phone', { endpoint: `${origin}/push/gone` });
  const repo = repoWith([luke, sam, old], [{ kind: 'test', from: 'dLUKE', includeSelf: true, at: 1, payload: { title: 'Watch Next', body: 'Notifications are working on this phone.' } }]);
  received.length = 0;
  const r = await run(repo);
  check('a test reaches the phone that sent it', received.some((x) => x.url === '/push/dLUKE'));
  check('a phone with notifications off is skipped', !received.some((x) => x.url === '/push/dSAM'));
  check('a phone whose subscription has gone does not stop the others', r.code === 0 && /could not send to Old phone 410/.test(r.out), r.out);
}

console.log('\n─── nothing to send ───');
{
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wn-repo-'));
  received.length = 0;
  const r = await run(repo);
  check('an empty repo sends nothing and does not fail', r.code === 0 && received.length === 0 && /0 sent/.test(r.out), r.out);
}

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFailures:'); failures.forEach((f) => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);

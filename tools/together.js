/*
 * Two phones, deciding together.
 *
 * Luke's phone and Sam's, against an in-memory GitHub that holds any number
 * of files and keeps every commit message: comments and Spotlight travel
 * both ways and a deleted comment stays deleted; Tonight says what is new;
 * and turning notifications on writes each phone's push address and the
 * Action that sends them — asking for the Workflows permission when the
 * token does not have it — after which a comment goes up as a [notify]
 * commit for that Action to run on.
 */
const { chromium, devices } = require('/opt/node22/lib/node_modules/playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_URL = 'http://127.0.0.1:8899/index.html';
const REPO = 'luke/watchnext-data';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

/* ── GitHub, with files and commits ── */
const files = new Map(); // path -> { text, sha }
const commits = []; // { path, message }
let nextSha = 1;
let allowWorkflows = false;
let failPush = false; // push/*.json writes fail, as a lost connection would
const b64 = (t) => Buffer.from(t, 'utf8').toString('base64');
const unb64 = (t) => Buffer.from(t, 'base64').toString('utf8');

async function githubRoute(route) {
  const req = route.request();
  const url = new URL(req.url());
  const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  if (/\/repos\/[^/]+\/[^/]+$/.test(url.pathname)) return json(200, { private: true, permissions: { push: true } });
  const m = url.pathname.match(/\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/);
  if (!m) return json(404, { message: 'Not Found' });
  const p = decodeURIComponent(m[1]);
  const held = files.get(p);
  if (req.method() === 'GET') {
    return held ? json(200, { content: b64(held.text), sha: held.sha, encoding: 'base64' }) : json(404, { message: 'Not Found' });
  }
  const body = JSON.parse(req.postData() || '{}');
  if (p.startsWith('push/') && failPush) return json(500, { message: 'Server Error' });
  if (p.startsWith('.github/workflows/') && !allowWorkflows) {
    return json(403, { message: 'Resource not accessible by personal access token' });
  }
  if ((body.sha || null) !== (held?.sha || null)) return json(409, { message: 'does not match' });
  if (req.method() === 'PUT') {
    files.set(p, { text: unb64(body.content), sha: `sha${nextSha++}` });
    commits.push({ path: p, message: body.message });
    return json(200, { content: { sha: files.get(p).sha } });
  }
  if (req.method() === 'DELETE') {
    files.delete(p);
    commits.push({ path: p, message: body.message, deleted: true });
    return json(200, {});
  }
  return json(405, {});
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  const errors = [];

  async function phone(name, { sample = false } = {}) {
    const ctx = await browser.newContext({ ...devices['iPhone 13 Pro'] });
    await ctx.route('**://api.github.com/**', githubRoute);
    await ctx.route(/image\.tmdb\.org|m\.media-amazon\.com|api\.themoviedb\.org|omdbapi\.com|api\.anthropic\.com/, (r) => r.abort());
    /* Push, as a home-screen app on iOS offers it: a subscription with real
       P-256 keys (so the Action's encryption can be checked against it), and
       a permission that becomes "granted" once asked. */
    await ctx.addInitScript(() => {
      window.__perm = 'default';
      try {
        Object.defineProperty(Notification, 'permission', { configurable: true, get: () => window.__perm });
      } catch {}
      const fakeSub = async (options) => {
        const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
        const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
        const priv = await crypto.subtle.exportKey('jwk', pair.privateKey);
        const auth = crypto.getRandomValues(new Uint8Array(16));
        const u = (b) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const id = Math.random().toString(36).slice(2);
        window.__subPrivate = { jwk: priv, auth: u(auth), p256dh: u(raw) };
        window.__subscribedWith = options.applicationServerKey;
        return {
          endpoint: `https://web.push.apple.com/fake-${id}`,
          options: { applicationServerKey: options.applicationServerKey.buffer || options.applicationServerKey },
          toJSON() { return { endpoint: this.endpoint, keys: { p256dh: u(raw), auth: u(auth) } }; },
          unsubscribe: async () => true,
        };
      };
      window.__fakeReg = {
        pushManager: {
          getSubscription: async () => window.__sub || null,
          subscribe: async (options) => {
            window.__perm = 'granted';
            window.__sub = await fakeSub(options);
            return window.__sub;
          },
        },
      };
      if (navigator.serviceWorker) {
        Object.defineProperty(navigator.serviceWorker, 'ready', { configurable: true, get: () => Promise.resolve(window.__fakeReg) });
      }
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    await page.goto(APP_URL, { waitUntil: 'networkidle' });
    await page.waitForSelector('body.is-ready');
    await page.evaluate(({ sample, name }) => {
      if (sample) window.__test.loadSample();
      const st = JSON.parse(localStorage.getItem('wn.state.v3'));
      st.settings.name = name;
      st.settings.sync = { repo: 'luke/watchnext-data', token: 'github_pat_test', path: 'library.json', enabled: true };
      localStorage.setItem('wn.state.v3', JSON.stringify(st));
    }, { sample, name });
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('body.is-ready');
    return { ctx, page };
  }
  const syncNow = (page) => page.evaluate(async () => (await import('./src/sync.js')).syncNow());
  const st = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('wn.state.v3')));

  console.log('\n─── a comment goes from one phone to the other ───');
  const luke = await phone('Luke', { sample: true });
  await syncNow(luke.page);
  const sam = await phone('Sam');
  await syncNow(sam.page);
  check('both phones have the library', (await sam.page.evaluate(() => window.__test.count())) === (await luke.page.evaluate(() => window.__test.count())));

  const film = await luke.page.evaluate(async () => {
    const s = await import('./src/store.js');
    const it = s.items().find((i) => !i.watched);
    s.addNote(it.uid, 'Saturday? It looks like the one we watched last week.');
    s.emit('item');
    return { uid: it.uid, title: it.title };
  });
  await syncNow(luke.page);
  const outbox = files.get('notify/last.json');
  const notifyCommit = commits.filter((c) => c.path === 'notify/last.json').pop();
  check('the comment goes up with the library', JSON.parse(files.get('library.json').text).notes.some((n) => n.text.startsWith('Saturday?')));
  check('and a notification for the Action goes up after it, marked [notify]', !!outbox && /^\[notify\] Luke on /.test(notifyCommit?.message || '') &&
    commits.findIndex((c) => c === notifyCommit) > commits.map((c) => c.path).lastIndexOf('library.json') - 1, notifyCommit?.message);
  const ev = outbox && JSON.parse(outbox.text).events[0];
  check('worded for the other phone: who, which film, what they said', ev && ev.payload.title === `Luke on ${film.title}` && ev.payload.body.startsWith('Saturday?') && ev.payload.url === `./#thread=${film.uid}`, JSON.stringify(ev));
  check('and it is not sent back to the phone it came from', ev && !ev.includeSelf && ev.from === (await st(luke.page)).settings.deviceId);
  check('the outbox is emptied once it has gone', (await st(luke.page)).settings.pendingNotify.length === 0);

  await syncNow(sam.page);
  const samView = await sam.page.evaluate((uid) => {
    const s = window.__test;
    const it = s.byUid(uid);
    return { spot: !!it?.spotlight, unread: 0 };
  }, film.uid);
  const samNotes = await sam.page.evaluate(async (uid) => {
    const s = await import('./src/store.js');
    const it = s.byUid(uid);
    return { notes: s.notesFor(it).map((n) => [n.by, n.text]), unread: s.unreadFor(it), total: s.unreadTotal() };
  }, film.uid);
  check('Sam’s phone has the comment, signed Luke', samNotes.notes.length === 1 && samNotes.notes[0][0] === 'Luke', JSON.stringify(samNotes));
  check('and the film in Spotlight', samView.spot);
  check('counted as new until it is read', samNotes.unread === 1 && samNotes.total === 1, JSON.stringify(samNotes));
  await sam.page.tap('[data-tab="tonight"]');
  await sam.page.waitForTimeout(400);
  const rail = await sam.page.evaluate(() => ({ head: document.querySelector('.spotlight .section-head')?.textContent || '', sub: document.querySelector('.spotlight .card-s')?.textContent || '' }));
  check('Tonight shows it in Spotlight, marked new', /Spotlight/.test(rail.head) && /1 new/.test(rail.head) && /1 new/.test(rail.sub), JSON.stringify(rail));

  await sam.page.evaluate(async (uid) => (await import('./src/screens/thread.js')).openThread(uid), film.uid);
  await sam.page.waitForSelector('.thread-sheet.is-open');
  const thread = await sam.page.evaluate(() => [...document.querySelectorAll('.thread-sheet .note')].map((n) => ({ own: n.classList.contains('is-own'), text: n.querySelector('.note-bubble').textContent, meta: n.querySelector('.note-meta').textContent })));
  check('Sam sees it as Luke’s, not hers', thread.length === 1 && !thread[0].own && /^Luke/.test(thread[0].meta), JSON.stringify(thread));
  check('and opening it marks it read', (await sam.page.evaluate(async () => (await import('./src/store.js')).unreadTotal())) === 0);
  await sam.page.fill('.thread-sheet textarea', 'Yes — go on then');
  await sam.page.tap('.thread-sheet .thread-send');
  await sam.page.waitForTimeout(300);
  await sam.page.keyboard.press('Escape');
  await syncNow(sam.page);
  await syncNow(luke.page);
  const lukeNotes = await luke.page.evaluate(async (uid) => {
    const s = await import('./src/store.js');
    const it = s.byUid(uid);
    return { notes: s.notesFor(it).map((n) => n.text), unread: s.unreadFor(it) };
  }, film.uid);
  check('Sam’s reply reaches Luke, after his, and is new to him', lukeNotes.notes.join(' | ') === 'Saturday? It looks like the one we watched last week. | Yes — go on then' && lukeNotes.unread === 1, JSON.stringify(lukeNotes));

  const mine = await luke.page.evaluate(async (uid) => {
    const s = await import('./src/store.js');
    const n = s.notesFor(s.byUid(uid)).find((x) => x.by === 'Luke');
    s.removeNote(n.id);
    s.emit('item');
    return n.id;
  }, film.uid);
  await syncNow(luke.page);
  await syncNow(sam.page);
  const afterDelete = await sam.page.evaluate(async (uid) => (await import('./src/store.js')).notesFor(window.__test.byUid(uid)).map((n) => n.id), film.uid);
  check('a comment Luke deletes is gone from Sam’s phone too', !afterDelete.includes(mine) && afterDelete.length === 1, JSON.stringify(afterDelete));

  console.log('\n─── taken back before it went ───');
  const takenBack = await luke.page.evaluate(async (uid) => {
    const s = await import('./src/store.js');
    s.setSpotlight(uid, false);
    s.setSpotlight(uid, true);
    s.setSpotlight(uid, false);
    const note = s.addNote(uid, 'Actually, never mind');
    s.removeNote(note.id);
    return s.pendingNotify().filter((e) => e.uid === uid);
  }, film.uid);
  check('a Spotlight undone, or a comment deleted, before the sync does not buzz the other phone', takenBack.length === 0, JSON.stringify(takenBack));
  await luke.page.evaluate(async (uid) => (await import('./src/store.js')).setSpotlight(uid, true), film.uid);
  await syncNow(luke.page);
  const readIds = await sam.page.evaluate(async (uid) => {
    const s = await import('./src/store.js');
    const it = window.__test.byUid(uid);
    s.markThreadSeen(uid);
    /* A comment from the other phone stamped before this phone last read the
       thread — its clock behind — is still new: read is by comment, not time. */
    const st = JSON.parse(localStorage.getItem('wn.state.v3'));
    return { unread: s.unreadFor(it), seen: (st.settings.seenNotes || []).length };
  }, film.uid);
  check('reading a thread records which comments were read', readIds.unread === 0 && readIds.seen >= 1, JSON.stringify(readIds));

  console.log('\n─── turning notifications on ───');
  await luke.page.tap('[data-tab="tonight"]');
  await luke.page.evaluate(() => document.querySelector('.screen.is-active [data-nav="settings"]').click());
  await luke.page.waitForTimeout(600);
  const offText = await luke.page.evaluate(() => document.querySelector('[data-region="notify"]')?.textContent || '');
  check('Settings has a Notifications row, off, saying what it does', /Notifications/.test(offText) && /Turn on/.test(offText) && /comments/.test(offText), offText);
  await luke.page.waitForTimeout(400); // keys made ahead of the tap
  failPush = true;
  const failed = await luke.page.evaluate(async () => {
    const n = await import('./src/notify.js');
    const s = await import('./src/store.js');
    const r = await n.enable();
    return { r, on: !!s.settings().push?.enabled, state: n.state() };
  });
  failPush = false;
  check('if the push address cannot be written, notifications stay off', !failed.r.ok && failed.r.step === 'device' && !failed.on && failed.state === 'off', JSON.stringify(failed));
  await luke.page.evaluate(() => [...document.querySelectorAll('[data-region="notify"] button')].find((b) => /Turn on/.test(b.textContent)).click());
  await luke.page.waitForTimeout(1200);
  const lukeDevice = (await st(luke.page)).settings.deviceId;
  const deviceFile = files.get(`push/${lukeDevice}.json`);
  const dev = deviceFile && JSON.parse(deviceFile.text);
  check('this phone’s push address goes in the repo', !!dev && dev.enabled && /^https:\/\/web\.push\.apple\.com\//.test(dev.subscription.endpoint) && !!dev.subscription.keys.p256dh, JSON.stringify(dev && dev.subscription));
  check('with a key pair made on the phone, in the form web-push signs with', !!dev && /^[A-Za-z0-9_-]{87}$/.test(dev.vapid.publicKey) && /^[A-Za-z0-9_-]{43}$/.test(dev.vapid.privateKey), JSON.stringify(dev && dev.vapid));
  const subscribedWith = await luke.page.evaluate(() => { const k = window.__subscribedWith; return btoa(String.fromCharCode(...new Uint8Array(k.buffer || k))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); });
  check('and it subscribed with that same public key', dev && subscribedWith === dev.vapid.publicKey);
  check('signed as the app’s own https address', dev && /^https:\/\//.test(dev.subject), dev && dev.subject);
  check('the sender script goes in the repo', files.has('.github/watchnext-notify.mjs'));
  check('the workflow was refused without the Workflows permission', !files.has('.github/workflows/watchnext-notify.yml'));
  const trouble = await luke.page.evaluate(() => document.querySelector('.notify-trouble')?.textContent || '');
  check('and Settings says exactly which permission to add', /Workflows/.test(trouble) && /Read and write/.test(trouble) && /Finish setting up/.test(trouble), trouble.slice(0, 200));

  allowWorkflows = true;
  await luke.page.evaluate(() => [...document.querySelectorAll('.notify-trouble button')].find((b) => /Finish setting up/.test(b.textContent)).click());
  await luke.page.waitForTimeout(800);
  const wf = files.get('.github/workflows/watchnext-notify.yml');
  check('with the permission, the workflow goes in', !!wf && /on: push/.test(wf.text) && /contains\(github\.event\.head_commit\.message, '\[notify\]'\)/.test(wf.text) && /web-push@3\.6\.7/.test(wf.text), wf && wf.text.slice(0, 80));
  const onText = await luke.page.evaluate(() => document.querySelector('[data-region="notify"]')?.textContent || '');
  check('and the row says it is on, with a test button', /On\. You will hear/.test(onText) && /Send a test/.test(onText) && !/Finish setting up/.test(onText), onText);

  const before = commits.length;
  await luke.page.evaluate(() => [...document.querySelectorAll('[data-region="notify"] button')].find((b) => /Send a test/.test(b.textContent)).click());
  await luke.page.waitForTimeout(1200);
  const test = commits.slice(before).find((c) => c.path === 'notify/last.json');
  const testEvent = JSON.parse(files.get('notify/last.json').text).events[0];
  check('a test goes up as a [notify] commit, to this phone too', !!test && /^\[notify\]/.test(test.message) && testEvent.kind === 'test' && testEvent.includeSelf === true, JSON.stringify(testEvent));

  /* Sam's phone: the Action is already there, so her token needs nothing
     more — and nothing is rewritten. */
  allowWorkflows = false;
  const wfCommits = commits.filter((c) => c.path.startsWith('.github/')).length;
  await sam.page.tap('[data-tab="tonight"]');
  await sam.page.evaluate(() => document.querySelector('.screen.is-active [data-nav="settings"]').click());
  await sam.page.waitForTimeout(900);
  await sam.page.evaluate(() => [...document.querySelectorAll('[data-region="notify"] button')].find((b) => /Turn on/.test(b.textContent)).click());
  await sam.page.waitForTimeout(1200);
  const samDevice = (await st(sam.page)).settings.deviceId;
  check('the second phone turns on without the extra permission', files.has(`push/${samDevice}.json`) && (await sam.page.evaluate(() => /On\. You will hear/.test(document.querySelector('[data-region="notify"]')?.textContent || ''))));
  check('and does not rewrite the Action', commits.filter((c) => c.path.startsWith('.github/')).length === wfCommits);

  /* Hand the repo to the Action test: every file, as the checkout sees it. */
  const outDir = path.join(os.tmpdir(), 'wn-notify-repo');
  fs.rmSync(outDir, { recursive: true, force: true });
  for (const [p, f] of files) {
    fs.mkdirSync(path.join(outDir, path.dirname(p)), { recursive: true });
    fs.writeFileSync(path.join(outDir, p), f.text);
  }
  const keys = { [lukeDevice]: await luke.page.evaluate(() => window.__subPrivate), [samDevice]: await sam.page.evaluate(() => window.__subPrivate) };
  fs.writeFileSync(path.join(outDir, 'subscriber-keys.json'), JSON.stringify(keys));

  console.log('\n─── turning them off ───');
  await sam.page.evaluate(() => [...document.querySelectorAll('[data-region="notify"] button')].find((b) => /Turn off/.test(b.textContent)).click());
  await sam.page.waitForTimeout(800);
  check('turning off removes this phone’s push address from the repo', !files.has(`push/${samDevice}.json`));

  console.log('\n─── no errors ───');
  check('no JavaScript errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('\nFailures:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.log('SUITE CRASHED:', e.message); process.exit(1); });

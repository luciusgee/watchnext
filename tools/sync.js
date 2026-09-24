/*
 * Two phones, one repo.
 *
 * Driven as two real browser contexts against an in-memory GitHub contents
 * API, because the interesting failures are not in the merge — merge.test.mjs
 * covers that — but in the exchange: a stale sha, a first run with no file, a
 * deletion that has to survive a round trip, and a token that must never leave
 * the device in anything but an Authorization header.
 */
const { chromium, devices } = require('/opt/node22/lib/node_modules/playwright');

/* Not named URL: that shadows the global constructor this file also needs, which
   is a mistake already made twice in this repo's tools. */
const APP_URL = 'http://127.0.0.1:8899/index.html';
const REPO = 'luke/watchnext-data';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

/* The repo, such as it is. */
const repo = { content: null, sha: null, writes: 0, conflicts: 0, seenTokens: new Set() };
let nextSha = 1;
/* Set to make the next PUT collide, as if the other phone wrote first. */
let stealWrite = null;

function b64(text) { return Buffer.from(text, 'utf8').toString('base64'); }
function unb64(text) { return Buffer.from(text, 'base64').toString('utf8'); }

async function githubRoute(route) {
  const req = route.request();
  const url = new URL(req.url());
  const auth = req.headers()['authorization'] || '';
  repo.seenTokens.add(auth);
  const json = (status, body) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

  if (/\/repos\/[^/]+\/[^/]+$/.test(url.pathname)) {
    return json(200, { private: true, permissions: { push: true } });
  }
  if (/\/contents\//.test(url.pathname)) {
    if (req.method() === 'GET') {
      if (repo.content === null) return json(404, { message: 'Not Found' });
      return json(200, { content: repo.content, sha: repo.sha, encoding: 'base64' });
    }
    if (req.method() === 'PUT') {
      const body = JSON.parse(req.postData() || '{}');
      /* A write from the other phone, landing between this one's read and its
         write. The real API answers a stale sha with a 409. */
      if (stealWrite) {
        repo.content = b64(JSON.stringify(stealWrite));
        repo.sha = `sha${nextSha++}`;
        stealWrite = null;
      }
      if ((body.sha || null) !== repo.sha) {
        repo.conflicts++;
        return json(409, { message: 'does not match' });
      }
      repo.content = body.content;
      repo.sha = `sha${nextSha++}`;
      repo.writes++;
      return json(200, { content: { sha: repo.sha } });
    }
  }
  return json(404, { message: 'Not Found' });
}

const stored = () => (repo.content === null ? null : JSON.parse(unb64(repo.content)));

(async () => {
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  });

  /** A phone: its own context, storage and service worker. */
  async function phone(token = 'github_pat_test') {
    const ctx = await browser.newContext({ ...devices['iPhone 13 Pro'] });
    await ctx.route('**://api.github.com/**', githubRoute);
    await ctx.route('**://m.media-amazon.com/**', (r) =>
      r.fulfill({ status: 200, contentType: 'image/gif', body: Buffer.from('R0lGODlhAQABAAAAACw=', 'base64') }));
    await ctx.route('**://image.tmdb.org/**', (r) =>
      r.fulfill({ status: 200, contentType: 'image/gif', body: Buffer.from('R0lGODlhAQABAAAAACw=', 'base64') }));
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(APP_URL, { waitUntil: 'networkidle' });
    await page.waitForSelector('body.is-ready');
    await page.evaluate(async ({ repo, token }) => {
      const store = await import('./src/store.js');
      store.updateSettings({ sync: { repo, token, path: 'library.json', enabled: true } });
      store.saveNow();
    }, { repo: REPO, token });
    return {
      page,
      errors,
      close: () => ctx.close(),
      add: (title, extra = {}) => page.evaluate(async ({ title, extra }) => {
        const store = await import('./src/store.js');
        store.add({ title, ...extra });
      }, { title, extra }),
      titles: () => page.evaluate(async () => {
        const store = await import('./src/store.js');
        return store.items().map((i) => i.title).sort();
      }),
      removeByTitle: (title) => page.evaluate(async (t) => {
        const store = await import('./src/store.js');
        const found = store.items().find((i) => i.title === t);
        if (found) store.remove(found.uid);
      }, title),
      sync: () => page.evaluate(async () => {
        const sync = await import('./src/sync.js');
        return sync.syncNow({ note: 'test' });
      }),
      status: () => page.evaluate(async () => {
        const sync = await import('./src/sync.js');
        return sync.status();
      }),
    };
  }

  console.log('\n─── the first phone, and an empty repo ───');
  const a = await phone();
  await a.add('Heat', { year: 1995 });
  await a.add('The Thing', { year: 1982 });
  await a.sync();

  const first = stored();
  check('an empty repo is created rather than treated as a wipe',
    first && first.items.length === 2, JSON.stringify(first && first.items.length));
  check('the library still has both titles locally',
    (await a.titles()).join(',') === 'Heat,The Thing', (await a.titles()).join(','));
  check('and what is written carries no API keys',
    !/token|apikey|api_key|sk-ant|github_pat/i.test(JSON.stringify(first)),
    Object.keys(first).join(','));
  check('nor anything from settings beyond the household',
    !('settings' in first) && !('aiKey' in first), Object.keys(first).join(','));

  console.log('\n─── the second phone picks up the shelf ───');
  const b = await phone();
  await b.sync();
  check('it arrives with both films', (await b.titles()).join(',') === 'Heat,The Thing', (await b.titles()).join(','));

  console.log('\n─── both of you adding at once ───');
  await a.add('Alien', { year: 1979 });
  await b.add('Arrival', { year: 2016 });
  await b.sync();
  await a.sync();
  /* Neither addition may be lost, whichever order they land in. */
  const aTitles = await a.titles();
  check('the phone that synced second has everything',
    aTitles.join(',') === 'Alien,Arrival,Heat,The Thing', aTitles.join(','));
  await b.sync();
  const bTitles = await b.titles();
  check('and so does the other, once it looks again',
    bTitles.join(',') === 'Alien,Arrival,Heat,The Thing', bTitles.join(','));

  console.log('\n─── a deletion has to stick ───');
  await b.removeByTitle('Arrival');
  await b.sync();
  await a.sync();
  check('a film deleted on one phone goes on the other',
    !(await a.titles()).includes('Arrival'), (await a.titles()).join(','));
  /* The failure this guards: A still held it, so without a tombstone A's next
     push hands it straight back to B. */
  await a.sync();
  await b.sync();
  check('and does not come back on the next sync',
    !(await b.titles()).includes('Arrival'), (await b.titles()).join(','));

  console.log('\n─── a write that loses the race ───');
  const before = repo.conflicts;
  /* The other phone commits between this one's read and its write. */
  const sneak = { ...stored() };
  sneak.items = [...sneak.items, { uid: 'sneaked', title: 'Sneaked In', updatedAt: Date.now() + 5000, addedAt: Date.now() }];
  stealWrite = sneak;
  await a.add('Sicario', { year: 2015 });
  await a.sync();
  check('the conflict actually happened', repo.conflicts > before, `${repo.conflicts - before}`);
  const after = stored();
  const names = after.items.map((i) => i.title).sort();
  check('the losing write is retried, not dropped', names.includes('Sicario'), names.join(','));
  check('and the write that beat it is not overwritten', names.includes('Sneaked In'), names.join(','));

  console.log('\n─── nothing is written when nothing changed ───');
  const writes = repo.writes;
  await a.sync();
  await a.sync();
  check('a no-op sync spends no commits', repo.writes === writes, `${repo.writes - writes} extra`);

  console.log('\n─── the token ───');
  check('reaches GitHub only as a bearer header',
    [...repo.seenTokens].every((t) => t === '' || t === 'Bearer github_pat_test'),
    [...repo.seenTokens].join(' | '));
  const exported = await a.page.evaluate(async () => {
    const store = await import('./src/store.js');
    return JSON.stringify(store.exportPayload());
  });
  check('and never appears in a backup file', !/github_pat_test/.test(exported));

  console.log('\n─── failure is survivable ───');
  const c = await phone('wrong-token');
  await c.page.route('**://api.github.com/**', (r) =>
    r.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ message: 'Bad credentials' }) }));
  await c.add('Offline Film');
  const moved = await c.sync();
  const st = await c.status();
  check('a rejected token reports itself', st.phase === 'error' && /token/i.test(st.message), JSON.stringify(st));
  check('and does not take the local library with it',
    (await c.titles()).includes('Offline Film'), (await c.titles()).join(','));
  check('and the sync reports that it did not happen', moved === false, String(moved));

  const jsErrors = [...a.errors, ...b.errors, ...c.errors];
  check('no uncaught errors throughout', jsErrors.length === 0, jsErrors.slice(0, 2).join(' | '));

  await a.close(); await b.close(); await c.close();
  await browser.close();

  console.log(`\n══════════  ${pass} passed, ${fail} failed  ══════════`);
  if (failures.length) { console.log('\nFailures:'); failures.forEach((f) => console.log('  · ' + f)); }
  process.exit(fail ? 1 : 0);
})();

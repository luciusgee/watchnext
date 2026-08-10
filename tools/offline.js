/*
 * Service worker behaviour.
 *
 * The interesting assertions are not "does it cache" — they are "does a deploy
 * still reach the user" and "can the user get out". A service worker that
 * strands someone on a stale build is worse than none at all.
 */
const { chromium, devices } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const check = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ok    ${n}`); }
  else { fail++; failures.push(n + (d ? ` — ${d}` : '')); console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`); }
};

const ROOT = path.join(__dirname, '..');
const PORT = 8923;
const BLANK = Buffer.from('R0lGODlhAQABAAAAACw=', 'base64');

/* A tiny server we control, so we can mutate a file mid-test and prove the
   update actually propagates. Served under /watchnext/ to match GitHub Pages. */
let marker = 'BUILD_ONE';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
               '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/watchnext\/?/, '') || 'index.html';
  const file = path.join(ROOT, rel.endsWith('/') ? rel + 'index.html' : rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('not found');
  }
  let body = fs.readFileSync(file);
  /* Stamp the build marker into main.js so the page can report which build it
     is actually running. */
  if (rel === 'src/main.js') {
    body = Buffer.from(body.toString().replace(
      "document.body.classList.add('is-ready');",
      `window.__build = '${marker}'; document.body.classList.add('is-ready');`));
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  res.end(body);
});

const URL_BASE = `http://127.0.0.1:${PORT}/watchnext/`;

(async () => {
  await new Promise((r) => server.listen(PORT, r));

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  /* Service workers need a persistent context to survive reloads the way they
     do for a real user. */
  const ctx = await browser.newContext({ ...devices['iPhone 13 Pro'] });
  await ctx.route('**://image.tmdb.org/**', (r) => r.fulfill({ status: 200, contentType: 'image/gif', body: BLANK }));
  await ctx.route('**://m.media-amazon.com/**', (r) => r.fulfill({ status: 200, contentType: 'image/gif', body: BLANK }));

  /* The app skips service worker registration under automation so the other
     suites are never affected by a warm cache. Exercising the worker is this
     suite's entire job, so it hides the automation flag rather than the app
     growing a test-only branch. */
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });
  });

  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));

  /* The precache list is written by hand — there is no build step to generate
     it — and a module left off it fails in the one situation nobody tests by
     hand: installed, then offline, before ever visiting the screen that needs
     it. Network-first quietly caches whatever it fetches, so every runtime
     check below would pass with the list incomplete. Hence a static one. */
  console.log('\n─── the precache list covers every module ───');
  {
    const listed = new Set(
      (fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8').match(/'\.\/(src\/[^']+\.js)'/g) || [])
        .map((m) => m.slice(3, -1))
    );
    const walk = (dir) =>
      fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(`${dir}/${e.name}`) : e.name.endsWith('.js') ? [`${dir}/${e.name}`] : []
      );
    const onDisk = walk('src');
    const missing = onDisk.filter((f) => !listed.has(f));
    check('every module under src/ is in the service worker shell list',
      missing.length === 0, missing.join(', '));
    check('and the list has no entries that no longer exist',
      [...listed].every((f) => onDisk.includes(f)),
      [...listed].filter((f) => !onDisk.includes(f)).join(', '));
  }

  /* Add to Home Screen is the entire delivery channel, so a missing or
     unreferenced icon is not cosmetic. iOS falls back to a screenshot of the
     page when it cannot use the icon, which is the first thing a new user
     sees on their home screen. */
  console.log('\n─── the install icons are real files ───');
  {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.webmanifest'), 'utf8'));
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

    const missing = manifest.icons.filter((i) => !fs.existsSync(path.join(ROOT, i.src)));
    check('every icon the manifest declares exists on disk',
      missing.length === 0, missing.map((i) => i.src).join(', '));

    check('there is a maskable icon, so Android does not crop the mark',
      manifest.icons.some((i) => i.purpose === 'maskable'));
    check('and a 512 for the splash screen',
      manifest.icons.some((i) => /512/.test(i.sizes) && i.type === 'image/png'));

    const touch = html.match(/rel="apple-touch-icon"[^>]*href="([^"]+)"/);
    check('the apple-touch-icon is declared', !!touch);
    check('it is a PNG — iOS does not reliably accept an SVG here',
      !!touch && /\.png$/.test(touch[1]), touch?.[1]);
    check('and it exists', !!touch && fs.existsSync(path.join(ROOT, touch[1])), touch?.[1]);
  }

  console.log('\n─── registration ───');
  await page.goto(URL_BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('body.is-ready');
  const registered = await page.evaluate(async () => {
    for (let i = 0; i < 60; i++) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg && (reg.active || reg.installing || reg.waiting)) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  });
  check('service worker registers', registered);

  await page.evaluate(() => navigator.serviceWorker.ready);
  const controlled = await page.evaluate(async () => {
    for (let i = 0; i < 40; i++) {
      if (navigator.serviceWorker.controller) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  });
  check('worker takes control of the page', controlled);

  const cached = await page.evaluate(async () => {
    const keys = await caches.keys();
    const shell = keys.find((k) => k.startsWith('wn-shell'));
    if (!shell) return 0;
    return (await (await caches.open(shell)).keys()).length;
  });
  check('app shell is precached', cached >= 15, `${cached} entries`);

  console.log('\n─── works with the network gone ───');
  await ctx.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  const bootedOffline = await page.waitForSelector('body.is-ready', { timeout: 10000 }).then(() => true).catch(() => false);
  check('app boots with no connection', bootedOffline);

  if (bootedOffline) {
    const usable = await page.evaluate(() => {
      const items = JSON.parse(localStorage.getItem('wn.state.v3') || '{}').items || [];
      return { items: items.length, tabs: document.querySelectorAll('[data-tab]').length };
    });
    check('library is intact offline', usable.items > 200, `${usable.items} titles`);
    check('navigation renders offline', usable.tabs === 4, `${usable.tabs} tabs`);

    for (const tab of ['discover', 'library', 'ask']) {
      await page.click(`[data-tab="${tab}"]`);
      await page.waitForTimeout(350);
      const ok = await page.evaluate((t) => document.getElementById(`screen-${t}`).textContent.trim().length > 20, tab);
      check(`${tab} works offline`, ok);
    }
  }
  await ctx.setOffline(false);

  console.log('\n─── a deploy still reaches the user ───');
  // This is the assertion that matters. Change the served build, reload, and
  // the page must be running the NEW code — not whatever the worker cached.
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('body.is-ready');
  const before = await page.evaluate(() => window.__build);
  check('running the first build', before === 'BUILD_ONE', String(before));

  marker = 'BUILD_TWO';
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('body.is-ready');
  await page.waitForTimeout(600);
  const after = await page.evaluate(() => window.__build);
  check('a new deploy is picked up, not served stale from cache', after === 'BUILD_TWO', `still ${after}`);

  console.log('\n─── images are cached ───');
  /* A real <img> load, from our own server. Context routes are intercepted
     before the worker sees them, so a routed URL could never demonstrate this. */
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      const img = new Image();
      img.onload = img.onerror = resolve;
      img.src = 'assets/icon.svg?cachetest=1';
    });
  });
  await page.waitForTimeout(600);
  const imgCached = await page.evaluate(async () => {
    const keys = await caches.keys();
    const img = keys.find((k) => k.startsWith('wn-img'));
    if (!img) return 0;
    return (await (await caches.open(img)).keys()).length;
  });
  check('image cache is populated', imgCached >= 1, `${imgCached} entries`);

  console.log('\n─── API traffic is never cached ───');
  const apiCached = await page.evaluate(async () => {
    const keys = await caches.keys();
    for (const k of keys) {
      const reqs = await (await caches.open(k)).keys();
      if (reqs.some((r) => /themoviedb\.org\/3|omdbapi|anthropic/.test(r.url))) return true;
    }
    return false;
  });
  check('no API responses in any cache', apiCached === false);

  console.log('\n─── the escape hatches work ───');
  /* Plant a sentinel in the shell cache. A purge is proven by the sentinel
     being gone — checking that the worker is absent afterwards would be wrong,
     because resetOfflineCache deliberately re-primes offline support. */
  await page.evaluate(async () => {
    const cache = await caches.open('wn-shell-v1');
    await cache.put('./__sentinel__', new Response('stale'));
  });
  const planted = await page.evaluate(async () =>
    !!(await (await caches.open('wn-shell-v1')).match('./__sentinel__')));
  check('sentinel planted in the cache', planted);

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {}),
    page.evaluate(() => window.wn.resetOfflineCache()),
  ]);
  await page.waitForSelector('body.is-ready', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1200);

  const purged = await page.evaluate(async () => {
    const keys = await caches.keys();
    for (const k of keys) {
      if (await (await caches.open(k)).match('./__sentinel__')) return false;
    }
    return true;
  });
  check('resetOfflineCache purges stale cached content', purged);
  const backOnline = await page.evaluate(async () => {
    for (let i = 0; i < 40; i++) {
      const r = await navigator.serviceWorker.getRegistration();
      if (r) return true;
      await new Promise((x) => setTimeout(x, 100));
    }
    return false;
  });
  check('offline support re-primes itself after a reset', backOnline);

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {}),
    page.evaluate(() => window.wn.disableOffline()),
  ]);
  await page.waitForSelector('body.is-ready', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const disabled = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    const keys = await caches.keys();
    return { reg: !!reg, wn: keys.filter((k) => k.startsWith('wn-')).length };
  });
  check('disableOffline unregisters the worker', disabled.reg === false, 'still registered');
  check('disableOffline leaves no caches behind', disabled.wn === 0, `${disabled.wn} left`);

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('body.is-ready');
  await page.waitForTimeout(1500);
  const stillOff = await page.evaluate(async () => !(await navigator.serviceWorker.getRegistration()));
  check('it stays off across a reload', stillOff);

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {}),
    page.evaluate(() => window.wn.enableOffline()),
  ]);
  await page.waitForSelector('body.is-ready', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const reenabled = await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration()));
  check('enableOffline turns it back on', reenabled);

  console.log('\n─── no errors ───');
  check('no uncaught JS errors throughout', errs.length === 0, errs.slice(0, 3).join(' | '));

  console.log(`\n══════════  ${pass} passed, ${fail} failed  ══════════`);
  if (failures.length) { console.log('\nFailures:'); failures.forEach((f) => console.log('  · ' + f)); }
  await browser.close();
  server.closeAllConnections?.();
  server.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASHED:', e.message); server.closeAllConnections?.(); server.close(); process.exit(2); });

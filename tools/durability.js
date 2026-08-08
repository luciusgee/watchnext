/*
 * Storage durability.
 *
 * The library is the only thing here that cannot be regenerated, and browsers
 * evict script-writable storage. These assertions are about survival: does a
 * second copy exist, does the app find it, and does it tell the truth about
 * the risk.
 */
const { chromium, devices } = require('/opt/node22/lib/node_modules/playwright');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
const check = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ok    ${n}`); }
  else { fail++; failures.push(n + (d ? ` — ${d}` : '')); console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`); }
};

const URL = 'http://127.0.0.1:8899/index.html';
const BLANK = Buffer.from('R0lGODlhAQABAAAAACw=', 'base64');

/* A realistic library, so the mirror is exercised at a real size rather than
   with a toy payload. */
const FIXTURE = path.join(__dirname, 'fixtures', 'legacy-backup.json');
const LEGACY = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')).library;

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ ...devices['iPhone 13 Pro'] });
  await ctx.route('**://image.tmdb.org/**', (r) => r.fulfill({ status: 200, contentType: 'image/gif', body: BLANK }));
  await ctx.route('**://m.media-amazon.com/**', (r) => r.fulfill({ status: 200, contentType: 'image/gif', body: BLANK }));

  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));

  const boot = async () => {
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.waitForSelector('body.is-ready');
  };

  console.log('\n─── a second copy is kept ───');
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate((lib) => {
    localStorage.clear();
    localStorage.setItem('wn_lib2', JSON.stringify(lib));
  }, LEGACY);
  await boot();
  await page.waitForTimeout(1200);

  const mirrored = await page.evaluate(async () => {
    const { readMirror } = await import('./src/durability.js');
    const snap = await readMirror();
    return { has: !!snap, items: snap?.state?.items?.length || 0, savedAt: snap?.savedAt || 0 };
  });
  check('a mirror is written on first run', mirrored.has);
  check('the mirror holds the whole library', mirrored.items === LEGACY.length, `${mirrored.items}/${LEGACY.length}`);

  const primary = await page.evaluate(() => JSON.parse(localStorage.getItem('wn.state.v3')).items.length);
  check('the primary copy is intact too', primary === LEGACY.length, `${primary}`);

  console.log('\n─── surviving an eviction ───');
  // Exactly what WebKit's ITP does: wipe localStorage, leave the page alone.
  const beforeWatched = await page.evaluate(
    () => JSON.parse(localStorage.getItem('wn.state.v3')).items.filter((i) => i.watched).length
  );
  await page.evaluate(() => localStorage.clear());
  const wiped = await page.evaluate(() => localStorage.getItem('wn.state.v3'));
  check('localStorage is genuinely empty', wiped === null);

  await boot();
  await page.waitForTimeout(1500);

  const recovered = await page.evaluate(() => {
    const raw = localStorage.getItem('wn.state.v3');
    if (!raw) return { items: 0, watched: 0 };
    const s = JSON.parse(raw);
    return { items: s.items.length, watched: s.items.filter((i) => i.watched).length };
  });
  check('the library is recovered after a wipe', recovered.items === LEGACY.length, `${recovered.items} titles`);
  check('watch history survives the wipe', recovered.watched === beforeWatched, `${recovered.watched}/${beforeWatched}`);
  check('recovery rewrites the primary copy', recovered.items > 0);

  console.log('\n─── recovery never overwrites good data ───');
  // A mirror from an older session must not clobber a library that is already
  // present — recovery is for an empty store only.
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('wn.state.v3'));
    s.items = s.items.slice(0, 5);
    s.items[0].title = 'DELIBERATELY EDITED';
    localStorage.setItem('wn.state.v3', JSON.stringify(s));
  });
  await boot();
  await page.waitForTimeout(1200);
  const kept = await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('wn.state.v3'));
    return { count: s.items.length, first: s.items[0].title };
  });
  check('a non-empty library is left alone', kept.count === 5, `${kept.count} items`);
  check('local edits are not reverted by the mirror', kept.first === 'DELIBERATELY EDITED', kept.first);

  console.log('\n─── the app asks not to be evicted ───');
  const persistence = await page.evaluate(async () => {
    const { isPersisted, storageEstimate } = await import('./src/durability.js');
    return { persisted: await isPersisted(), estimate: await storageEstimate() };
  });
  check('persistence state is readable', typeof persistence.persisted === 'boolean');
  check('a storage estimate is available', persistence.estimate === null || typeof persistence.estimate.usage === 'number');

  console.log('\n─── Settings tells the truth about it ───');
  await page.click('[data-tab="tonight"]');
  await page.waitForTimeout(300);
  await page.click('#screen-tonight [data-nav="settings"]');
  await page.waitForTimeout(1200);
  const panel = await page.evaluate(() => {
    const slot = document.querySelector('[data-region="storage-health"]');
    return { present: !!slot, text: slot ? slot.innerText : '' };
  });
  check('a storage health panel is shown', panel.present);
  check('it says something meaningful about durability',
    /keep your library|not guaranteed|Using /i.test(panel.text), panel.text.slice(0, 80));

  console.log('\n─── exporting records that a backup exists ───');
  const stamped = await page.evaluate(async () => {
    const { markBackedUp, lastBackupAt } = await import('./src/durability.js');
    markBackedUp(1700000000000);
    return lastBackupAt();
  });
  check('backup time is recorded', stamped === 1700000000000, String(stamped));

  const nudge = await page.evaluate(async () => {
    const { shouldNudgeBackup } = await import('./src/durability.js');
    return {
      quietWhenNothingToLose: shouldNudgeBackup({ watched: 0, saved: 0 }),
      nudgesWhenStale: shouldNudgeBackup({ watched: 200, saved: 100 }),
    };
  });
  check('no nudge when there is nothing to lose', nudge.quietWhenNothingToLose === false);
  check('nudges when a real library has a stale backup', nudge.nudgesWhenStale === true);

  console.log('\n─── no errors ───');
  check('no uncaught JS errors', errs.length === 0, errs.slice(0, 3).join(' | '));

  console.log(`\n══════════  ${pass} passed, ${fail} failed  ══════════`);
  if (failures.length) { console.log('\nFailures:'); failures.forEach((f) => console.log('  · ' + f)); }
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASHED:', e.message, '\n', e.stack); process.exit(2); });

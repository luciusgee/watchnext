/*
 * Duplicates.
 *
 * A library saved on a phone with the same film in it twice — the way the one
 * brought over from the old app was — has to come back as one film per title
 * the next time the app opens, keep every watched and owned mark, and say
 * what it did. And a lookup that resolves a misspelt title to a film already
 * there must not leave two.
 */
const { chromium, devices } = require('/opt/node22/lib/node_modules/playwright');

const APP_URL = 'http://127.0.0.1:8899/index.html';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ ...devices['iPhone 13 Pro'] });
  await ctx.route(/image\.tmdb\.org|m\.media-amazon\.com|api\.themoviedb\.org|omdbapi\.com|api\.anthropic\.com|api\.github\.com/, (r) => r.abort());
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(APP_URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('body.is-ready');

  console.log('\n─── a saved library with doubles in it ───');
  await page.evaluate(() => {
    const st = JSON.parse(localStorage.getItem('wn.state.v3'));
    const film = (uid, title, imdbId, addedAt, extra = {}) => ({
      uid, title, sortTitle: title.toLowerCase(), year: 2014, type: 'movie', genres: [], imdbId,
      owned: false, watched: false, watchedAt: null, watchedBy: {}, quality: null,
      addedAt, updatedAt: addedAt, locked: [], meta: { v: 1, status: 'matched', at: 1, confidence: 1 }, ...extra,
    });
    st.items = [
      film('a1', 'It Follows', 'tt3235888', 100, { owned: true, quality: '4K' }),
      film('a2', 'It Follows', 'tt3235888', 101, { watched: true, watchedAt: 555 }),
      film('b1', 'Incendies', 'tt1255953', 100, { owned: true, quality: '1080p' }),
      film('b2', 'Insendies', 'tt1255953', 101, { owned: true, meta: { v: 1, status: 'skipped' } }),
      film('c1', 'Malignant', 'tt3811906', 100, { year: 2021 }),
    ];
    localStorage.setItem('wn.state.v3', JSON.stringify(st));
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('body.is-ready');
  const after = await page.evaluate(() => window.__test.items().map((i) => ({ uid: i.uid, title: i.title, owned: i.owned, watched: i.watched, quality: i.quality })));
  check('each film is there once', after.length === 3, JSON.stringify(after));
  const follows = after.find((i) => i.title === 'It Follows');
  check('keeping both the owned and the watched mark', follows?.owned && follows?.watched && follows?.quality === '4K', JSON.stringify(follows));
  check('and the properly spelt Incendies, not Insendies', after.some((i) => i.title === 'Incendies') && !after.some((i) => i.title === 'Insendies'));
  const toastText = await page.evaluate(() => document.querySelector('.toast.is-open')?.textContent || '');
  check('the app says what it did', /Merged 2 duplicate titles/.test(toastText), toastText);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('wn.state.v3')));
  check('and the fix is saved, not redone every launch', saved.items.length === 3);
  check('with the removed copies buried, so a sync removes them on the other phone',
    ['a2', 'b2'].every((u) => saved.tombstones.some((t) => t.uid === u)));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('body.is-ready');
  check('and it only says so once', !(await page.evaluate(() => document.querySelector('.toast.is-open')?.textContent || '')).includes('Merged'));

  console.log('\n─── a lookup that finds the film is already here ───');
  const folded = await page.evaluate(() => {
    const t = window.__test;
    t.add({ title: 'Malignnt', year: 2021, type: 'movie' });
    const typo = t.items().find((i) => i.title === 'Malignnt');
    /* What the details lookup, or picking the match by hand, writes. */
    t.update(typo.uid, { imdbId: 'tt3811906', title: 'Malignant' });
    return t.items().filter((i) => i.imdbId === 'tt3811906').length;
  });
  check('matching a misspelt title to a film already here leaves one', folded === 1, String(folded));

  console.log('\n─── a backup carrying the same film twice ───');
  const imported = await page.evaluate(() => {
    const t = window.__test;
    const payload = t.exportPayload();
    const twin = { ...payload.items[0], uid: 'twin-of-first' };
    payload.items.push(twin);
    t.importPayload(payload, 'replace');
    return { n: t.items().length, ids: new Set(t.items().map((i) => i.imdbId)).size };
  });
  check('restoring it leaves each film once', imported.n === imported.ids, JSON.stringify(imported));

  console.log('\n─── no errors ───');
  check('no JavaScript errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('\nFailures:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.log('SUITE CRASHED:', e.message); process.exit(1); });

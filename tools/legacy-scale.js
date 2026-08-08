/*
 * Upgrade path at real scale.
 *
 * Uses a 513-title fixture shaped like a real v1 library — same field
 * distribution, same "unlisted" quality values, and the same known-bad IMDb ids
 * (including two rows that share one id). No personal data.
 *
 * Point REAL_BACKUP at your own export to run this against live data:
 *   REAL_BACKUP=~/watchnext-backup.json node tools/legacy-scale.js
 */
const { chromium, devices } = require('/opt/node22/lib/node_modules/playwright');
const fs = require('fs'), path = require('path');

let pass = 0, fail = 0; const F = [];
const check = (n, c, d = '') => { if (c) { pass++; console.log(`  ok    ${n}`); } else { fail++; F.push(n); console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`); } };

const FILE = process.env.REAL_BACKUP || path.join(__dirname, 'fixtures', 'legacy-backup.json');
const BACKUP = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const LIB = BACKUP.library;
const BLANK = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');

const expect = {
  total: LIB.length,
  watched: LIB.filter(m => m.watched).length,
  saved: LIB.filter(m => m.watchlist).length,
  owned: LIB.filter(m => m.downloaded || ['4K', '1080p', 'unlisted'].includes(m.q)).length,
  fourK: LIB.filter(m => m.q === '4K').length,
};

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ ...devices['iPhone 13 Pro'] });
  await ctx.route('**://m.media-amazon.com/**', r => r.fulfill({ status: 200, contentType: 'image/gif', body: BLANK }));
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));

  await page.goto('http://127.0.0.1:8899/index.html', { waitUntil: 'domcontentloaded' });

  console.log(`\n─── migrating ${expect.total} titles from localStorage ───`);
  await page.evaluate(lib => { localStorage.clear(); localStorage.setItem('wn_lib2', JSON.stringify(lib)); }, LIB);
  const t0 = Date.now();
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('body.is-ready', { timeout: 20000 });
  const bootMs = Date.now() - t0;

  let s = await page.evaluate(() => JSON.parse(localStorage.getItem('wn.state.v3')));
  check(`all ${expect.total} titles migrate`, s.items.length === expect.total, `${s.items.length}`);
  check(`boots in under 3s`, bootMs < 3000, `${bootMs}ms`);
  check('watch history preserved', s.items.filter(i => i.watched).length === expect.watched);
  check('watchlist preserved', s.items.filter(i => i.saved).length === expect.saved);
  check('ownership preserved', s.items.filter(i => i.owned).length === expect.owned, `${s.items.filter(i=>i.owned).length} vs ${expect.owned}`);
  check('4K quality preserved', s.items.filter(i => i.quality === '4K').length === expect.fourK);
  check('"unlisted" is normalised away', !s.items.some(i => i.quality === 'unlisted'));
  check('inherited rows are flagged for re-checking', s.items.every(i => i.meta.status === 'stale'));
  check('uids are unique at scale', new Set(s.items.map(i => i.uid)).size === s.items.length);
  check('storage stays under 2MB', JSON.stringify(s).length < 2_000_000, `${Math.round(JSON.stringify(s).length / 1024)}KB`);

  console.log('\n─── two rows sharing one bad id stay separate records ───');
  const shared = await page.evaluate(() => {
    const items = window.__test.items();
    const byId = {};
    for (const i of items) if (i.imdbId) (byId[i.imdbId] ||= []).push(i.title);
    const dupes = Object.entries(byId).filter(([, v]) => new Set(v).size > 1);
    return { dupeCount: dupes.length, sample: dupes.slice(0, 3) };
  });
  check('a shared id does not merge two films', shared.dupeCount >= 1 && s.items.length === expect.total);
  check('nothing is silently deduplicated on import', s.items.length === expect.total);

  console.log('\n─── every screen works at this size ───');
  for (const tab of ['tonight', 'discover', 'library', 'ask']) {
    const t = Date.now();
    await page.click(`[data-tab="${tab}"]`);
    await page.waitForTimeout(450);
    const ms = Date.now() - t;
    const ok = await page.evaluate(x => {
      const el = document.getElementById(`screen-${x}`);
      return el.classList.contains('is-active') && el.textContent.trim().length > 20;
    }, tab);
    check(`${tab} renders (${ms}ms)`, ok && ms < 2500, `${ms}ms`);
  }

  const searchMs = await page.evaluate(async () => {
    const i = document.getElementById('library-search');
    const t = performance.now();
    i.value = 'fixture'; i.dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 350));
    const d = performance.now() - t;
    i.value = ''; i.dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 250));
    return d;
  });
  check('search stays responsive at scale', searchMs < 900, `${Math.round(searchMs)}ms`);

  console.log('\n─── restoring the v1 export FILE (not localStorage) ───');
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('body.is-ready');
  const imported = await page.evaluate(async (payload) => {
    const store = await import('./src/store.js');
    const parsed = store.readBackup(payload);
    if (!parsed) return { ok: false };
    store.importPayload(payload, 'replace');
    return { ok: true, total: store.items().length, watched: store.items().filter(i => i.watched).length };
  }, BACKUP);
  check('the v1 export format is recognised', imported.ok);
  check('all titles restore from the file', imported.total === expect.total, `${imported.total}`);
  check('watch history restores from the file', imported.watched === expect.watched);

  const merged = await page.evaluate(async (payload) => {
    const store = await import('./src/store.js');
    const before = store.items().length;
    store.importPayload(payload, 'merge');
    return { before, after: store.items().length };
  }, BACKUP);
  check('re-merging the same file is idempotent', merged.after === merged.before, `${merged.before} -> ${merged.after}`);

  console.log(`\n══════════  ${pass} passed, ${fail} failed  ══════════`);
  if (F.length) { console.log('\nFailures:'); F.forEach(f => console.log('  · ' + f)); }
  if (errs.length) { console.log('\nJS errors:'); errs.slice(0, 5).forEach(e => console.log('  ! ' + e)); }
  await browser.close();
  process.exit(fail || errs.length ? 1 : 0);
})().catch(e => { console.error('CRASHED:', e.message); process.exit(2); });

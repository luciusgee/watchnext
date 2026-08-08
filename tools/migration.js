/* Does a real v1 library survive the upgrade? The user has ~513 titles in the
   old wn_lib2 format with watch history they cannot afford to lose. */
const { chromium, devices } = require('/opt/node22/lib/node_modules/playwright');
let pass=0, fail=0; const F=[];
const check=(n,c,d='')=>{ if(c){pass++;console.log(`  ok    ${n}`);} else {fail++;F.push(n+(d?` — ${d}`:''));console.log(`  FAIL  ${n}${d?' — '+d:''}`);} };

// A faithful sample of the old shape, including its quirks.
const LEGACY = [
  { id:'tt1179933', t:'10 Cloverfield Lane', y:2016, g:'Thriller', r:7.2, q:'4K', tp:'movie', d:'A woman wakes in a bunker.', watched:true,  watchlist:false, swiped:true,  swipedAt:1700000000000, swipedSeen:true, downloaded:true,  watchedAt:1700000000000 },
  { id:'tt0090605', t:'Aliens',              y:1986, g:'Action',   r:8.4, q:'4K', tp:'movie', d:'Ripley returns.',           watched:false, watchlist:true,  swiped:false, swipedAt:null,          swipedSeen:false, downloaded:true,  watchedAt:null },
  { id:'tt9319668', t:'1899',                y:2022, g:'Drama',    r:7.3, q:'1080p', tp:'tv', d:'A ship adrift.',            watched:false, watchlist:false, swiped:false, swipedAt:null,          swipedSeen:false, downloaded:false, watchedAt:null },
  { t:'Hokum', y:2024, g:'Horror', r:null, q:null, tp:'movie', d:'', watched:true, watchlist:true, swipedSeen:true, watchedAt:1730000000000 },   // no id at all
  { id:'BADID',  t:'Evil dead burn', y:2025, g:'Horror', r:6.0, q:'4K', tp:'movie', d:'', watched:true, watchlist:true, watchedAt:1740000000000 }, // malformed id
];
const LEGACY_ACTIVITY = [{ type:'watched', title:'Hokum', at: 1730000000000 }];

(async () => {
  const browser = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args:['--no-sandbox'] });
  const ctx = await browser.newContext({ ...devices['iPhone 13 Pro'] });
  const page = await ctx.newPage();
  const errs=[]; page.on('pageerror', e=>errs.push(e.message));

  // Land on the page, plant the OLD storage, then load the NEW app over it.
  await page.goto('http://127.0.0.1:8899/index.html', { waitUntil:'domcontentloaded' });
  await page.evaluate(([lib, act]) => {
    localStorage.clear();
    localStorage.setItem('wn_lib2', JSON.stringify(lib));
    localStorage.setItem('wn_activity', JSON.stringify(act));
    localStorage.setItem('wn_apikey', 'sk-ant-legacy-key');
  }, [LEGACY, LEGACY_ACTIVITY]);
  await page.reload({ waitUntil:'networkidle' });
  await page.waitForTimeout(1200);

  const s = await page.evaluate(() => JSON.parse(localStorage.getItem('wn.state.v3')));
  check('legacy library is picked up', !!s && Array.isArray(s.items), 'no new state written');
  check('every legacy title is carried over', s.items.length === LEGACY.length, `${s.items.length}/${LEGACY.length}`);
  check('the old key is left intact as a fallback',
    await page.evaluate(() => !!localStorage.getItem('wn_lib2')));

  const byTitle = t => s.items.find(i => i.title === t);
  check('watched state survives', byTitle('10 Cloverfield Lane').watched === true);
  check('watched timestamp survives', byTitle('10 Cloverfield Lane').watchedAt === 1700000000000);
  check('watchlist survives', byTitle('Aliens').saved === true);
  check('swipe progress survives', byTitle('10 Cloverfield Lane').seen === true);
  check('type survives', byTitle('1899').type === 'tv');
  check('quality survives', byTitle('1899').quality === '1080p');
  check('ownership is inferred from quality on first import only', byTitle('Aliens').owned === true);
  check('a title with no id migrates fine', byTitle('Hokum').imdbId === null && byTitle('Hokum').watched === true);
  check('a malformed id is discarded rather than trusted', byTitle('Evil dead burn').imdbId === null);
  check('every migrated row gets a uid', s.items.every(i => typeof i.uid === 'string' && i.uid.length > 4));
  check('uids are unique', new Set(s.items.map(i=>i.uid)).size === s.items.length);
  check('legacy rows are flagged for re-verification',
    s.items.every(i => i.meta.status === 'stale'), JSON.stringify(s.items.map(i=>i.meta.status)));
  check('activity log carries over', Array.isArray(s.activity) && s.activity.length === 1);
  check('the legacy API key is NOT silently adopted', !s.settings.aiKey);

  // Second load must not re-run the migration or duplicate anything.
  await page.evaluate(() => window.__test.update(window.__test.items()[0].uid, { title: 'Renamed By User' }));
  await page.waitForTimeout(300);
  await page.reload({ waitUntil:'networkidle' });
  await page.waitForTimeout(1000);
  const s2 = await page.evaluate(() => JSON.parse(localStorage.getItem('wn.state.v3')));
  check('migration does not re-run on the next load', s2.items.length === LEGACY.length, `${s2.items.length}`);
  check('post-migration edits are preserved', s2.items.some(i => i.title === 'Renamed By User'));

  console.log(`\n══════════  ${pass} passed, ${fail} failed  ══════════`);
  if (F.length) { console.log('\nFailures:'); F.forEach(f=>console.log('  · '+f)); }
  if (errs.length) { console.log('\nJS errors:'); errs.slice(0,5).forEach(e=>console.log('  ! '+e)); }
  await browser.close();
  process.exit(fail||errs.length ? 1 : 0);
})().catch(e=>{ console.error('CRASHED:', e.message); process.exit(2); });

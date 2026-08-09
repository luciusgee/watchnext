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
  /* Every other suite stubs these; this one did not, so a reload after seeding
     a legacy library went out for real poster art. Those requests never settle
     in this environment, so `networkidle` timed out and the suite failed in a
     way that looked like a migration bug. */
  const BLANK = Buffer.from('R0lGODlhAQABAAAAACw=', 'base64');
  await ctx.route('**://image.tmdb.org/**', r => r.fulfill({ status:200, contentType:'image/gif', body:BLANK }));
  await ctx.route('**://m.media-amazon.com/**', r => r.fulfill({ status:200, contentType:'image/gif', body:BLANK }));
  const page = await ctx.newPage();
  const errs=[]; page.on('pageerror', e=>errs.push(e.message));

  // Land on the page, plant the OLD storage, then load the NEW app over it.
  // Wait for the first boot to *finish* before planting: on domcontentloaded
  // alone it is still running, and it seeds and saves its own library over the
  // keys we just wrote — intermittently, depending on how the two interleave.
  await page.goto('http://127.0.0.1:8899/index.html', { waitUntil:'domcontentloaded' });
  await page.waitForSelector('body.is-ready');
  await page.evaluate(([lib, act]) => {
    localStorage.clear();
    localStorage.setItem('wn_lib2', JSON.stringify(lib));
    localStorage.setItem('wn_activity', JSON.stringify(act));
    localStorage.setItem('wn_apikey', 'sk-ant-legacy-key');
  }, [LEGACY, LEGACY_ACTIVITY]);
  await page.reload({ waitUntil:'domcontentloaded' });
  await page.waitForSelector('body.is-ready');
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
  await page.reload({ waitUntil:'domcontentloaded' });
  await page.waitForSelector('body.is-ready');
  await page.waitForTimeout(1000);
  const s2 = await page.evaluate(() => JSON.parse(localStorage.getItem('wn.state.v3')));
  check('migration does not re-run on the next load', s2.items.length === LEGACY.length, `${s2.items.length}`);
  check('post-migration edits are preserved', s2.items.some(i => i.title === 'Renamed By User'));


  /* ────────────────────────────────────────────────────────────
   * A real library, from the build before the watchlist was collapsed.
   *
   * The collapse is deliberately a code change and not a data migration: the
   * `saved` / `saved_at` fields stay on every item, they simply stop being
   * read. That decision only means anything if it is enforced, so this plants a
   * 512-title library with watchlist flags, watch history, ownership, quality,
   * locked fields and enrichment bookkeeping — then boots the new code twice
   * and checks that every single title comes out the other side unchanged.
   *
   * "Keep my titles" is the requirement. This is the test for it.
   * ──────────────────────────────────────────────────────────── */
  console.log('\n─── a 512-title library survives the watchlist collapse ───');

  const GENRES = ['Horror', 'Drama', 'Sci-Fi', 'Action', 'Comedy', 'Thriller', 'Western'];
  const before = Array.from({ length: 512 }, (_, i) => ({
    uid: `pre${i}`,
    title: `Pre-Collapse Film ${i}`,
    sortTitle: `pre-collapse film ${i}`,
    year: 1960 + (i % 65),
    type: i % 11 === 0 ? 'tv' : 'movie',
    genre: GENRES[i % GENRES.length],
    genres: [GENRES[i % GENRES.length], GENRES[(i + 3) % GENRES.length]],
    rating: 3 + (i % 70) / 10,
    runtime: 78 + (i % 90),
    overview: `Overview for ${i}.`,
    poster: `https://image.tmdb.org/t/p/w500/p${i}.jpg`,
    imdbId: `tt${String(7000000 + i).padStart(7, '0')}`,
    quality: [null, '4K', '1080p', '720p'][i % 4],
    owned: i % 3 !== 0,
    watched: i % 5 === 0,
    watchedAt: i % 5 === 0 ? 1700000000000 + i : null,
    saved: i % 7 === 0,                       // the retired watchlist
    saved_at: i % 7 === 0 ? 1690000000000 + i : null,
    seen: i % 4 === 0,
    seenAt: i % 4 === 0 ? 1695000000000 + i : null,
    addedAt: 1600000000000 + i * 1000,
    locked: i % 13 === 0 ? ['title', 'year'] : [],
    meta: { v: 2, status: 'confirmed', at: 1700000000000, confidence: 0.9, source: i % 17 === 0 ? 'user' : 'auto' },
  }));

  await page.evaluate((items) => {
    localStorage.clear();
    localStorage.setItem('wn.state.v3', JSON.stringify({
      schema: 3, items, activity: [],
      settings: { name: 'Luke', provider: 'omdb', dataKeys: {}, seeded: true, libraryView: 'list' },
    }));
  }, before);

  await page.goto('http://127.0.0.1:8899/index.html', { waitUntil: 'networkidle' });
  await page.waitForSelector('body.is-ready');
  await page.waitForTimeout(900);
  /* Twice, because a bad migration often survives one boot and eats the data on
     the save that follows it. */
  await page.goto('http://127.0.0.1:8899/index.html', { waitUntil: 'networkidle' });
  await page.waitForSelector('body.is-ready');
  await page.waitForTimeout(900);

  const after = await page.evaluate(() => JSON.parse(localStorage.getItem('wn.state.v3')).items);

  check('all 512 titles are still there', after.length === 512, `${after.length}`);

  const byUid = new Map(after.map((i) => [i.uid, i]));
  const missing = before.filter((b) => !byUid.has(b.uid));
  check('not one uid went missing', missing.length === 0, `${missing.length} lost`);

  /* Field by field across every title, so a single dropped property on a single
     record fails this rather than hiding in an aggregate. */
  const changed = [];
  for (const b of before) {
    const a = byUid.get(b.uid);
    if (!a) continue;
    for (const k of Object.keys(b)) {
      if (JSON.stringify(b[k]) !== JSON.stringify(a[k])) changed.push(`${b.uid}.${k}`);
    }
  }
  check('every field of every title is byte-identical', changed.length === 0,
    `${changed.length} changed, e.g. ${changed.slice(0, 4).join(', ')}`);

  const stillFlagged = after.filter((i) => i.saved).length;
  check('the retired watchlist flags are kept, not stripped', stillFlagged === 74, `${stillFlagged}`);

  /* Booting is only half of it, and the weaker half: items loaded from storage
     are handed back as they were parsed, so a boot cannot lose a field it does
     not know about. The path that CAN is a backup — readBackup rebuilds every
     item through makeItem, so any field makeItem forgets to declare is gone the
     moment someone restores. Verified by deleting `saved` from makeItem: the
     boot checks above stayed green and only this one caught it. */
  const restored = await page.evaluate(() => {
    const store = window.__test;
    const payload = JSON.parse(JSON.stringify(store.exportPayload()));
    store.importPayload(payload, 'replace');
    return store.items();
  });
  const backupMap = new Map(restored.map((i) => [i.uid, i]));
  const lostInBackup = [];
  for (const b of before) {
    const a = backupMap.get(b.uid);
    if (!a) { lostInBackup.push(`${b.uid}.MISSING`); continue; }
    for (const k of Object.keys(b)) {
      if (JSON.stringify(b[k]) !== JSON.stringify(a[k])) lostInBackup.push(`${b.uid}.${k}`);
    }
  }
  check('and a full backup round trip of all 512 loses nothing either',
    lostInBackup.length === 0,
    `${lostInBackup.length} changed, e.g. ${[...new Set(lostInBackup.map((x) => x.split('.')[1]))].slice(0, 5).join(', ')}`);

  /* And the app is actually usable with it — a boot that throws would leave the
     data intact and the app dead, which is not a pass. */
  const usable = await page.evaluate(() => ({
    pile: window.__test ? null : null,
    tabs: document.querySelectorAll('.tabbar .tab').length,
    rendered: document.querySelectorAll('#screen-tonight [data-region="body"] *').length,
  }));
  check('and the app boots and renders on top of it',
    usable.tabs === 4 && usable.rendered > 0, JSON.stringify(usable));

  console.log(`\n══════════  ${pass} passed, ${fail} failed  ══════════`);
  if (F.length) { console.log('\nFailures:'); F.forEach(f=>console.log('  · '+f)); }
  if (errs.length) { console.log('\nJS errors:'); errs.slice(0,5).forEach(e=>console.log('  ! '+e)); }
  await browser.close();
  process.exit(fail||errs.length ? 1 : 0);
})().catch(e=>{ console.error('CRASHED:', e.message); process.exit(2); });

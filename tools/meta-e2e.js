/*
 * Metadata pipeline test against a mock OMDb, covering the owner's two
 * complaints: "it does all entries every time" and "it pulls the wrong images".
 */
const { chromium, devices } = require('/opt/node22/lib/node_modules/playwright');
let pass = 0, fail = 0; const failures = [];
const check = (n, c, d = '') => { if (c) { pass++; console.log(`  ok    ${n}`); } else { fail++; failures.push(n + (d?` — ${d}`:'')); console.log(`  FAIL  ${n}${d?' — '+d:''}`); } };

// A deliberately hostile mock: the ?t= endpoint returns a fuzzy near-match, the
// way the real OMDb returns "Making 1899" when you ask for "1899".
const CATALOG = [
  { Title: 'Blade Runner',      Year: '1982', Type: 'movie',  imdbID: 'tt0083658', Genre: 'Sci-Fi',  Runtime: '117 min', imdbRating: '8.1', Plot: 'A blade runner must pursue replicants.', Poster: 'https://m.media-amazon.com/images/M/br1982.jpg' },
  { Title: 'Blade Runner 2049', Year: '2017', Type: 'movie',  imdbID: 'tt1856101', Genre: 'Sci-Fi',  Runtime: '164 min', imdbRating: '8.0', Plot: 'A young blade runner uncovers a secret.', Poster: 'https://m.media-amazon.com/images/M/br2049.jpg' },
  { Title: 'Making Blade Runner', Year: '1982', Type: 'movie', imdbID: 'tt9999001', Genre: 'Documentary', Runtime: '50 min', imdbRating: '6.9', Plot: 'Behind the scenes.', Poster: 'https://m.media-amazon.com/images/M/mbr.jpg' },
  { Title: '1899',              Year: '2022', Type: 'series', imdbID: 'tt9319668', Genre: 'Mystery', Runtime: '56 min',  imdbRating: '7.3', Plot: 'Migrants encounter a riddle at sea.', Poster: 'https://m.media-amazon.com/images/M/1899.jpg' },
  { Title: 'Making 1899',       Year: '2022', Type: 'movie',  imdbID: 'tt2383010', Genre: 'Documentary', Runtime: '50 min', imdbRating: '6.5', Plot: 'Behind the scenes.', Poster: 'https://m.media-amazon.com/images/M/m1899.jpg' },
];

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ ...devices['iPhone 13 Pro'] });

  let requests = [];
  await ctx.route('**://www.omdbapi.com/**', route => {
    const u = new URL(route.request().url());
    requests.push(u.search);
    const j = o => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

    if (u.searchParams.get('i')) {
      const hit = CATALOG.find(c => c.imdbID === u.searchParams.get('i'));
      return j(hit ? { ...hit, Response: 'True' } : { Response: 'False', Error: 'Incorrect IMDb ID.' });
    }
    if (u.searchParams.get('s')) {
      const q = u.searchParams.get('s').toLowerCase();
      let hits = CATALOG.filter(c => c.Title.toLowerCase().includes(q));
      const type = u.searchParams.get('type');
      if (type) hits = hits.filter(c => c.Type === type);
      return hits.length ? j({ Response: 'True', Search: hits.map(({Title,Year,Type,imdbID,Poster}) => ({Title,Year,Type,imdbID,Poster})) })
                         : j({ Response: 'False', Error: 'Movie not found!' });
    }
    if (u.searchParams.get('t')) {
      // fuzzy, exactly like the real thing — this is the trap
      const q = u.searchParams.get('t').toLowerCase();
      const type = u.searchParams.get('type');
      let hits = CATALOG.filter(c => c.Title.toLowerCase().includes(q));
      if (type) hits = hits.filter(c => c.Type === type);
      return hits.length ? j({ ...hits[0], Response: 'True' }) : j({ Response: 'False', Error: 'Movie not found!' });
    }
    return j({ Response: 'False', Error: 'Bad request.' });
  });
  await ctx.route('**://m.media-amazon.com/**', r => r.fulfill({ status: 200, contentType: 'image/gif', body: Buffer.from('R0lGODlhAQABAAAAACw=', 'base64') }));

  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto('http://127.0.0.1:8899/index.html', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);

  // Fresh, tiny library so counts are legible
  await page.evaluate(() => {
    const k = 'wn.state.v3';
    const s = JSON.parse(localStorage.getItem(k));
    s.items = [];
    s.settings.omdbKey = 'testkey';
    localStorage.setItem(k, JSON.stringify(s));
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(900);

  await page.evaluate(() => {
    window.__test.add({ title: 'Blade Runner',   year: 1982, type: 'movie' });
    window.__test.add({ title: 'Blade Runner',   year: 2017, type: 'movie' });  // same title, different film
    window.__test.add({ title: '1899',           year: 2022, type: 'movie' });  // WRONG type on purpose
    window.__test.add({ title: 'Nonexistent Zqx', year: 2020, type: 'movie' });
  });
  await page.waitForTimeout(300);

  const runSweep = () => page.evaluate(async () => {
    const meta = await import('./src/metadata.js');
    const store = await import('./src/store.js');
    const list = store.items().filter(i => meta.needsEnrichment(i));
    const budget = new meta.RequestBudget(9999);
    const res = await meta.sweep(list, {
      key: store.settings().omdbKey, budget, delay: 0,
      apply: (item, r) => {
        if (r.status === 'matched' && r.chosen) store.update(item.uid, meta.toPatch(item, r.chosen, r.confidence));
        else store.update(item.uid, { meta: { v: meta.META_VERSION, status: r.status, at: Date.now(), confidence: r.confidence,
              candidates: (r.candidates||[]).map(c => ({ imdbId: c.imdbID, title: c.Title, year: c.Year, type: c.Type, poster: c.Poster })) } });
      },
    });
    store.saveNow();
    return { ...res, considered: list.length };
  });

  console.log('\n─── first sweep ───');
  requests = [];
  const r1 = await runSweep();
  const reqs1 = requests.length;
  console.log(`   considered=${r1.considered} matched=${r1.matched} review=${r1.review} unmatched=${r1.unmatched} requests=${reqs1}`);
  check('sweep considers every unresolved title', r1.considered === 4, `${r1.considered}`);

  let s = await page.evaluate(() => JSON.parse(localStorage.getItem('wn.state.v3')));
  const br82 = s.items.find(i => i.title.startsWith('Blade Runner') && i.year === 1982);
  const br49 = s.items.find(i => i.year === 2017);
  const y1899 = s.items.find(i => i.title === '1899');
  const nope  = s.items.find(i => i.title === 'Nonexistent Zqx');

  check('same-title films resolve to DIFFERENT imdb ids',
    br82.imdbId === 'tt0083658' && br49.imdbId === 'tt1856101',
    `1982->${br82.imdbId}  2017->${br49.imdbId}`);
  check('never drifts onto the behind-the-scenes documentary',
    br82.imdbId !== 'tt9999001' && br49.imdbId !== 'tt9999001');
  check('wrong stored type does not force a wrong match (the 1899 bug)',
    y1899.imdbId === 'tt9319668', `got ${y1899.imdbId} "${y1899.title}"`);
  check('a title with no real match is NOT silently given one',
    nope.imdbId === null && nope.meta.status !== 'matched', `${nope.imdbId} / ${nope.meta.status}`);
  check('matched items record a confidence score',
    typeof br82.meta.confidence === 'number' && br82.meta.confidence > 0.8, `${br82.meta.confidence}`);
  check('posters and runtimes are written', !!br82.poster && br82.runtime === 117, `${br82.runtime}`);

  console.log('\n─── second sweep (the "does all entries every time" bug) ───');
  requests = [];
  const r2 = await runSweep();
  const reqs2 = requests.length;
  console.log(`   considered=${r2.considered} requests=${reqs2}`);
  check('a re-run skips everything already resolved', r2.considered < r1.considered, `${r1.considered} -> ${r2.considered}`);
  check('a re-run makes far fewer network calls', reqs2 < reqs1, `${reqs1} -> ${reqs2}`);
  check('resolved items are never re-fetched',
    await page.evaluate(() => import('./src/metadata.js').then(m => import('./src/store.js').then(st =>
      st.items().filter(i => i.meta.status === 'matched').every(i => !m.needsEnrichment(i))))));

  console.log('\n─── user edits are never overwritten ───');
  await page.evaluate(() => {
    const st = window.__test;
    const i = st.items().find(x => x.year === 1982);
    st.update(i.uid, { genre: 'Neo-noir', locked: ['genre', 'title'], meta: { v: 0, status: 'pending', at: null, confidence: null } });
  });
  await page.waitForTimeout(200);
  await runSweep();
  s = await page.evaluate(() => JSON.parse(localStorage.getItem('wn.state.v3')));
  const edited = s.items.find(i => i.year === 1982);
  check('a locked field survives a re-sweep', edited.genre === 'Neo-noir', `got ${edited.genre}`);
  check('unlocked fields still refresh', edited.runtime === 117);

  console.log('\n─── review queue ───');
  const reviewables = s.items.filter(i => i.meta.status === 'review' || i.meta.status === 'unmatched');
  check('ambiguous/absent titles land in the review queue', reviewables.length >= 1, `${reviewables.length}`);

  console.log(`\n══════════  ${pass} passed, ${fail} failed  ══════════`);
  if (failures.length) { console.log('\nFailures:'); failures.forEach(f => console.log('  · ' + f)); }
  if (errs.length) { console.log('\nJS errors:'); errs.slice(0,5).forEach(e => console.log('  ! ' + e)); }
  await browser.close();
  process.exit(fail || errs.length ? 1 : 0);
})().catch(e => { console.error('CRASHED:', e.message, '\n', e.stack); process.exit(2); });

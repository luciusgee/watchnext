/*
 * Titles kept as they are, details filled in, and choices made through the
 * other database.
 *
 * The case as it happened: a library matched through OMDb, then switched to
 * TMDB. Settings said "520 titles — 505 verified": the other fifteen had been
 * kept as they were ("Leave it alone") because their details were already
 * right, and counted as nothing. Picking a film in the review list marked it
 * verified but never replaced the poster: the stored candidates carried OMDb
 * ids, which TMDB cannot look up. And the only other button always showing
 * was "Re-check everything".
 */
const { chromium, devices } = require('/opt/node22/lib/node_modules/playwright');

const APP_URL = 'http://127.0.0.1:8899/index.html';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

const CATALOG = [
  { key: 's1899', title: '1899', year: 2022, type: 'tv', imdb: 'tt9319668', tmdb: 90669, genre: 'Mystery', runtime: 56, plot: 'Migrants encounter a riddle at sea.' },
  { key: 'se7en', title: 'Se7en', year: 1995, type: 'movie', imdb: 'tt0114369', tmdb: 807, genre: 'Crime', runtime: 127, plot: 'Two detectives hunt a killer.' },
  { key: 'br1982', title: 'Blade Runner', year: 1982, type: 'movie', imdb: 'tt0083658', tmdb: 78, genre: 'Science Fiction', runtime: 117, plot: 'A blade runner must pursue replicants.' },
  { key: 'alien', title: 'Alien', year: 1979, type: 'movie', imdb: 'tt0078748', tmdb: 348, genre: 'Horror', runtime: 117, plot: 'The crew of the Nostromo.' },
  { key: 'arrival', title: 'Arrival', year: 2016, type: 'movie', imdb: 'tt2543164', tmdb: 329865, genre: 'Drama', runtime: 116, plot: 'A linguist is recruited.' },
  /* TMDB has no running time for this one, however often it is asked. */
  { key: 'short', title: 'A Short Film', year: 2020, type: 'movie', imdb: 'tt0000777', tmdb: 777, genre: 'Drama', runtime: null, plot: 'Brief.' },
];

function tmdbRoute(route, hits) {
  const u = new URL(route.request().url());
  hits.push(u.pathname + u.search);
  const j = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  const lite = (c) => (c.type === 'tv'
    ? { id: c.tmdb, media_type: 'tv', name: c.title, first_air_date: `${c.year}-01-01`, poster_path: `/${c.key}.jpg`, overview: '', vote_average: 7, vote_count: 900, genre_ids: [] }
    : { id: c.tmdb, media_type: 'movie', title: c.title, release_date: `${c.year}-01-01`, poster_path: `/${c.key}.jpg`, overview: '', vote_average: 7, vote_count: 900, genre_ids: [] });
  const full = (c) => (c.type === 'tv'
    ? { id: c.tmdb, name: c.title, first_air_date: `${c.year}-01-01`, episode_run_time: [c.runtime], genres: [{ id: 1, name: c.genre }], overview: c.plot, vote_average: 7, vote_count: 900, poster_path: `/${c.key}.jpg`, external_ids: { imdb_id: c.imdb } }
    : { id: c.tmdb, title: c.title, release_date: `${c.year}-01-01`, runtime: c.runtime, genres: [{ id: 1, name: c.genre }], overview: c.plot, vote_average: 7, vote_count: 900, poster_path: `/${c.key}.jpg`, imdb_id: c.imdb, external_ids: { imdb_id: c.imdb } });
  const p = u.pathname;
  if (p.startsWith('/3/search/')) {
    const q = (u.searchParams.get('query') || '').toLowerCase();
    return j({ page: 1, results: CATALOG.filter((c) => c.title.toLowerCase().includes(q)).map(lite) });
  }
  if (p.startsWith('/3/find/')) {
    const hit = CATALOG.find((c) => c.imdb === p.split('/').pop());
    if (!hit) return j({ movie_results: [], tv_results: [] });
    return j(hit.type === 'tv' ? { movie_results: [], tv_results: [lite(hit)] } : { movie_results: [lite(hit)], tv_results: [] });
  }
  const m = p.match(/^\/3\/(movie|tv)\/(\d+)/);
  if (m) {
    const hit = CATALOG.find((c) => String(c.tmdb) === m[2]);
    return hit ? j(full(hit)) : route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  }
  return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ ...devices['iPhone 13 Pro'] });
  const hits = [];
  await ctx.route('**://api.themoviedb.org/**', (r) => tmdbRoute(r, hits));
  await ctx.route(/image\.tmdb\.org|m\.media-amazon\.com|omdbapi\.com|api\.anthropic\.com|api\.github\.com/, (r) =>
    r.fulfill({ status: 200, contentType: 'image/gif', body: Buffer.from('R0lGODlhAQABAAAAACw=', 'base64') }));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(APP_URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('body.is-ready');

  /* The library as it was: matched through OMDb, now on TMDB. */
  await page.evaluate(() => {
    const st = JSON.parse(localStorage.getItem('wn.state.v3'));
    const base = (uid, title, year, type, imdbId, meta, extra = {}) => ({
      uid, title, sortTitle: title.toLowerCase(), year, type, genres: [], imdbId, owned: true, watched: false,
      watchedBy: {}, poster: `https://m.media-amazon.com/images/M/wrong-${uid}.jpg`, overview: 'Another film entirely.',
      addedAt: 1, updatedAt: 1, locked: [], meta, ...extra,
    });
    const skipped = { v: 2, status: 'skipped', at: 1754700000000 };
    st.items = [
      base('a', '1899', 2007, 'movie', 'tt0128997', skipped),
      base('b', 'Se7en', 1995, 'movie', 'tt0114369', skipped),
      base('c', 'Blade Runer', 1982, 'movie', null, {
        v: 2, status: 'review', at: 1, confidence: 0.6,
        /* Found through OMDb: its ids are IMDb ids. */
        candidates: [{ sourceId: 'tt0083658', imdbId: 'tt0083658', title: 'Blade Runner', year: 1982, type: 'movie', poster: null }],
      }),
      /* Picked from the review list today, before this fix: saved as done,
         details never arrived. */
      base('d', 'Alien', 1979, 'movie', 'tt0078748', { v: 2, status: 'matched', at: Date.now(), confidence: 1, source: 'user', sourceId: 'tt0078748' }),
      /* Verified, but short of a poster and a description. */
      base('e', 'Arrival', 2016, 'movie', 'tt2543164', { v: 2, status: 'matched', at: Date.now(), confidence: 1, source: 'tmdb', sourceId: '329865' }, { poster: null, overview: '', runtime: 116, genres: ['Drama'] }),
      /* Verified, and TMDB will never have a running time for it. */
      base('f', 'A Short Film', 2020, 'movie', 'tt0000777', { v: 2, status: 'matched', at: Date.now(), confidence: 1, source: 'tmdb', sourceId: '777' }, { runtime: null, genres: ['Drama'] }),
    ];
    st.settings.provider = 'tmdb';
    st.settings.dataKeys = { tmdb: '0123456789abcdef0123456789abcdef' };
    st.settings.keyStatus = { tmdb: { ok: true, message: '', at: Date.now() } };
    localStorage.setItem('wn.state.v3', JSON.stringify(st));
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('body.is-ready');
  await page.evaluate(() => document.querySelector('[data-nav="settings"]').click());
  await page.waitForTimeout(500);

  const sweepText = () => page.evaluate(() => document.querySelector('[data-region="sweep"] .group-item-s')?.textContent || '');
  const sweepButtons = () => page.evaluate(() => [...document.querySelectorAll('[data-region="sweep"] button')].map((b) => b.textContent.trim()));
  const tapSweep = (re) => page.evaluate((src) => [...document.querySelectorAll('[data-region="sweep"] button')].find((b) => new RegExp(src).test(b.textContent)).click(), re);
  const settle = () => page.waitForFunction(() => !/Looking up|Starting/.test(document.querySelector('[data-region="sweep-status"]')?.textContent || ''), null, { timeout: 15000 }).then(() => page.waitForTimeout(300));

  console.log('\n─── kept as it is counts as verified ───');
  const summary = await sweepText();
  check('titles kept as they are count as verified — 2 kept + 3 matched', /5 verified/.test(summary), summary);
  check('nothing says "left as they were" or offers to check them again', !/left as they were/.test(summary) && !(await sweepButtons()).some((t) => /again/.test(t)), summary);
  check('a choice whose details never arrived is waiting for them', /1 waiting for details/.test(summary), summary);
  check('and titles short of a poster or details are counted', /2 missing a poster or details/.test(summary), summary);

  console.log('\n─── the review list ───');
  hits.length = 0;
  await tapSweep('Review');
  await page.waitForTimeout(500);
  const card = await page.evaluate(() => {
    const c = document.querySelector('[data-review="c"]');
    return { now: /What it has now/.test(c.textContent), poster: !!c.querySelector('.poster, img'), keep: [...c.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Keep as it is') };
  });
  check('each card shows what the title has now, poster and all', card.now && card.poster, JSON.stringify(card));
  check('and the button to keep it says so', card.keep, JSON.stringify(card));
  await page.evaluate(() => document.querySelector('[data-review="c"] .result-row').click());
  await page.waitForTimeout(800);
  const c = await page.evaluate(() => window.__test.byUid('c'));
  check('an OMDb candidate is looked up by its IMDb id', hits.some((h) => h.startsWith('/3/find/tt0083658')), JSON.stringify(hits));
  check('and the poster is replaced', /br1982/.test(c.poster || ''), c.poster);
  check('and the description', c.overview === 'A blade runner must pursue replicants.', c.overview);
  check('and a picked film takes its proper name', c.title === 'Blade Runner', c.title);
  check('and it is recorded as your choice', c.meta.status === 'matched' && c.meta.source === 'user' && !!c.meta.chosenAt, JSON.stringify(c.meta));
  await page.evaluate(() => [...document.querySelectorAll('.panel.is-open button, .sheet.is-open button')].find((b) => b.textContent.trim() === 'Done')?.click());
  await page.waitForTimeout(500);

  console.log('\n─── checking only what needs it ───');
  hits.length = 0;
  await tapSweep('^Check');
  await settle();
  const d = await page.evaluate(() => window.__test.byUid('d'));
  check('the choice whose details never arrived now has them', /alien/.test(d.poster || '') && d.overview === 'The crew of the Nostromo.', `${d.poster} ${d.overview}`);
  check('and is still marked as your choice', d.meta.source === 'user' && !!d.meta.chosenAt, JSON.stringify(d.meta));
  const kept = await page.evaluate(() => ['a', 'b'].map((u) => window.__test.byUid(u)));
  check('titles kept as they are were not touched', kept.every((k) => k.meta.status === 'skipped' && /wrong-/.test(k.poster)), JSON.stringify(kept.map((k) => [k.meta.status, k.poster])));

  check('"Fill in 2 missing" is offered', (await sweepButtons()).some((t) => /Fill in 2 missing/.test(t)), JSON.stringify(await sweepButtons()));
  hits.length = 0;
  await tapSweep('Fill in');
  await settle();
  const [e, f] = await page.evaluate(() => ['e', 'f'].map((u) => window.__test.byUid(u)));
  check('filling in fetches only the titles short of something', hits.filter((h) => /\/3\/(movie|tv|find)\//.test(h)).every((h) => /329865|777/.test(h)) && hits.length > 0, JSON.stringify(hits));
  check('and the missing poster and description arrive', /arrival/.test(e.poster || '') && e.overview === 'A linguist is recruited.', `${e.poster} ${e.overview}`);
  check('a title the database cannot complete is not offered again straight away', !!f.meta.filledAt && !(await sweepButtons()).some((t) => /Fill in/.test(t)), JSON.stringify([f.meta, await sweepButtons()]));
  check('and then everything reads as verified', /All 6 titles have verified details|Everything is up to date/.test((await sweepText()) + (await page.evaluate(() => document.querySelector('[data-region="sweep-status"]').textContent))), await sweepText());

  console.log('\n─── re-checking everything ───');
  const recheck = (await sweepButtons()).find((t) => /Re-check all/.test(t));
  check('re-checking everything is still there, but small and apart', !!recheck && (await page.evaluate(() => [...document.querySelectorAll('[data-region="sweep"] button')].find((b) => /Re-check all/.test(b.textContent)).classList.contains('btn-sm'))), recheck);
  hits.length = 0;
  await tapSweep('Re-check all');
  await page.waitForTimeout(400);
  await page.evaluate(() => [...document.querySelectorAll('.sheet.is-open button')].find((b) => b.textContent.trim() === 'Re-check everything').click());
  await settle();
  const after = await page.evaluate(() => ['a', 'b', 'c', 'd', 'e', 'f'].map((u) => window.__test.byUid(u)));
  check('it leaves titles you kept as they are alone', after.slice(0, 2).every((k) => k.meta.status === 'skipped' && /wrong-/.test(k.poster)), JSON.stringify(after.slice(0, 2).map((k) => k.meta.status)));
  check('and a verified title stays verified', after.slice(2).every((k) => k.meta.status === 'matched'), JSON.stringify(after.slice(2).map((k) => k.meta.status)));

  console.log('\n─── no errors ───');
  check('no JavaScript errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('\nFailures:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.log('SUITE CRASHED:', e.message); process.exit(1); });

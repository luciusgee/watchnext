/*
 * Titles left alone, and choices made through the other database.
 *
 * The case as it happened: a library matched through OMDb, then switched to
 * TMDB. Settings said "520 titles — 505 verified" and "Everything is up to
 * date" — the other fifteen had been left alone months earlier, carried
 * another film's details from the old app, and were in neither the count nor
 * the review list. Picking a film in the review list marked it verified but
 * never replaced the poster: the stored candidates carried OMDb ids, which
 * TMDB cannot look up.
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

  console.log('\n─── nothing is hidden ───');
  const summary = await page.evaluate(() => document.querySelector('[data-region="sweep"] .group-item-s')?.textContent || '');
  check('the titles left alone are counted', /2 left as they were/.test(summary), summary);
  check('and so is a choice whose details never arrived', /1 waiting for details/.test(summary), summary);
  const buttons = await page.evaluate(() => [...document.querySelectorAll('[data-region="sweep"] button')].map((b) => b.textContent.trim()));
  check('there is a button to check the left-alone titles again', buttons.some((t) => /Check 2 again/.test(t)), JSON.stringify(buttons));
  check('and it no longer claims everything is up to date', !/Everything is up to date/.test(await page.evaluate(() => document.querySelector('[data-region="sweep-status"]').textContent)));

  console.log('\n─── picking through the other database ───');
  hits.length = 0;
  await page.evaluate(() => [...document.querySelectorAll('[data-region="sweep"] button')].find((b) => /Review/.test(b.textContent)).click());
  await page.waitForTimeout(500);
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

  console.log('\n─── checking them again ───');
  hits.length = 0;
  await page.evaluate(() => [...document.querySelectorAll('[data-region="sweep"] button')].find((b) => /again/.test(b.textContent)).click());
  await page.waitForFunction(() => /need you to choose|verified details/.test(document.querySelector('[data-region="sweep"] .group-item-s')?.textContent || '') && !/left as they were/.test(document.querySelector('[data-region="sweep"] .group-item-s')?.textContent || ''), null, { timeout: 15000 }).catch(() => {});
  const after = await page.evaluate(() => ['a', 'b', 'd'].map((u) => window.__test.byUid(u)));
  const [a, b, d] = after;
  check('a left-alone title is searched again', !!a && a.meta.status !== 'skipped' && !!b && b.meta.status !== 'skipped', JSON.stringify([a?.meta?.status, b?.meta?.status]));
  const search1899 = hits.find((h) => h.startsWith('/3/search/') && /query=1899/.test(h)) || '';
  check('without the year of the film it was wrongly matched to', !/year=2007/.test(search1899), search1899);
  const cands = a.meta.status === 'matched' ? [{ sourceId: a.meta.sourceId, type: a.type, year: a.year }] : a.meta.candidates || [];
  check('and "1899" filed as a 2007 film now finds the 2022 series', cands.some((x) => x.type === 'tv' && x.year === 2022), JSON.stringify(cands));
  check('with TMDB ids, so picking one works', cands.every((x) => /^\d+$/.test(String(x.sourceId))), JSON.stringify(cands));
  check('the choice whose details never arrived now has them', /alien/.test(d.poster || '') && d.overview === 'The crew of the Nostromo.', `${d.poster} ${d.overview}`);
  const summary2 = await page.evaluate(() => document.querySelector('[data-region="sweep"] .group-item-s')?.textContent || '');
  check('and nothing is waiting any more', !/waiting for details|left as they were/.test(summary2), summary2);

  console.log('\n─── no errors ───');
  check('no JavaScript errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('\nFailures:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.log('SUITE CRASHED:', e.message); process.exit(1); });

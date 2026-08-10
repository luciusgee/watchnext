/*
 * Metadata pipeline, run identically against BOTH providers.
 *
 * Same scenarios, same assertions, two different mock APIs with completely
 * different response shapes — which is the point: if the provider abstraction
 * is real, the matcher cannot tell them apart.
 *
 * Covers the owner's two original complaints:
 *   "it pulls the wrong movie images"  -> wrong-match cases below
 *   "it does all entries every time"   -> the second-sweep assertions
 */
const { chromium, devices } = require('/opt/node22/lib/node_modules/playwright');

let pass = 0, fail = 0; const failures = [];
const check = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ok    ${n}`); }
  else { fail++; failures.push(n + (d ? ` — ${d}` : '')); console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`); }
};

/* One shared catalogue, expressed in each provider's native shape. The
   behind-the-scenes documentaries are the traps: a fuzzy title endpoint
   returns them, and the old build wrote them over the real film. */
const CATALOG = [
  { key: 'br1982',  title: 'Blade Runner',       year: 1982, type: 'movie',  imdb: 'tt0083658', tmdb: 78,     genre: 'Science Fiction', runtime: 117, rating: 8.1, plot: 'A blade runner must pursue replicants.' },
  { key: 'br2049',  title: 'Blade Runner 2049',  year: 2017, type: 'movie',  imdb: 'tt1856101', tmdb: 335984, genre: 'Science Fiction', runtime: 164, rating: 7.5, plot: 'A young blade runner uncovers a secret.' },
  { key: 'mbr',     title: 'Making Blade Runner',year: 1982, type: 'movie',  imdb: 'tt9999001', tmdb: 999001, genre: 'Documentary',     runtime: 50,  rating: 6.9, plot: 'Behind the scenes.' },
  { key: 's1899',   title: '1899',               year: 2022, type: 'tv',     imdb: 'tt9319668', tmdb: 90669,  genre: 'Mystery',         runtime: 56,  rating: 7.3, plot: 'Migrants encounter a riddle at sea.' },
  { key: 'm1899',   title: 'Making 1899',        year: 2022, type: 'movie',  imdb: 'tt2383010', tmdb: 999002, genre: 'Documentary',     runtime: 50,  rating: 6.5, plot: 'Behind the scenes.' },
];

/* ── OMDb-shaped mock ── */
function omdbRoute(route, hits) {
  const u = new URL(route.request().url());
  hits.push(u.search);
  const j = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  const full = (c) => ({
    Response: 'True', Title: c.title, Year: String(c.year), Type: c.type === 'tv' ? 'series' : 'movie',
    imdbID: c.imdb, Genre: c.genre, Runtime: `${c.runtime} min`, imdbRating: String(c.rating),
    imdbVotes: '120,000', Plot: c.plot, Poster: `https://m.media-amazon.com/images/M/${c.key}._V1_SX300.jpg`,
  });
  const lite = (c) => ({ Title: c.title, Year: String(c.year), Type: c.type === 'tv' ? 'series' : 'movie', imdbID: c.imdb, Poster: `https://m.media-amazon.com/images/M/${c.key}.jpg` });

  if (u.searchParams.get('i')) {
    const hit = CATALOG.find((c) => c.imdb === u.searchParams.get('i'));
    return j(hit ? full(hit) : { Response: 'False', Error: 'Incorrect IMDb ID.' });
  }
  if (u.searchParams.get('s')) {
    const q = u.searchParams.get('s').toLowerCase();
    let hits2 = CATALOG.filter((c) => c.title.toLowerCase().includes(q));
    const type = u.searchParams.get('type');
    if (type) hits2 = hits2.filter((c) => (c.type === 'tv' ? 'series' : 'movie') === type);
    return hits2.length ? j({ Response: 'True', Search: hits2.map(lite) }) : j({ Response: 'False', Error: 'Movie not found!' });
  }
  if (u.searchParams.get('t')) {                      // fuzzy, exactly like the real thing
    const q = u.searchParams.get('t').toLowerCase();
    const type = u.searchParams.get('type');
    let hits2 = CATALOG.filter((c) => c.title.toLowerCase().includes(q));
    if (type) hits2 = hits2.filter((c) => (c.type === 'tv' ? 'series' : 'movie') === type);
    return hits2.length ? j(full(hits2[0])) : j({ Response: 'False', Error: 'Movie not found!' });
  }
  return j({ Response: 'False', Error: 'Bad request.' });
}

/* ── TMDB-shaped mock ── */
function tmdbRoute(route, hits) {
  const u = new URL(route.request().url());
  hits.push(u.pathname + u.search);
  const j = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  const lite = (c) => (c.type === 'tv'
    ? { id: c.tmdb, media_type: 'tv', name: c.title, original_name: c.title, first_air_date: `${c.year}-01-01`, poster_path: `/${c.key}.jpg`, overview: '', vote_average: c.rating, vote_count: 900, genre_ids: [] }
    : { id: c.tmdb, media_type: 'movie', title: c.title, original_title: c.title, release_date: `${c.year}-01-01`, poster_path: `/${c.key}.jpg`, overview: '', vote_average: c.rating, vote_count: 900, genre_ids: [] });
  const full = (c) => (c.type === 'tv'
    ? { id: c.tmdb, name: c.title, first_air_date: `${c.year}-01-01`, episode_run_time: [c.runtime], genres: [{ id: 1, name: c.genre }], overview: c.plot, vote_average: c.rating, vote_count: 900, poster_path: `/${c.key}.jpg`, number_of_seasons: 1, external_ids: { imdb_id: c.imdb } }
    : { id: c.tmdb, title: c.title, release_date: `${c.year}-01-01`, runtime: c.runtime, genres: [{ id: 1, name: c.genre }], overview: c.plot, vote_average: c.rating, vote_count: 900, poster_path: `/${c.key}.jpg`, imdb_id: c.imdb, external_ids: { imdb_id: c.imdb } });

  const p = u.pathname;
  if (p.startsWith('/3/search/multi')) {
    const q = (u.searchParams.get('query') || '').toLowerCase();
    return j({ page: 1, results: CATALOG.filter((c) => c.title.toLowerCase().includes(q)).map(lite) });
  }
  if (p.startsWith('/3/search/movie')) {
    const q = (u.searchParams.get('query') || '').toLowerCase();
    return j({ page: 1, results: CATALOG.filter((c) => c.type === 'movie' && c.title.toLowerCase().includes(q)).map(lite) });
  }
  if (p.startsWith('/3/search/tv')) {
    const q = (u.searchParams.get('query') || '').toLowerCase();
    return j({ page: 1, results: CATALOG.filter((c) => c.type === 'tv' && c.title.toLowerCase().includes(q)).map(lite) });
  }
  if (p.startsWith('/3/find/')) {
    const id = p.split('/').pop();
    const hit = CATALOG.find((c) => c.imdb === id);
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


/* Clearing localStorage alone no longer gives a clean slate: the store keeps an
   IndexedDB mirror and restores from it when the primary copy comes back empty.
   That is the point of the mirror, so tests that want an empty library have to
   say so explicitly. */
async function wipeAllStorage(page) {
  await page.evaluate(async () => {
    localStorage.clear();
    await new Promise((resolve) => {
      const req = indexedDB.deleteDatabase('watchnext');
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
      setTimeout(resolve, 1500);
    });
  });
}

const PROVIDERS = [
  { id: 'omdb', pattern: '**://www.omdbapi.com/**', handler: omdbRoute },
  { id: 'tmdb', pattern: '**://api.themoviedb.org/**', handler: tmdbRoute },
];

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  const allErrors = [];

  for (const prov of PROVIDERS) {
    console.log(`\n╔══════════════  ${prov.id.toUpperCase()}  ══════════════╗`);
    const ctx = await browser.newContext({ ...devices['iPhone 13 Pro'] });
    let hits = [];
    await ctx.route(prov.pattern, (r) => prov.handler(r, hits));
    await ctx.route('**://image.tmdb.org/**', (r) => r.fulfill({ status: 200, contentType: 'image/gif', body: Buffer.from('R0lGODlhAQABAAAAACw=', 'base64') }));
    await ctx.route('**://m.media-amazon.com/**', (r) => r.fulfill({ status: 200, contentType: 'image/gif', body: Buffer.from('R0lGODlhAQABAAAAACw=', 'base64') }));

    const page = await ctx.newPage();
    page.on('pageerror', (e) => allErrors.push(`[${prov.id}] ${e.message}`));
    await page.goto('http://127.0.0.1:8899/index.html', { waitUntil: 'networkidle' });
    await page.waitForSelector('body.is-ready');

    await wipeAllStorage(page);
    await page.evaluate((pid) => {
      /* A seeded-but-empty state: the store must not re-seed or recover over it. */
      localStorage.setItem('wn.state.v3', JSON.stringify({
        schema: 3, items: [], activity: [],
        settings: { name: '', provider: pid, dataKeys: { [pid]: 'testkey' },
                    aiKey: '', aiEnabled: false, libraryView: 'list', seeded: true },
      }));
    }, prov.id);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('body.is-ready');

    await page.evaluate(() => {
      window.__test.add({ title: 'Blade Runner', year: 1982, type: 'movie' });
      window.__test.add({ title: 'Blade Runner', year: 2017, type: 'movie' }); // same title, different film
      window.__test.add({ title: '1899',         year: 2022, type: 'movie' }); // WRONG type on purpose
      window.__test.add({ title: 'Zzzqqx Nothing', year: 2020, type: 'movie' });
    });
    await page.waitForTimeout(250);

    const runSweep = () => page.evaluate(async () => {
      const meta = await import('./src/metadata.js');
      const store = await import('./src/store.js');
      const { getProvider } = await import('./src/providers/index.js');
      const provider = getProvider(store.settings().provider);
      const key = store.settings().dataKeys[provider.id];
      const list = store.items().filter((i) => meta.needsEnrichment(i));
      const budget = new meta.RequestBudget(99999, provider.id);
      const res = await meta.sweep(list, {
        provider, key, budget, delay: 0,
        apply: (item, r) => {
          if (r.status === 'matched' && r.chosen) {
            store.update(item.uid, meta.toPatch(item, r.chosen, r.confidence, provider.id));
          } else {
            store.update(item.uid, { meta: { v: meta.META_VERSION, status: r.status, at: Date.now(),
              confidence: r.confidence, candidates: (r.candidates || []).map((c) => ({ sourceId: c.sourceId, imdbId: c.imdbId, title: c.title, year: c.year, type: c.type, poster: c.poster })) } });
          }
        },
      });
      store.saveNow();
      return { ...res, considered: list.length };
    });

    console.log('\n─── first sweep ───');
    hits = [];
    const r1 = await runSweep();
    const reqs1 = hits.length;
    console.log(`   considered=${r1.considered} matched=${r1.matched} review=${r1.review} unmatched=${r1.unmatched} requests=${reqs1}`);
    check(`[${prov.id}] sweep considers every unresolved title`, r1.considered === 4, `${r1.considered}`);

    let s = await page.evaluate(() => JSON.parse(localStorage.getItem('wn.state.v3')));
    const br82 = s.items.find((i) => i.year === 1982);
    const br49 = s.items.find((i) => i.year === 2017);
    const y1899 = s.items.find((i) => i.title === '1899');
    const nope = s.items.find((i) => i.title === 'Zzzqqx Nothing');

    check(`[${prov.id}] same-title films resolve to DIFFERENT records`,
      br82.imdbId === 'tt0083658' && br49.imdbId === 'tt1856101',
      `1982->${br82.imdbId} 2017->${br49.imdbId}`);
    check(`[${prov.id}] never drifts onto the making-of documentary`,
      br82.imdbId !== 'tt9999001' && br49.imdbId !== 'tt9999001');
    check(`[${prov.id}] a wrong stored type does not force a wrong match (the 1899 bug)`,
      y1899.imdbId === 'tt9319668', `got ${y1899.imdbId}`);
    check(`[${prov.id}] the series is corrected to type tv`, y1899.type === 'tv', y1899.type);
    check(`[${prov.id}] a title with no real match is NOT given one`,
      nope.imdbId === null && nope.meta.status !== 'matched', `${nope.meta.status}`);
    check(`[${prov.id}] confidence is recorded`, typeof br82.meta.confidence === 'number' && br82.meta.confidence > 0.8);
    check(`[${prov.id}] the source is recorded`, br82.meta.source === prov.id, br82.meta.source);
    check(`[${prov.id}] runtime, rating, genre and poster all populate`,
      br82.runtime === 117 && br82.rating === 8.1 && br82.genre === 'Sci-Fi' && !!br82.poster,
      `${br82.runtime}/${br82.rating}/${br82.genre}`);
    check(`[${prov.id}] overview populates`, br82.overview.length > 10);

    console.log('\n─── second sweep (the "does all entries every time" bug) ───');
    hits = [];
    const r2 = await runSweep();
    console.log(`   considered=${r2.considered} requests=${hits.length}`);
    check(`[${prov.id}] a re-run skips everything already resolved`, r2.considered < r1.considered, `${r1.considered} -> ${r2.considered}`);
    check(`[${prov.id}] a re-run makes fewer network calls`, hits.length < reqs1, `${reqs1} -> ${hits.length}`);
    check(`[${prov.id}] resolved items are never re-fetched`,
      await page.evaluate(() => import('./src/metadata.js').then((m) => import('./src/store.js').then((st) =>
        st.items().filter((i) => i.meta.status === 'matched').every((i) => !m.needsEnrichment(i))))));

    console.log('\n─── inherited ids are re-verified cheaply ───');
    await page.evaluate(() => {
      const st = window.__test;
      // A row carrying a WRONG inherited id, as if migrated from the old build
      st.add({ title: 'Blade Runner 2049', year: 2017, type: 'movie', imdbId: 'tt0083658',
               meta: { v: 1, status: 'stale', at: null, confidence: null } });
      // A row carrying a CORRECT inherited id
      st.add({ title: 'Blade Runner', year: 1982, type: 'movie', imdbId: 'tt0083658',
               meta: { v: 1, status: 'stale', at: null, confidence: null } });
    });
    await page.waitForTimeout(200);
    hits = [];
    await runSweep();
    s = await page.evaluate(() => JSON.parse(localStorage.getItem('wn.state.v3')));
    const stales = s.items.filter((i) => i.meta.source === prov.id && i.meta.confidence === 1);
    check(`[${prov.id}] a correct inherited id is confirmed`, stales.length >= 1, `${stales.length}`);
    const fixed = s.items.filter((i) => i.title.includes('2049'));
    check(`[${prov.id}] a wrong inherited id is corrected, not trusted`,
      fixed.every((i) => i.imdbId === 'tt1856101'), fixed.map((i) => i.imdbId).join());

    console.log('\n─── user edits are never overwritten ───');
    await page.evaluate(() => {
      const st = window.__test;
      const i = st.items().find((x) => x.year === 1982);
      st.update(i.uid, { genre: 'Neo-noir', locked: ['genre', 'title'],
                         meta: { v: 0, status: 'pending', at: null, confidence: null } });
    });
    await page.waitForTimeout(200);
    await runSweep();
    s = await page.evaluate(() => JSON.parse(localStorage.getItem('wn.state.v3')));
    const edited = s.items.find((i) => i.year === 1982);
    check(`[${prov.id}] a locked field survives a re-sweep`, edited.genre === 'Neo-noir', edited.genre);
    check(`[${prov.id}] unlocked fields still refresh`, edited.runtime === 117);

    /* ────────────────────────────────────────────────────────────
     * Search-to-add.
     *
     * The old Add screen took a typed title on trust and left you with a grey
     * placeholder until you found a chore in Settings. The point of searching is
     * that one tap produces a finished record, so that is what is asserted here:
     * poster, year and runtime present immediately, and — the part that is easy
     * to get wrong — the match marked as a human decision so the next sweep
     * leaves it alone rather than re-resolving it to something else.
     * ──────────────────────────────────────────────────────────── */
    console.log(`\n─── [${prov.id}] search to add ───`);

    /* Planted directly rather than cleared through the UI: store writes are
       debounced, so removing items and immediately reloading raced the save and
       left the previous scenario's library in place — which then answered every
       assertion below.
       wipeAllStorage first, because clearing localStorage alone is not enough:
       the store keeps a second copy in IndexedDB and recovers from it when the
       primary looks emptier, which is exactly what it is for and exactly what
       silently refilled this scenario. */
    await wipeAllStorage(page);
    await page.evaluate((id) => {
      localStorage.setItem(
        'wn.state.v3',
        JSON.stringify({
          schema: 3,
          items: [],
          activity: [],
          settings: {
            name: '', provider: id, dataKeys: { [id]: 'test-key' },
            keyStatus: {}, aiKey: '', libraryView: 'list', seeded: true,
          },
        })
      );
    }, prov.id);
    await page.goto('http://127.0.0.1:8899/index.html', { waitUntil: 'networkidle' });
    await page.waitForSelector('body.is-ready');
    const startCount = await page.evaluate(() => window.__test.count());
    check(`[${prov.id}] the search scenario starts from an empty library`, startCount === 0, String(startCount));

    await page.click('#screen-tonight [data-nav="add"]');
    await page.waitForTimeout(500);

    const defaultMode = await page.evaluate(() =>
      [...document.querySelectorAll('#screen-add .seg button')]
        .find((b) => b.getAttribute('aria-pressed') === 'true')?.textContent
    );
    check(`[${prov.id}] search is what Add opens on`, defaultMode === 'Search', String(defaultMode));

    await page.fill('#add-search', 'Blade Runner 2049');
    await page.click('#screen-add button[type="submit"]');
    await page.waitForTimeout(900);

    const found = await page.evaluate(() =>
      [...document.querySelectorAll('#screen-add button')]
        .map((b) => b.textContent)
        .filter((t) => /Blade Runner/.test(t))
    );
    check(`[${prov.id}] the search returns the film`, found.length > 0, `${found.length} results`);

    await page.evaluate(() =>
      [...document.querySelectorAll('#screen-add button')]
        .find((b) => /Blade Runner 2049/.test(b.textContent))?.click()
    );
    await page.waitForTimeout(1200);

    const added = await page.evaluate(() => JSON.parse(localStorage.getItem('wn.state.v3')).items);
    check(`[${prov.id}] one tap adds exactly one title`, added.length === 1, `${added.length}`);
    const film = added[0] || {};
    check(`[${prov.id}] it arrives with its year`, film.year === 2017, String(film.year));
    check(`[${prov.id}] and a poster, not a grey placeholder`, !!film.poster, String(film.poster));
    check(`[${prov.id}] and its runtime, without a separate sweep`, film.runtime === 164, String(film.runtime));
    check(`[${prov.id}] and marked as owned, per the checkbox`, film.owned === true);
    /* The important one. A record the user picked off a list is a human
       decision; addItem used to overwrite meta with "pending" on the way in,
       which handed it straight back to the matcher. */
    /* Assert the property, not the label. What matters is that the next sweep
       leaves it alone — pinning a particular status string just encodes
       whichever one toPatch happens to write today. */
    const wouldResweep = await page.evaluate(async () => {
      const meta = await import('./src/metadata.js');
      const store = await import('./src/store.js');
      return meta.needsEnrichment(store.items()[0]);
    });
    check(`[${prov.id}] the next sweep leaves a hand-picked match alone`,
      wouldResweep === false, JSON.stringify(film.meta));
    check(`[${prov.id}] and attributed to the user, so a sweep will not redo it`,
      film.meta?.source === 'user', JSON.stringify(film.meta));

    /* Searching the same thing again must offer to open it, not add it twice. */
    await page.fill('#add-search', 'Blade Runner 2049');
    await page.click('#screen-add button[type="submit"]');
    await page.waitForTimeout(900);
    const flagged = await page.evaluate(() =>
      [...document.querySelectorAll('#screen-add button')].some((b) => /Already in your library/.test(b.textContent))
    );
    check(`[${prov.id}] a title already held is flagged rather than duplicated`, flagged);

    await ctx.close();
  }

  console.log(`\n══════════  ${pass} passed, ${fail} failed  ══════════`);
  if (failures.length) { console.log('\nFailures:'); failures.forEach((f) => console.log('  · ' + f)); }
  if (allErrors.length) { console.log('\nJS errors:'); allErrors.slice(0, 6).forEach((e) => console.log('  ! ' + e)); }
  await browser.close();
  process.exit(fail || allErrors.length ? 1 : 0);
})().catch((e) => { console.error('CRASHED:', e.message, '\n', e.stack); process.exit(2); });

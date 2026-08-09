/*
 * Correcting a match that is confidently wrong.
 *
 * The review queue only ever offered a choice for titles the matcher was
 * unsure about. Anything it accepted — or anything the user accepted by
 * tapping the wrong row — left the queue and could never be changed. This is
 * the exact scenario: "Alien" in the library, matched to Alien: Romulus,
 * status `matched`, so nothing in the app would ever offer it again.
 *
 * Also guards the META_VERSION regression. metadata.js imported it without
 * re-exporting, so a screen writing `meta.META_VERSION` stored `v: undefined`,
 * which reads as "older than the current matcher" — a title the user had just
 * confirmed by hand went straight back into the re-check queue.
 */
const { chromium, devices } = require('/opt/node22/lib/node_modules/playwright');

let pass = 0, fail = 0; const failures = [];
const check = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ok    ${n}`); }
  else { fail++; failures.push(n + (d ? ` — ${d}` : '')); console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`); }
};

const APP_URL = 'http://127.0.0.1:8899/index.html';
const BLANK = Buffer.from('R0lGODlhAQABAAAAACw=', 'base64');

/* Deliberately ordered so the wrong film comes first for the query "Alien" —
   which is what OMDb actually does, and how the bad match happened. */
const CATALOG = [
  { title: 'Alien: Romulus', year: 2024, imdb: 'tt18412256', type: 'movie', genre: 'Horror',      runtime: 119, rating: 7.2, plot: 'Scavenging a derelict station.' },
  { title: 'Alien',          year: 1979, imdb: 'tt0078748',  type: 'movie', genre: 'Science Fiction', runtime: 117, rating: 8.5, plot: 'A crew answers a distress call.' },
  { title: 'Aliens',         year: 1986, imdb: 'tt0090605',  type: 'movie', genre: 'Action',      runtime: 137, rating: 8.4, plot: 'Ripley returns to LV-426.' },
];

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ ...devices['iPhone 13 Pro'] });
  await ctx.route('**://image.tmdb.org/**', (r) => r.fulfill({ status: 200, contentType: 'image/gif', body: BLANK }));
  await ctx.route('**://m.media-amazon.com/**', (r) => r.fulfill({ status: 200, contentType: 'image/gif', body: BLANK }));

  let detailsFail = false;
  const seen = [];
  await ctx.route('**://www.omdbapi.com/**', (r) => {
    const u = new URL(r.request().url());
    seen.push(u.search);
    const j = (o) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    const full = (c) => ({
      Response: 'True', Title: c.title, Year: String(c.year), Type: 'movie', imdbID: c.imdb,
      Genre: c.genre, Runtime: `${c.runtime} min`, imdbRating: String(c.rating), imdbVotes: '100,000',
      Plot: c.plot, Poster: `https://m.media-amazon.com/images/M/${c.imdb}._V1_SX300.jpg`,
    });
    const lite = (c) => ({ Title: c.title, Year: String(c.year), Type: 'movie', imdbID: c.imdb, Poster: `https://m.media-amazon.com/images/M/${c.imdb}.jpg` });

    if (u.searchParams.get('i')) {
      if (detailsFail) return r.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
      const hit = CATALOG.find((c) => c.imdb === u.searchParams.get('i'));
      return j(hit ? full(hit) : { Response: 'False', Error: 'Incorrect IMDb ID.' });
    }
    if (u.searchParams.get('s')) {
      const q = u.searchParams.get('s').toLowerCase();
      const hits = CATALOG.filter((c) => c.title.toLowerCase().includes(q));
      return hits.length ? j({ Response: 'True', Search: hits.map(lite) }) : j({ Response: 'False', Error: 'Movie not found!' });
    }
    return j({ Response: 'False', Error: 'Movie not found!' });
  });

  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(APP_URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('body.is-ready');

  console.log('\n─── META_VERSION is actually reachable from a screen ───');
  const version = await page.evaluate(async () => {
    const meta = await import('./src/metadata.js');
    const store = await import('./src/store.js');
    return { fromMeta: meta.META_VERSION, fromStore: store.META_VERSION };
  });
  check('metadata.js re-exports META_VERSION', version.fromMeta !== undefined, String(version.fromMeta));
  check('and it agrees with the store', version.fromMeta === version.fromStore,
    `${version.fromMeta} vs ${version.fromStore}`);

  console.log('\n─── the wrong match, exactly as it happened ───');
  const uid = await page.evaluate(async () => {
    const store = await import('./src/store.js');
    localStorage.clear();
    const state = store.settings();
    store.updateSettings({ provider: 'omdb', dataKeys: { omdb: 'testkey1' } });
    /* "Alien" in the library, wearing Alien: Romulus's details, marked matched
       so nothing in the app would ever offer it for review again. */
    const item = store.add({ title: 'Alien', year: 2024, type: 'movie' });
    store.update(item.uid, {
      imdbId: 'tt18412256',
      poster: 'https://m.media-amazon.com/images/M/tt18412256._V1_SX300.jpg',
      overview: 'Scavenging a derelict station.',
      meta: { v: 2, status: 'matched', at: Date.now(), confidence: 0.91, source: 'omdb', sourceId: 'tt18412256' },
    });
    store.saveNow();
    store.emit('item');
    void state;
    return item.uid;
  });

  const notInQueue = await page.evaluate(async () => {
    const store = await import('./src/store.js');
    return store.items().filter((i) => ['review', 'unmatched'].includes(i.meta?.status)).length;
  });
  check('a confidently wrong match never reaches the review queue', notInQueue === 0, `${notInQueue} queued`);

  console.log('\n─── the picker is reachable from the title itself ───');
  await page.click('[data-tab="library"]');
  await page.waitForTimeout(400);
  await page.evaluate((u) => window.__test.currentDetailUid && null || u, uid);
  await page.evaluate(async (u) => {
    const d = await import('./src/screens/detail.js');
    d.openDetail(u);
  }, uid);
  await page.waitForTimeout(500);

  const hasButton = await page.evaluate(() =>
    [...document.querySelectorAll('#detail button')].some((b) => /wrong film/i.test(b.textContent))
  );
  check('a matched title still offers "Wrong film?"', hasButton);

  await page.click('#detail button:has-text("Wrong film")');
  await page.waitForTimeout(400);

  const sheet = await page.evaluate(() => {
    const input = document.getElementById('match-search');
    return { open: !!input, prefill: input?.value || '' };
  });
  check('the picker opens', sheet.open);
  check('the search is pre-filled with the title AND year', sheet.prefill === 'Alien 2024', sheet.prefill);

  console.log('\n─── searching an edited query ───');
  await page.fill('#match-search', 'Alien 1979');
  await page.click('.sheet button[type="submit"]');
  await page.waitForTimeout(700);

  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('.sheet button')]
      .map((b) => b.textContent.trim())
      .filter((t) => /^Alien/.test(t))
  );
  check('results are listed', rows.length >= 2, JSON.stringify(rows));
  check('the year is parsed off the query rather than searched literally',
    seen.some((s) => s.includes('s=Alien') && !s.includes('1979')), seen.slice(-3).join(' | '));

  const marked = await page.evaluate(() =>
    [...document.querySelectorAll('.sheet button')].some((b) => /Currently attached/i.test(b.textContent))
  );
  check('the one currently attached is marked as such', marked);

  console.log('\n─── picking the right film ───');
  await page.evaluate(() => {
    /* No \b after "Alien" — the year runs straight on ("Alien1979"), and digits
       are word characters, so there is no boundary to match. */
    const row = [...document.querySelectorAll('.sheet button')].find((b) => /1979/.test(b.textContent));
    if (!row) throw new Error('no 1979 row: ' + [...document.querySelectorAll('.sheet button')].map((b) => b.textContent.trim()).join(' | '));
    row.click();
  });
  await page.waitForTimeout(900);

  const fixed = await page.evaluate(async (u) => {
    const store = await import('./src/store.js');
    const i = store.byUid(u);
    return { title: i.title, year: i.year, imdbId: i.imdbId, status: i.meta?.status, v: i.meta?.v, source: i.meta?.source, sourceId: i.meta?.sourceId, overview: i.overview };
  }, uid);
  check('the IMDb id is now the right film', fixed.imdbId === 'tt0078748', fixed.imdbId);
  check('the year is corrected', fixed.year === 1979, String(fixed.year));
  check('the description is corrected', /distress call/i.test(fixed.overview || ''), fixed.overview);
  check('it is recorded as a human choice', fixed.source === 'user' || fixed.confidence === 1, fixed.source);
  check('the meta version is stored properly, not undefined', fixed.v !== undefined, String(fixed.v));

  console.log('\n─── a confirmed choice stays confirmed ───');
  const requeued = await page.evaluate(async (u) => {
    const meta = await import('./src/metadata.js');
    const store = await import('./src/store.js');
    return meta.needsEnrichment(store.byUid(u));
  }, uid);
  check('it does not fall straight back into the re-check queue', requeued === false, String(requeued));

  /* Scoped to the corrected title. The seeded library is legitimately pending —
     it has never been looked up — so a global count would say nothing. */
  const counted = await page.evaluate(async (u) => {
    const meta = await import('./src/metadata.js');
    const store = await import('./src/store.js');
    return meta.enrichmentSummary([store.byUid(u)]);
  }, uid);
  check('and it counts as done, not as never-looked-up',
    counted.done === 1 && counted.pending === 0, JSON.stringify(counted));

  /* The correction has to survive the next sweep too, or it silently reverts
     six months later when the cache expires. findMatch's fast path re-verifies
     by the stored id rather than searching the title again. */
  const resweep = await page.evaluate(async (u) => {
    const meta = await import('./src/metadata.js');
    const store = await import('./src/store.js');
    const { getProvider } = await import('./src/providers/index.js');
    const provider = getProvider('omdb');
    const res = await meta.findMatch(store.byUid(u), {
      provider,
      key: 'testkey1',
      budget: new meta.RequestBudget(provider.dailyLimit, 'omdb'),
    });
    return { status: res.status, id: res.chosen?.imdbId, reason: res.reasons?.[0] };
  }, uid);
  check('a later sweep re-verifies by id instead of searching the title again',
    resweep.reason === 'known id', String(resweep.reason));
  check('and lands on the film the user chose, not the one it first guessed',
    resweep.id === 'tt0078748', String(resweep.id));

  console.log('\n─── the choice survives a failed details fetch ───');
  const uid2 = await page.evaluate(async () => {
    const store = await import('./src/store.js');
    const it = store.add({ title: 'Aliens', year: 2024, type: 'movie' });
    store.update(it.uid, { imdbId: 'tt18412256', meta: { v: 2, status: 'matched', at: Date.now(), confidence: 0.9, source: 'omdb', sourceId: 'tt18412256' } });
    store.saveNow();
    store.emit('item');
    return it.uid;
  });
  detailsFail = true;
  await page.evaluate(async (u) => {
    const d = await import('./src/screens/detail.js');
    d.openDetail(u);
  }, uid2);
  await page.waitForTimeout(400);
  await page.click('#detail button:has-text("Wrong film")');
  await page.waitForTimeout(300);
  await page.fill('#match-search', 'Aliens');
  await page.click('.sheet button[type="submit"]');
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('.sheet button')].find((b) => /Aliens/.test(b.textContent) && /1986/.test(b.textContent));
    row?.click();
  });
  await page.waitForTimeout(900);
  detailsFail = false;

  const partial = await page.evaluate(async (u) => {
    const store = await import('./src/store.js');
    const i = store.byUid(u);
    return { imdbId: i.imdbId, sourceId: i.meta?.sourceId, v: i.meta?.v };
  }, uid2);
  check('the id is saved even though the details request failed', partial.imdbId === 'tt0090605', partial.imdbId);
  check('and the meta version is still valid', partial.v !== undefined, String(partial.v));

  console.log('\n─── it survives a reload ───');
  await page.goto(APP_URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('body.is-ready');
  const afterReload = await page.evaluate(async (u) => {
    const store = await import('./src/store.js');
    const i = store.byUid(u);
    return { imdbId: i?.imdbId, year: i?.year };
  }, uid);
  check('the corrected match persists', afterReload.imdbId === 'tt0078748', afterReload.imdbId);
  check('so does the corrected year', afterReload.year === 1979, String(afterReload.year));

  console.log('\n─── hand-edited fields are never clobbered ───');
  const kept = await page.evaluate(async (u) => {
    const store = await import('./src/store.js');
    store.update(u, { title: 'Alien (my cut)' });
    store.lockFields ? store.lockFields(u, ['title']) : null;
    const before = store.byUid(u).title;
    const meta = await import('./src/metadata.js');
    const patch = meta.toPatch(store.byUid(u), {
      title: 'Alien', year: 1979, type: 'movie', imdbId: 'tt0078748', sourceId: 'tt0078748',
      poster: null, overview: 'x', genres: [], genre: 'Horror', rating: 8.5, runtime: 117,
    }, 1, 'omdb');
    return { before, patched: patch.title };
  }, uid);
  check('a locked title is not overwritten by a re-match',
    kept.patched === undefined || kept.patched === kept.before, `${kept.before} -> ${kept.patched}`);

  console.log('\n─── no errors ───');
  check('no uncaught JS errors', errs.length === 0, errs.slice(0, 3).join(' | '));

  console.log(`\n══════════  ${pass} passed, ${fail} failed  ══════════`);
  if (failures.length) { console.log('\nFailures:'); failures.forEach((f) => console.log('  · ' + f)); }
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASHED:', e.message, '\n', e.stack); process.exit(2); });

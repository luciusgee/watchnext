/*
 * The feed.
 *
 * Against a fake TMDB (tools/tmdb-mock.js): cards snap one at a time, carry
 * the details a decision needs, keep coming, never repeat and never show
 * what is already on the shelf; the buttons put films on the shelf, in
 * Spotlight and in a conversation; the filters filter; and it says so when
 * there is no key or the key is wrong.
 */
const { chromium, devices } = require('/opt/node22/lib/node_modules/playwright');
const { tmdbRoute, imageRoute } = require('./tmdb-mock.js');

const APP_URL = 'http://127.0.0.1:8899/index.html';
const KEY = '0123456789abcdef0123456789abcdef';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  const errors = [];
  const hits = [];
  const phone = async (key = KEY, sample = true) => {
    const ctx = await browser.newContext({ ...devices['iPhone 13 Pro'] });
    await ctx.route('**://api.themoviedb.org/**', (r) => tmdbRoute(r, hits));
    await ctx.route('**://image.tmdb.org/**', imageRoute);
    await ctx.route(/m\.media-amazon\.com|omdbapi\.com|api\.anthropic\.com|api\.github\.com/, (r) => r.abort());
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(APP_URL, { waitUntil: 'networkidle' });
    await page.waitForSelector('body.is-ready');
    await page.evaluate(({ key, sample }) => {
      if (sample) window.__test.loadSample();
      const st = JSON.parse(localStorage.getItem('wn.state.v3'));
      st.settings.dataKeys = key ? { tmdb: key } : {};
      localStorage.setItem('wn.state.v3', JSON.stringify(st));
      localStorage.removeItem('wn.feed.seen');
      localStorage.removeItem('wn.feed.filter');
    }, { key, sample });
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('body.is-ready');
    return { ctx, page };
  };
  const state = (page) => page.evaluate(async () => (await import('./src/screens/feed.js')).feedState());
  const next = async (page) => {
    await page.evaluate(() => { const s = document.querySelector('.feed-scroll'); s.scrollBy({ top: s.clientHeight }); });
    await page.waitForTimeout(500);
  };

  console.log('\n─── a card ───');
  const { ctx, page } = await phone();
  await page.tap('[data-tab="feed"]');
  await page.waitForSelector('.feed-card[data-i="0"]');
  await page.waitForTimeout(800);
  const tabs = await page.evaluate(() => [...document.querySelectorAll('.tabbar .tab')].map((t) => t.textContent.trim()));
  check('Feed is a tab, second from the left', tabs[1] === 'Feed', JSON.stringify(tabs));
  const snap = await page.evaluate(() => {
    const s = getComputedStyle(document.querySelector('.feed-scroll'));
    const c = getComputedStyle(document.querySelector('.feed-card'));
    const scroll = document.querySelector('.feed-scroll').getBoundingClientRect();
    const card = document.querySelector('.feed-card').getBoundingClientRect();
    return { type: s.scrollSnapType, align: c.scrollSnapAlign, stop: c.scrollSnapStop, fills: Math.abs(scroll.height - card.height) < 2 };
  });
  check('it snaps to one film per flick, and stops on each', /y mandatory/.test(snap.type) && snap.align === 'start' && snap.stop === 'always', JSON.stringify(snap));
  check('each card fills the screen above the tab bar', snap.fills, JSON.stringify(snap));
  const card = await page.evaluate(() => {
    const c = document.querySelector('.feed-card[data-i="0"]');
    return {
      title: c.querySelector('.feed-title').textContent,
      meta: c.querySelector('.feed-meta').textContent,
      tagline: c.querySelector('.feed-tagline').textContent,
      genres: c.querySelector('.feed-genres').textContent,
      overview: c.querySelector('.feed-overview').textContent,
      credits: c.querySelector('.feed-credits').textContent,
      imdb: c.querySelector('.feed-imdb')?.href || '',
      poster: c.querySelector('.feed-art img').getAttribute('src') || '',
      trailer: !c.querySelector('[data-act="trailer"]').hidden,
    };
  });
  check('title, year, running time, certificate and rating', !!card.title && /\d{4}/.test(card.meta) && /\dh/.test(card.meta) && /15/.test(card.meta) && /★/.test(card.meta), JSON.stringify(card));
  check('tagline and genres', !!card.tagline && !!card.genres, JSON.stringify(card));
  check('the synopsis', card.overview.length > 20);
  check('who made it and who is in it', /Directed by/.test(card.credits) && /Starring/.test(card.credits), card.credits);
  check('a link to its IMDb page', /imdb\.com\/title\/tt\d+/.test(card.imdb), card.imdb);
  check('the poster, full size', /image\.tmdb\.org\/t\/p\/w780\//.test(card.poster), card.poster);
  check('and a trailer button when there is one', card.trailer);

  console.log('\n─── scrolling ───');
  const s0 = await state(page);
  await next(page);
  const s1 = await state(page);
  check('a flick moves to the next film', s1.current === s0.current + 1, `${s0.current} → ${s1.current}`);
  for (let i = 0; i < 22; i++) await next(page);
  const s2 = await state(page);
  check('it keeps going past the first page of films', s2.count > 20 && s2.current >= 22, JSON.stringify({ count: s2.count, current: s2.current }));
  const titles = await page.evaluate(() => [...document.querySelectorAll('.feed-title')].map((t) => t.textContent));
  check('never the same film twice', new Set(titles).size === titles.length, `${titles.length} cards`);
  const images = await page.evaluate(() => [...document.querySelectorAll('.feed-art img')].filter((i) => i.getAttribute('src')).length);
  check('posters far behind are let go, so memory stays flat', images <= 12, `${images} posters held`);
  const library = await page.evaluate(() => window.__test.items().map((i) => i.title.toLowerCase()));
  check('nothing already on the shelf shows up', !titles.some((t) => library.includes(t.toLowerCase())));
  const seen = await page.evaluate(() => JSON.parse(localStorage.getItem('wn.feed.seen') || '[]').length);
  check('what has been shown is remembered, so a new session starts fresh', seen >= 20, `${seen}`);

  console.log('\n─── the buttons ───');
  const film = (await state(page)).film;
  const i = (await state(page)).current;
  const before = await page.evaluate(() => window.__test.count());
  await page.tap(`.feed-card[data-i="${i}"] [data-act="add"]`);
  await page.waitForTimeout(600);
  const added = await page.evaluate((t) => window.__test.items().find((x) => x.title === t), film.title);
  check('Add puts the film on the shelf', !!added && (await page.evaluate(() => window.__test.count())) === before + 1, film.title);
  check('as something to watch — not owned, not watched', added && !added.owned && !added.watched);
  check('with its poster, IMDb id, TMDB id and details', added && !!added.poster && /^tt\d+$/.test(added.imdbId || '') && added.meta.sourceId === String(film.id) && !!added.runtime && added.genres.length > 0, JSON.stringify(added && { poster: added.poster, imdb: added.imdbId, meta: added.meta, runtime: added.runtime }));
  check('counted as verified, chosen by you', added && added.meta.status === 'matched' && added.meta.source === 'user');
  const addLabel = await page.evaluate((n) => document.querySelector(`.feed-card[data-i="${n}"] [data-act="add"] .feed-act-label`).textContent, i);
  check('and the button says it is in the list', addLabel === 'In list', addLabel);

  await page.tap(`.feed-card[data-i="${i}"] [data-act="spotlight"]`);
  await page.waitForTimeout(500);
  const lit = await page.evaluate((u) => window.__test.byUid(u)?.spotlight, added.uid);
  check('the star puts it in Spotlight', !!lit?.at, JSON.stringify(lit));
  const queued = await page.evaluate(() => JSON.parse(localStorage.getItem('wn.state.v3')).settings.pendingNotify);
  check('and queues a notification for the other phone', queued.some((q) => q.kind === 'spotlight' && /in Spotlight/.test(q.payload.title)), JSON.stringify(queued));
  const starOn = await page.evaluate((n) => document.querySelector(`.feed-card[data-i="${n}"] [data-act="spotlight"]`).classList.contains('is-on'), i);
  check('and the star lights up', starOn);

  /* Double-tap the poster of the next film. */
  await next(page);
  const j = (await state(page)).current;
  const film2 = (await state(page)).film;
  const box = await page.evaluate((n) => { const r = document.querySelector(`.feed-card[data-i="${n}"] .feed-art`).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 3 }; }, j);
  await page.touchscreen.tap(box.x, box.y);
  await page.waitForTimeout(90);
  await page.touchscreen.tap(box.x, box.y);
  await page.waitForTimeout(800);
  const doubled = await page.evaluate((t) => window.__test.items().find((x) => x.title === t)?.spotlight, film2.title);
  check('a double-tap on the poster puts it in Spotlight too', !!doubled, film2.title);

  await next(page);
  const k = (await state(page)).current;
  const film3 = (await state(page)).film;
  await page.tap(`.feed-card[data-i="${k}"] [data-act="comment"]`);
  await page.waitForSelector('.thread-sheet.is-open');
  const askedName = await page.evaluate(() => !!document.querySelector('.thread-sheet input[placeholder="Your name"]'));
  check('commenting asks your name the first time', askedName);
  await page.fill('.thread-sheet input[placeholder="Your name"]', 'Luke');
  await page.fill('.thread-sheet textarea', 'This one for Saturday?');
  await page.tap('.thread-sheet .thread-send');
  await page.waitForTimeout(600);
  const talked = await page.evaluate((t) => {
    const it = window.__test.items().find((x) => x.title === t);
    const st = JSON.parse(localStorage.getItem('wn.state.v3'));
    return { spot: !!it?.spotlight, notes: st.notes.filter((n) => n.uid === it?.uid).map((n) => [n.by, n.text]), name: st.settings.name };
  }, film3.title);
  check('the comment is saved, signed with your name', talked.notes.length === 1 && talked.notes[0][0] === 'Luke' && talked.notes[0][1] === 'This one for Saturday?', JSON.stringify(talked));
  check('and a film talked about goes in Spotlight', talked.spot);
  const bubble = await page.evaluate(() => document.querySelector('.thread-sheet .note.is-own .note-bubble')?.textContent);
  check('and appears in the thread as yours', bubble === 'This one for Saturday?', bubble);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  console.log('\n─── filters ───');
  await page.evaluate(() => [...document.querySelectorAll('.feed-filter')].find((b) => b.textContent === 'Horror').click());
  await page.waitForTimeout(1200);
  const horror = await page.evaluate(() => [...document.querySelectorAll('.feed-genres')].slice(0, 6).map((g) => g.textContent));
  check('Horror shows horror', horror.length >= 3 && horror.every((g) => /Horror/.test(g)), JSON.stringify(horror));
  check('from the top', (await state(page)).current === 0);
  check('and the choice is remembered', (await page.evaluate(() => localStorage.getItem('wn.feed.filter'))) === 'horror');
  await page.evaluate(() => [...document.querySelectorAll('.feed-filter')].find((b) => b.textContent === 'Series').click());
  await page.waitForTimeout(1200);
  const series = await page.evaluate(() => ({ meta: document.querySelector('.feed-card[data-i="0"] .feed-meta')?.textContent, credits: document.querySelector('.feed-card[data-i="0"] .feed-credits')?.textContent }));
  check('Series shows series, with seasons and who created them', /season/.test(series.meta || '') && /Created by/.test(series.credits || ''), JSON.stringify(series));
  const forYou = hits.filter((h) => /with_genres=/.test(h)).length;
  check('For you asked for the shelf’s favourite genres', forYou > 0, `${forYou} genre requests`);
  await ctx.close();

  console.log('\n─── when it cannot ───');
  const nokey = await phone('', true);
  await nokey.page.tap('[data-tab="feed"]');
  await nokey.page.waitForTimeout(500);
  const noKeyText = await nokey.page.evaluate(() => document.querySelector('#screen-feed')?.textContent || '');
  check('with no TMDB key it says so, and where it goes', /needs a TMDB key/.test(noKeyText) && /Open Settings/.test(noKeyText), noKeyText.slice(0, 120));
  await nokey.ctx.close();
  const bad = await phone('bad', true);
  await bad.page.tap('[data-tab="feed"]');
  await bad.page.waitForTimeout(1200);
  const badText = await bad.page.evaluate(() => document.querySelector('#screen-feed')?.textContent || '');
  check('with a key TMDB turns down it says that, with a way to try again', /turned the key down|did not load/.test(badText) && /Try again/.test(badText), badText.slice(0, 160));
  await bad.ctx.close();

  console.log('\n─── no errors ───');
  check('no JavaScript errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('\nFailures:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.log('SUITE CRASHED:', e.message); process.exit(1); });

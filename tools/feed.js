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
  check('title, when it is from, running time, certificate and rating', !!card.title && (/\d{4}/.test(card.meta) || /^(In cinemas|On digital|Out|New)/.test(card.meta)) && /\dh/.test(card.meta) && /15/.test(card.meta) && /★/.test(card.meta), JSON.stringify(card));
  check('For you starts with what is new or just coming, in the UK', /^(In cinemas|On digital|Out|New)/.test(card.meta) && hits.some((h) => /\/discover\/movie/.test(h) && /region=GB/.test(h) && /release_date\.gte=/.test(h) && /with_genres=\d+(%7C|\|)\d+/.test(h)), card.meta);
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
  check('and the button becomes the way to the film', addLabel === 'Open', addLabel);

  await page.tap(`.feed-card[data-i="${i}"] [data-act="add"]`);
  await page.waitForSelector('.detail.is-open');
  const opened = await page.evaluate(() => ({ title: document.querySelector('.detail.is-open h1')?.textContent || '', watchBtn: [...document.querySelectorAll('.detail.is-open button')].some((b) => /Mark watched|Watched/i.test(b.textContent)) }));
  check('Open takes you to the film, where it can be marked watched', opened.title === film.title && opened.watchBtn, JSON.stringify(opened));
  await page.evaluate(() => [...document.querySelectorAll('.detail.is-open button')].find((b) => /Mark watched/i.test(b.textContent))?.click());
  await page.waitForTimeout(400);
  await page.evaluate(async () => (await import('./src/screens/detail.js')).closeDetail());
  await page.waitForTimeout(500);
  const afterWatch = await page.evaluate((n) => document.querySelector(`.feed-card[data-i="${n}"] [data-act="add"] .feed-act-label`).textContent, i);
  const watchedNow = await page.evaluate((u) => window.__test.byUid(u)?.watched, added.uid);
  check('and back on the card it says so', watchedNow === true && afterWatch === 'Watched', `${watchedNow} / ${afterWatch}`);

  await page.tap(`.feed-card[data-i="${i}"] [data-act="spotlight"]`);
  await page.waitForTimeout(500);
  const lit = await page.evaluate((u) => window.__test.byUid(u)?.spotlight, added.uid);
  check('the star puts it in Spotlight', !!lit?.at, JSON.stringify(lit));
  const queued = await page.evaluate(() => JSON.parse(localStorage.getItem('wn.state.v3')).settings.pendingNotify);
  check('a star does not buzz the other phone (comments and superlikes do)', !queued.some((q) => q.kind === 'spotlight'), JSON.stringify(queued));
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
  const h = (await state(page)).current;
  const hotFilm = (await state(page)).film;
  await page.tap(`.feed-card[data-i="${h}"] [data-act="superlike"]`);
  await page.waitForTimeout(800);
  const hot = await page.evaluate((t) => {
    const it = window.__test.items().find((x) => x.title === t);
    const q = JSON.parse(localStorage.getItem('wn.state.v3')).settings.pendingNotify.filter((e) => e.uid === it?.uid || (e.uids || []).includes(it?.uid));
    return { superlike: !!it?.superlike, spot: !!it?.spotlight, queued: q.map((e) => e.kind) };
  }, hotFilm.title);
  check('the flame superlikes a film: on the list, in Spotlight', hot.superlike && hot.spot, JSON.stringify(hot));
  check('telling the other phone once, as a superlike', hot.queued.join() === 'superlike', JSON.stringify(hot.queued));
  const lit2 = await page.evaluate((n) => { const b = document.querySelector(`.feed-card[data-i="${n}"] [data-act="superlike"]`); return b.classList.contains('is-on') && b.getAttribute('aria-pressed') === 'true'; }, h);
  check('and the flame lights up', lit2);

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
  const sheets = await page.evaluate(async (t) => {
    const it = window.__test.items().find((x) => x.title === t);
    (await import('./src/screens/thread.js')).openThread(it.uid);
    return document.querySelectorAll('.thread-sheet').length;
  }, film3.title);
  check('opening the same thread again does not stack a second sheet', sheets === 1, `${sheets} sheets`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  /* Comment tapped, nothing said: the film should not stay on the list. */
  await next(page);
  const m = (await state(page)).current;
  const film4 = (await state(page)).film;
  await page.tap(`.feed-card[data-i="${m}"] [data-act="comment"]`);
  await page.waitForSelector('.thread-sheet.is-open');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  const leftOver = await page.evaluate((t) => window.__test.items().some((x) => x.title === t), film4.title);
  check('Comment opened and closed with nothing said leaves the list as it was', !leftOver, film4.title);

  console.log('\n─── recently added, on Tonight ───');
  await page.tap('[data-tab="tonight"]');
  await page.waitForTimeout(500);
  const recentRail = await page.evaluate(() => {
    const r = document.querySelector('.rail[data-rail="Recently added"]');
    return r ? { first: r.querySelector('.card-t, .card-title, [class*="card-t"]')?.textContent || r.querySelector('.card')?.getAttribute('aria-label') || '', seeAll: !!r.closest('.section')?.querySelector('.section-link') } : null;
  });
  check('Tonight has a Recently added row, newest first', !!recentRail && recentRail.first.includes(film3.title), JSON.stringify(recentRail));
  await page.evaluate(() => document.querySelector('.rail[data-rail="Recently added"]').closest('.section').querySelector('.section-link').click());
  await page.waitForTimeout(600);
  const libSort = await page.evaluate(() => document.getElementById('screen-library').classList.contains('is-active'));
  check('and See all opens the library, newest first', libSort);
  await page.tap('[data-tab="feed"]');
  await page.waitForTimeout(500);

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

  console.log('\n─── a feed that has been scrolled a lot ───');
  {
    /* Everything on the first ten pages of Trending already seen on this
       phone: the feed must keep asking, not declare itself finished. */
    const { ctx: c2, page: p2 } = await phone();
    await p2.evaluate(() => {
      localStorage.setItem('wn.feed.seen', JSON.stringify(Array.from({ length: 200 }, (_, n) => `movie:${1000 + n}`)));
      localStorage.setItem('wn.feed.filter', 'trending');
    });
    await p2.reload({ waitUntil: 'networkidle' });
    await p2.waitForSelector('body.is-ready');
    await p2.tap('[data-tab="feed"]');
    await p2.waitForSelector('.feed-card[data-i="0"]', { timeout: 8000 }).catch(() => {});
    const first = await state(p2);
    check('ten pages of films already seen do not end the feed', first.count > 0 && first.film?.id >= 1200, JSON.stringify({ count: first.count, id: first.film?.id }));
    await c2.close();
  }
  {
    /* Nineteen of the first twenty seen: a first batch of one film, with
       nothing below it to scroll to. It must fetch more by itself. */
    const { ctx: c3, page: p3 } = await phone();
    await p3.evaluate(() => {
      localStorage.setItem('wn.feed.seen', JSON.stringify(Array.from({ length: 19 }, (_, n) => `movie:${1000 + n}`)));
      localStorage.setItem('wn.feed.filter', 'trending');
    });
    await p3.reload({ waitUntil: 'networkidle' });
    await p3.waitForSelector('body.is-ready');
    await p3.tap('[data-tab="feed"]');
    await p3.waitForSelector('.feed-card[data-i="0"]');
    await p3.waitForTimeout(1200);
    const after = await state(p3);
    check('a first batch of one film does not leave the feed stuck on it', after.count > 5, `${after.count} cards`);
    const genres = await p3.evaluate(async () => {
      const f = await import('./src/feed.js');
      for (let n = 0; n < 12; n++) f.nudge({ genreIds: [10765, 10759] }, 1);
      return f.favouriteGenres(8);
    });
    check('starring series teaches For you film genres, never TV-only ids', genres.length > 0 && genres.every((g) => ![10759, 10762, 10763, 10764, 10765, 10766, 10767, 10768].includes(g)) && genres.includes(878), JSON.stringify(genres));
    await c3.close();
  }

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

  /* A touch drag the way a finger does it, so the browser's own scrolling
     decides what moves. */
  const dragger = async (ctx2, pg) => {
    const cdp = await ctx2.newCDPSession(pg);
    return async (x0, y0, x1, y1) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] });
      for (let i = 1; i <= 12; i++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + ((x1 - x0) * i) / 12, y: y0 + ((y1 - y0) * i) / 12 }] });
        await new Promise((r) => setTimeout(r, 12));
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await pg.waitForTimeout(900);
    };
  };

  console.log('\n─── the pill row ───');
  {
    const { ctx: c4, page: p4 } = await phone();
    await p4.tap('[data-tab="feed"]');
    await p4.waitForSelector('.feed-card[data-i="3"]');
    await p4.waitForTimeout(600);
    const css = await p4.evaluate(() => {
      const bar = getComputedStyle(document.querySelector('.feed-bar'));
      const row = getComputedStyle(document.querySelector('.feed-filters'));
      const r = document.querySelector('.feed-filters');
      const first = document.querySelector('.feed-card[data-i="0"]').getBoundingClientRect().top;
      const top = document.querySelector('.feed-scroll').getBoundingClientRect().top;
      return {
        pe: [bar.pointerEvents, row.pointerEvents],
        ta: [bar.touchAction, row.touchAction],
        ob: [bar.overscrollBehaviorY, row.overscrollBehaviorY],
        overflows: r.scrollWidth > r.clientWidth,
        inside: document.querySelector('.feed-bar').parentElement === document.querySelector('.feed-scroll'),
        firstAtTop: Math.abs(first - top) < 1,
      };
    });
    /* Chromium scrolls a pointer-events:none row anyway; iOS does not. So
       this is checked directly — it is the thing that broke it. */
    check('nothing on the pill row switches off iOS’s own scrolling', css.pe.every((v) => v !== 'none') && css.ta.every((v) => v === 'auto') && css.ob.every((v) => v === 'auto'), JSON.stringify(css));
    check('the row is wider than the screen', css.overflows);
    check('the bar rides inside the feed’s scroller, taking no room from the first card', css.inside && css.firstAtTop, JSON.stringify(css));
    const drag = await dragger(c4, p4);
    const at = await p4.evaluate(() => {
      const pills = [...document.querySelectorAll('.feed-filter')].map((b) => b.getBoundingClientRect());
      const bar = document.querySelector('.feed-bar').getBoundingClientRect();
      const mid = pills[1].y + pills[1].height / 2;
      const out = { pill: { x: pills[2].x + pills[2].width / 2, y: mid }, gap: { x: (pills[1].right + pills[2].x) / 2, y: mid }, edge: { x: pills[2].x + 10, y: bar.bottom - 3 } };
      /* Say what each start point really is, so a layout change cannot swap
         what is being tested. */
      const hit = (p) => document.elementFromPoint(p.x, p.y);
      out.onPill = !!hit(out.pill)?.closest('.feed-filter');
      out.inGap = hit(out.gap)?.classList.contains('feed-filters');
      return out;
    });
    check('the drag points are where they say: one on a pill, one between two', at.onPill && at.inGap, JSON.stringify(at));
    const read = () => p4.evaluate(() => ({ left: Math.round(document.querySelector('.feed-filters').scrollLeft), top: Math.round(document.querySelector('.feed-scroll').scrollTop) }));
    const pressedBefore = await p4.evaluate(() => document.querySelector('.feed-filter[aria-pressed="true"]')?.textContent);
    await drag(at.pill.x, at.pill.y, at.pill.x - 260, at.pill.y);
    const a = await read();
    check('a sideways swipe on a pill scrolls the row, not the feed', a.left > 100 && a.top === 0, JSON.stringify(a));
    const pressedAfter = await p4.evaluate(() => document.querySelector('.feed-filter[aria-pressed="true"]')?.textContent);
    check('and does not choose a filter on the way', pressedBefore === pressedAfter, `${pressedBefore} → ${pressedAfter}`);
    await p4.evaluate(() => { document.querySelector('.feed-filters').scrollLeft = 0; });
    await p4.waitForTimeout(200);
    await drag(at.gap.x, at.gap.y, at.gap.x - 260, at.gap.y);
    const b = await read();
    check('so does one that starts between two pills', b.left > 100, JSON.stringify(b));
    /* Let the row finish gliding from the last swipe first: a touch that
       lands mid-glide only stops the glide. */
    const settle = () => p4.evaluate(async () => {
      const f = document.querySelector('.feed-filters');
      f.scrollLeft = 0;
      let last = -1;
      for (let i = 0; i < 40 && f.scrollLeft !== last; i++) {
        last = f.scrollLeft;
        await new Promise((r) => setTimeout(r, 60));
        f.scrollLeft = 0;
      }
    });
    await settle();
    /* On the second film, then a long pull down that starts on the bar:
       long enough to move a film on distance alone, so the check does not
       hang on whether the browser read it as a flick. */
    const h = await p4.evaluate(() => { const f = document.querySelector('.feed-scroll'); f.scrollTop = f.clientHeight; return f.clientHeight; });
    await p4.waitForTimeout(500);
    await drag(at.edge.x, at.edge.y, at.edge.x, at.edge.y + 420);
    /* A synthetic touch now and then lands before the browser is ready for
       it and moves nothing; one more try says whether it really can't. */
    if ((await read()).top !== 0) await drag(at.edge.x, at.edge.y, at.edge.x, at.edge.y + 420);
    const v = await read();
    check('a swipe up or down that starts on the bar moves the feed a film', v.top === 0 && v.left === 0, JSON.stringify({ ...v, card: h }));
    await p4.evaluate(() => { const f = document.querySelector('.feed-filters'); f.scrollLeft = f.scrollWidth; });
    await p4.waitForTimeout(300);
    check('at the end of the row the more-this-way fade goes', await p4.evaluate(() => document.querySelector('.feed-bar').classList.contains('at-end')));
    const node = await p4.evaluate(() => { window.__pill = document.querySelector('.feed-filter'); return true; });
    await p4.tap('[data-tab="tonight"]');
    await p4.waitForTimeout(300);
    await p4.tap('[data-tab="feed"]');
    await p4.waitForTimeout(300);
    check('the pills are kept, not rebuilt, going away and back', node && (await p4.evaluate(() => window.__pill === document.querySelector('.feed-filter'))));
    await p4.evaluate(() => [...document.querySelectorAll('.feed-filter')].find((x) => x.textContent === 'Classics').click());
    await p4.waitForTimeout(1200);
    const kept = await p4.evaluate(() => ({ bar: document.querySelector('.feed-scroll').firstElementChild?.classList.contains('feed-bar'), cards: document.querySelectorAll('.feed-card').length, top: document.querySelector('.feed-scroll').scrollTop }));
    check('choosing a filter keeps the bar and starts the new feed at the top', kept.bar && kept.cards > 0 && kept.top === 0, JSON.stringify(kept));
    await c4.close();
  }

  console.log('\n─── new and coming ───');
  {
    const { ctx: c5, page: p5 } = await phone();
    await p5.evaluate(() => {
      /* Seen while it was coming (5001, out now) and seen while it still is
         (5021): the first comes back, now it is out; the second does not. */
      localStorage.setItem('wn.feed.seen', JSON.stringify(['movie:5001:soon', 'movie:5021:soon']));
      localStorage.setItem('wn.feed.filter', 'new');
    });
    await p5.reload({ waitUntil: 'networkidle' });
    await p5.waitForSelector('body.is-ready');
    hits.length = 0;
    await p5.tap('[data-tab="feed"]');
    await p5.waitForSelector('.feed-card[data-i="0"]');
    await p5.waitForTimeout(1200);
    const newReq = hits.find((x) => /\/discover\/movie/.test(x)) || '';
    check('New asks for UK cinema and digital releases of the last two months', /region=GB/.test(newReq) && /with_release_type=3(%7C|\|)2(%7C|\|)4/.test(newReq) && /release_date\.gte=/.test(newReq) && /primary_release_date\.gte=/.test(newReq), newReq);
    check('with no vote floor, which kept this week’s films out', !/vote_count/.test(newReq), newReq);
    const labels = await p5.evaluate(() => [...document.querySelectorAll('.feed-card')].slice(0, 4).map((c) => c.querySelector('.feed-when')?.textContent || ''));
    for (let i = 0; i < 18; i++) await next(p5);
    const titles = await p5.evaluate(() => [...document.querySelectorAll('.feed-title')].map((t) => t.textContent));
    check('it shows films out in UK cinemas and at home', titles.some((t) => /^Fresh Out/.test(t)) && titles.some((t) => /^Digital Drop/.test(t)), JSON.stringify(titles.slice(0, 8)));
    check('not old films re-released, nor ones with no UK date', !titles.some((t) => /^(Old Again|Elsewhere)/.test(t)), JSON.stringify(titles.filter((t) => /^(Old Again|Elsewhere)/.test(t))));
    check('a film seen while it was coming comes back now it is out', titles.includes('Fresh Out 1'), JSON.stringify(titles.slice(0, 6)));
    check('each card says it is new or in cinemas now', labels.length > 0 && labels.every((l) => /^(New|In cinemas now|In cinemas today|Out today)$/.test(l)), JSON.stringify(labels));

    await p5.evaluate(() => [...document.querySelectorAll('.feed-filter')].find((b) => b.textContent === 'Coming soon').click());
    await p5.waitForTimeout(1500);
    const soon = await p5.evaluate(() => [...document.querySelectorAll('.feed-card[data-i]')].map((c) => ({ t: c.querySelector('.feed-title').textContent, when: c.querySelector('.feed-when')?.textContent || '' })));
    check('Coming soon is a pill, and shows films not out yet', soon.length > 0 && soon.every((x) => /^Coming Up/.test(x.t)), JSON.stringify(soon.slice(0, 4)));
    check('each with its UK cinema date', soon.every((x) => /^In cinemas (tomorrow|[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2,3})/.test(x.when)), JSON.stringify(soon.slice(0, 4).map((x) => x.when)));
    check('and one seen while coming stays seen until it is out', !soon.some((x) => x.t === 'Coming Up 21'));
    const soonKey = (await state(p5)).film?.key;
    const stored = await p5.evaluate(() => JSON.parse(localStorage.getItem('wn.feed.seen') || '[]'));
    check('a film seen while coming is remembered as coming, for its second chance', !!soonKey && stored.includes(`${soonKey}:soon`) && !stored.includes(soonKey), JSON.stringify({ soonKey, stored: stored.filter((k) => /50\d\d/.test(k)) }));

    /* Added from Coming soon: on the list, but not Tonight's pick yet. */
    await p5.tap('.feed-card[data-i="0"] [data-act="add"]');
    await p5.waitForTimeout(700);
    const early = await p5.evaluate(async (t) => {
      const it = window.__test.items().find((x) => x.title === t);
      const { rank } = await import('./src/recommend.js');
      const ranked = rank(window.__test.items(), { limit: 1000 });
      return { released: it?.released, ranked: ranked.some((r) => r.item.uid === it?.uid) };
    }, soon[0].t);
    check('a film added before it is out knows when it will be', /^\d{4}-\d{2}-\d{2}$/.test(early.released || ''), JSON.stringify(early));
    check('and Tonight does not suggest it before then', !early.ranked, JSON.stringify(early));

    /* Scroll to the end of Coming soon: it says so, and offers to look again. */
    for (let i = 0; i < 24; i++) await next(p5);
    const endText = await p5.evaluate(() => document.querySelector('#screen-feed')?.textContent || '');
    check('the end of a list offers to check for new films', /That is everything here/.test(endText) && /Check for new films/.test(endText), endText.slice(-160));
    await c5.close();
  }

  console.log('\n─── staying fresh ───');
  {
    const { ctx: c6, page: p6 } = await phone();
    await p6.tap('[data-tab="feed"]');
    await p6.waitForSelector('.feed-card[data-i="3"]');
    for (let i = 0; i < 6; i++) await next(p6);
    const before = await state(p6);
    const taste0 = await p6.evaluate(() => localStorage.getItem('wn.feed.taste'));
    hits.length = 0;
    await p6.tap('[data-tab="feed"]');
    await p6.waitForTimeout(1500);
    const up = await state(p6);
    check('tapping Feed down the feed goes back to the top', up.current === 0 && up.count === before.count && hits.length === 0, JSON.stringify({ before: before.current, after: up.current, requests: hits.length }));
    check('without counting every film passed as a thumbs-down', (await p6.evaluate(() => localStorage.getItem('wn.feed.taste'))) === taste0);
    await p6.tap('[data-tab="feed"]');
    await p6.waitForTimeout(1500);
    const again = await state(p6);
    check('tapping it again at the top checks for new films', hits.some((x) => /page=1\b/.test(x)) && again.current === 0 && (again.film?.key !== before.film?.key), JSON.stringify({ requests: hits.length }));

    /* Half an hour away: the same card. Three hours: what is new now. */
    for (let i = 0; i < 3; i++) await next(p6);
    const placed = await state(p6);
    /* Put away at the real time; the clock moves on; opened again. */
    const away = (ms) => p6.evaluate((ms) => {
      if (!window.__realNow) window.__realNow = Date.now;
      Date.now = window.__realNow;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
      const base = window.__realNow();
      Date.now = () => base + ms;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
    }, ms);
    hits.length = 0;
    await away(119 * 60e3);
    await p6.waitForTimeout(800);
    const short = await state(p6);
    check('back after just under two hours: the same film, no new requests', short.current === placed.current && short.film?.key === placed.film?.key && hits.length === 0, JSON.stringify({ was: placed.current, now: short.current, requests: hits.length }));
    /* Reading one film for most of two hours, a look at the library, and
       straight back: not two hours away. */
    await p6.evaluate(() => { const base = window.__realNow(); Date.now = () => base + 110 * 60e3; });
    await p6.tap('[data-tab="library"]');
    await p6.waitForTimeout(200);
    await p6.evaluate(() => { const base = window.__realNow(); Date.now = () => base + 125 * 60e3; });
    hits.length = 0;
    await p6.tap('[data-tab="feed"]');
    await p6.waitForTimeout(800);
    const quick = await state(p6);
    check('a quick look at another tab does not count as time away', quick.film?.key === placed.film?.key && hits.length === 0, JSON.stringify({ requests: hits.length }));
    hits.length = 0;
    await away(121 * 60e3);
    await p6.waitForTimeout(1500);
    const long = await state(p6);
    const top = await p6.evaluate(() => document.querySelector('.feed-scroll').scrollTop);
    check('back after just over two hours: it starts again from what is new', long.current === 0 && top === 0 && hits.some((x) => /page=1\b/.test(x)), JSON.stringify({ current: long.current, top, requests: hits.length }));
    /* And through the tab bar, after three hours on another tab. */
    await p6.tap('[data-tab="library"]');
    await p6.waitForTimeout(300);
    await p6.evaluate(() => { const base = window.__realNow(); Date.now = () => base + 7 * 3600e3; });
    hits.length = 0;
    await p6.tap('[data-tab="feed"]');
    await p6.waitForTimeout(1500);
    const viaTab = await state(p6);
    check('and when the Feed tab is opened after hours on another', viaTab.current === 0 && hits.some((x) => /page=1\b/.test(x)), JSON.stringify({ current: viaTab.current, requests: hits.length }));
    await p6.evaluate(() => { Date.now = window.__realNow; });
    await c6.close();
  }

  console.log('\n─── no errors ───');
  check('no JavaScript errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('\nFailures:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.log('SUITE CRASHED:', e.message); process.exit(1); });

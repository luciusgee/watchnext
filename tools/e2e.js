/*
 * End-to-end suite.
 *
 * Every Tier-0 defect the audit confirmed in the old build gets an explicit
 * regression test here, so they cannot come back silently.
 */
const { chromium, devices } = require('/opt/node22/lib/node_modules/playwright');
const fs = require('fs');
const path = require('path');

const URL = 'http://127.0.0.1:8899/index.html';
const POSTER_DIR = path.join(__dirname, 'posters');
const POSTERS = fs.existsSync(POSTER_DIR) ? fs.readdirSync(POSTER_DIR).filter((f) => f.endsWith('.jpg')) : [];
/* 1x1 gif stand-in so the suite runs without the optional poster fixtures */
const BLANK = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');

let pass = 0, fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ ...devices['iPhone 13 Pro'] });
  await ctx.route('**://m.media-amazon.com/**', (route) => {
    let h = 0; const u = route.request().url();
    for (let i = 0; i < u.length; i++) h = (h * 31 + u.charCodeAt(i)) >>> 0;
    route.fulfill({ status: 200, contentType: 'image/jpeg',
      body: POSTERS.length ? fs.readFileSync(path.join(POSTER_DIR, POSTERS[h % POSTERS.length])) : BLANK });
  });

  const page = await ctx.newPage();
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(e.message));

  const state = () => page.evaluate(() => JSON.parse(localStorage.getItem('wn.state.v3')));
  const boot = async () => { await page.goto(URL, { waitUntil: 'networkidle' }); await page.waitForTimeout(900); };

  // ─────────────────────────────────────────────────────────
  console.log('\n─── boot & seed ───');
  await boot();
  let s = await state();
  /* A new install arrives empty. It used to arrive holding the author's own
     228 titles, marked as owned — somebody else's shelf, presented as yours,
     with no way to tell it apart from your own afterwards. */
  check('a new install starts empty', s.items.length === 0, `got ${s.items.length}`);
  const offered = await page.evaluate(() =>
    [...document.querySelectorAll('#screen-tonight button')].some((b) => /try a sample/i.test(b.textContent))
  );
  check('and offers the sample rather than imposing it', offered);

  await page.evaluate(() => window.__test.loadSample());
  await page.waitForTimeout(600);
  s = await state();
  check('the sample loads on request', s.items.length === 228, `got ${s.items.length}`);
  check('and no title hotlinks a third party CDN',
    s.items.every((i) => !/m\.media-amazon\.com/.test(i.poster || '')),
    s.items.filter((i) => /m\.media-amazon\.com/.test(i.poster || '')).length + ' do');
  check('every item has a stable uid', s.items.every((i) => typeof i.uid === 'string' && i.uid.length > 4));
  check('uids are unique', new Set(s.items.map((i) => i.uid)).size === s.items.length);
  check('schema is versioned', s.schema === 3, `got ${s.schema}`);
  check('no seed ships an unverified imdb id', s.items.every((i) => i.imdbId === null || /^tt\d+$/.test(i.imdbId)));

  // ─────────────────────────────────────────────────────────
  console.log('\n─── REGRESSION: deleting a seeded title must stay deleted ───');
  // Old bug: SEED was re-merged into the library on every page load, so a
  // removed title reappeared (with its watch state wiped) after one reload.
  const beforeDelete = (await state()).items.length;
  const victimUid = (await state()).items[5].uid;
  const victimTitle = (await state()).items[5].title;
  await page.evaluate((uid) => window.__test.remove(uid), victimUid);
  await page.waitForTimeout(300);
  await boot();
  s = await state();
  check('removed title does not come back after reload',
    s.items.length === beforeDelete - 1 && !s.items.some((i) => i.uid === victimUid),
    `${s.items.length} items, wanted ${beforeDelete - 1} (${victimTitle})`);

  // ─────────────────────────────────────────────────────────
  console.log('\n─── REGRESSION: "owned = false" must survive a reload ───');
  // Old bug: every 4K/1080p row was force-set downloaded=true on each load,
  // so unticking it never stuck.
  const ownedItem = (await state()).items.find((i) => i.owned && i.quality);
  await page.evaluate((uid) => window.__test.update(uid, { owned: false }), ownedItem.uid);
  await page.waitForTimeout(300);
  await boot();
  s = await state();
  check('unticking "I own this" persists',
    s.items.find((i) => i.uid === ownedItem.uid).owned === false,
    `${ownedItem.title} reverted to owned`);

  // ─────────────────────────────────────────────────────────
  console.log('\n─── REGRESSION: Discover reset must actually reset ───');
  // Old bug: the queue filtered on `swipedSeen`, the reset buttons cleared
  // `swiped`, and nothing read `swiped`. Discover died permanently.
  await page.click('[data-tab="discover"]');
  await page.waitForTimeout(700);
  const queueBefore = await page.evaluate(() => document.querySelectorAll('.deck-card').length);
  check('discover renders a card', queueBefore > 0, `${queueBefore} cards`);

  /* Two outcomes, not three. The deck asks one question — have you seen this —
     and the watchlist swipe that used to be the third is gone with the
     watchlist itself. */
  /* Scoped to Discover: the session picker has a deck of its own and an
     unscoped query happily counts both. */
  const deckButtons = await page.evaluate(() =>
    [...document.querySelectorAll('#screen-discover .deck-controls [data-action]')].map((b) => b.dataset.action)
  );
  check('the deck offers exactly two answers', deckButtons.length === 2, deckButtons.join(', '));
  check('and they are not-yet and seen-it',
    deckButtons.join(',') === 'skip,watched', deckButtons.join(','));

  await page.click('[data-action="skip"]'); await page.waitForTimeout(600);
  await page.click('[data-action="skip"]'); await page.waitForTimeout(600);
  await page.click('[data-action="watched"]'); await page.waitForTimeout(600);
  s = await state();
  const seenCount = s.items.filter((i) => i.seen).length;
  check('swiping marks items seen', seenCount === 3, `${seenCount} seen`);
  check('swiping right marks it watched', s.items.filter((i) => i.watched && i.seen).length >= 1);
  /* A left swipe means "not yet", which must write nothing beyond the triage
     flag — it is not a judgement about the film. */
  check('a left swipe does not mark anything watched',
    s.items.filter((i) => i.seen && !i.watched).length === 2,
    `${s.items.filter((i) => i.seen && !i.watched).length}`);

  await page.evaluate(() => window.__test.resetDiscover());
  await page.waitForTimeout(400);
  s = await state();
  check('reset clears every seen flag', s.items.filter((i) => i.seen).length === 0,
    `${s.items.filter((i) => i.seen).length} still seen`);
  await page.waitForTimeout(400);
  const cardsAfterReset = await page.evaluate(() => document.querySelectorAll('.deck-card').length);
  check('discover repopulates after reset', cardsAfterReset > 0, `${cardsAfterReset} cards`);

  // ─────────────────────────────────────────────────────────
  console.log('\n─── REGRESSION: identity is never resolved by title ───');
  // Old bug: writes were targeted with findIndex(m => m.t === title), so two
  // rows sharing a name clobbered each other.
  await page.evaluate(() => {
    window.__test.add({ title: 'Duplicate Test Film', year: 1999, type: 'movie' });
    window.__test.add({ title: 'Duplicate Test Film', year: 2020, type: 'movie' });
  });
  await page.waitForTimeout(300);
  s = await state();
  const dupes = s.items.filter((i) => i.title === 'Duplicate Test Film');
  check('same title, different years are two separate records', dupes.length === 2, `${dupes.length}`);
  await page.evaluate((uid) => window.__test.update(uid, { rating: 9.9 }), dupes[0].uid);
  await page.waitForTimeout(300);
  s = await state();
  const after = s.items.filter((i) => i.title === 'Duplicate Test Film');
  check('editing one leaves its namesake untouched',
    after.find((i) => i.uid === dupes[0].uid).rating === 9.9 &&
    after.find((i) => i.uid === dupes[1].uid).rating !== 9.9);

  // duplicate guard on add
  const addedAgain = await page.evaluate(() => window.__test.addItem({ title: 'Duplicate Test Film', year: 1999, type: 'movie' }).duplicate);
  check('adding an exact duplicate is refused', addedAgain === true);

  // ─────────────────────────────────────────────────────────
  console.log('\n─── watch state & undo ───');
  await page.click('[data-tab="library"]'); await page.waitForTimeout(600);
  await page.click('#screen-library .row, #screen-library .card'); await page.waitForTimeout(700);
  const detailUid = await page.evaluate(() => window.__test.currentDetailUid());
  check('detail opens', !!detailUid);

  await page.click('.detail-actions .btn'); await page.waitForTimeout(500);
  s = await state();
  check('mark watched sets watched + timestamp',
    s.items.find((i) => i.uid === detailUid)?.watched === true &&
    !!s.items.find((i) => i.uid === detailUid)?.watchedAt);

  const toastVisible = await page.evaluate(() => !!document.querySelector('.toast.is-open'));
  check('an undo toast appears', toastVisible);
  await page.click('.toast-action'); await page.waitForTimeout(500);
  s = await state();
  check('undo reverts it', s.items.find((i) => i.uid === detailUid)?.watched === false);

  // ─────────────────────────────────────────────────────────
  console.log('\n─── detail overlay behaviour ───');
  await page.keyboard.press('Escape'); await page.waitForTimeout(500);
  check('Escape closes the detail overlay',
    await page.evaluate(() => !document.getElementById('detail').classList.contains('is-open')));
  check('focus returns to the list after closing',
    await page.evaluate(() => document.activeElement?.closest('#screen-library') !== null));
  check('background is un-hidden from assistive tech',
    await page.evaluate(() => document.getElementById('app').getAttribute('aria-hidden') === 'false'));

  // ─────────────────────────────────────────────────────────
  console.log('\n─── library search, filter, sort ───');
  await page.fill('#library-search', 'alien'); await page.waitForTimeout(500);
  const searchCount = await page.evaluate(() => document.querySelectorAll('#screen-library .row, #screen-library .card').length);
  check('search narrows the list', searchCount > 0 && searchCount < 30, `${searchCount} results`);
  const allMatch = await page.evaluate(() =>
    [...document.querySelectorAll('#screen-library .row-t, #screen-library .card-t')]
      .every((n) => /alien/i.test(n.textContent)));
  check('every search result actually matches', allMatch);

  await page.fill('#library-search', ''); await page.waitForTimeout(500);
  await page.fill('#library-search', 'zzzznotathing'); await page.waitForTimeout(500);
  check('empty search shows an empty state',
    await page.evaluate(() => !!document.querySelector('#screen-library .empty')));
  await page.fill('#library-search', ''); await page.waitForTimeout(500);

  await page.click('[data-action="filter"]'); await page.waitForTimeout(500);
  check('filter sheet opens', await page.evaluate(() => !!document.querySelector('.sheet.is-open')));
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.sheet.is-open .pill')];
    btns.find((b) => b.textContent.trim() === 'Series')?.click();
  });
  await page.waitForTimeout(600);
  const tvOnly = await page.evaluate(() => window.__test.visibleUids().every((u) => window.__test.byUid(u).type === 'tv'));
  check('type filter shows only series', tvOnly);
  await page.evaluate(() => window.__test.clearFilters()); await page.waitForTimeout(500);

  // ─────────────────────────────────────────────────────────
  console.log('\n─── large library performance ───');
  const perf = await page.evaluate(async () => {
    const t0 = performance.now();
    window.__test.seedMany(600);
    await new Promise((r) => setTimeout(r, 60));
    const t1 = performance.now();
    const input = document.getElementById('library-search');
    input.value = 'the'; input.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 400));
    const t2 = performance.now();
    const rendered = document.querySelectorAll('#screen-library .row, #screen-library .card').length;
    input.value = ''; input.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 300));
    return { seedMs: t1 - t0, searchMs: t2 - t1, rendered, total: window.__test.count() };
  });
  check('handles 800+ titles', perf.total > 800, `${perf.total}`);
  check('search over 800 titles stays responsive', perf.searchMs < 900, `${Math.round(perf.searchMs)}ms`);
  check('list renders in chunks rather than all at once', perf.rendered <= 60, `${perf.rendered} nodes`);

  // ─────────────────────────────────────────────────────────
  console.log('\n─── export / import round trip ───');
  const round = await page.evaluate(() => {
    const payload = window.__test.exportPayload();
    const before = window.__test.count();
    const r = window.__test.importPayload(JSON.parse(JSON.stringify(payload)), 'merge');
    return { before, after: window.__test.count(), added: r.added, merged: r.merged, hasKeys: 'omdbKey' in (payload.settings || {}) || 'aiKey' in (payload.settings || {}) };
  });
  check('re-importing your own backup adds nothing', round.after === round.before, `${round.before} -> ${round.after}`);
  check('merge recognises every existing title', round.merged === round.before, `${round.merged}`);
  check('backup never contains API keys', round.hasKeys === false);

  /* A backup that loses a field is the worst bug this app can have, and it is
     invisible — the count matches, the titles are all there, and something you
     cannot see is gone. `genres` was being dropped exactly this way: written by
     metadata.toPatch, persisted by update(), and not declared in makeItem, which
     is what a backup is read through. So this asserts the general rule rather
     than that one field: whatever is on an item before the round trip is on it
     afterwards. */
  const fidelity = await page.evaluate(() => {
    const store = window.__test;
    const uid = store.items()[0].uid;
    store.update(uid, {
      genres: ['Horror', 'Thriller', 'Mystery'],
      quality: '4K',
      owned: true,
      locked: ['genre'],
      meta: { v: 3, status: 'confirmed', at: 1700000000000, confidence: 0.97, source: 'user' },
    });
    const before = JSON.parse(JSON.stringify(store.byUid(uid)));

    const payload = JSON.parse(JSON.stringify(store.exportPayload()));
    store.importPayload(payload, 'replace');
    const after = store.byUid(uid);

    const lost = Object.keys(before).filter(
      (k) => JSON.stringify(before[k]) !== JSON.stringify(after?.[k])
    );
    return { lost, count: store.count(), genres: after?.genres };
  });
  check('a backup round trip loses no field on a title',
    fidelity.lost.length === 0, `dropped or changed: ${fidelity.lost.join(', ')}`);
  check('including every genre, not just the display one',
    JSON.stringify(fidelity.genres) === JSON.stringify(['Horror', 'Thriller', 'Mystery']),
    JSON.stringify(fidelity.genres));

  /* The backup has always carried your name and your list/grid choice, and
     nothing ever read them back — a full restore quietly handed you the
     defaults. And a restore must not be a route for a hand-edited file to plant
     an API key, so the fields that come back are whitelisted. */
  const settingsRound = await page.evaluate(() => {
    const store = window.__test;
    const payload = store.exportPayload();
    payload.settings.name = 'Restored Name';
    payload.settings.libraryView = 'grid';
    payload.settings.dataKeys = { omdb: 'planted-by-a-hand-edited-file' };
    payload.settings.aiKey = 'also-planted';
    store.importPayload(payload, 'replace');
    const after = store.settings();
    return { name: after.name, view: after.libraryView, omdb: after.dataKeys?.omdb, ai: after.aiKey };
  });
  check('a full restore puts back the name it saved', settingsRound.name === 'Restored Name',
    String(settingsRound.name));
  check('and the list or grid choice', settingsRound.view === 'grid', String(settingsRound.view));
  check('but a backup cannot plant an API key', !settingsRound.omdb && !settingsRound.ai,
    `omdb=${settingsRound.omdb} ai=${settingsRound.ai}`);

  // ─────────────────────────────────────────────────────────
  console.log('\n─── persistence across reload ───');
  const target = await page.evaluate(() => {
    const i = window.__test.items().find((x) => !x.watched);
    window.__test.setWatched(i.uid, true);
    return { uid: i.uid, count: window.__test.count() };
  });
  await page.waitForTimeout(400);
  await boot();
  s = await state();
  check('watch state survives reload', s.items.find((i) => i.uid === target.uid)?.watched === true);
  check('library size survives reload', s.items.length === target.count, `${s.items.length} vs ${target.count}`);

  // ─────────────────────────────────────────────────────────
  console.log('\n─── keyboard access ───');
  await page.click('[data-tab="library"]'); await page.waitForTimeout(500);
  const kbd = await page.evaluate(() => {
    const first = document.querySelector('#screen-library .row, #screen-library .card');
    first.focus();
    const focused = document.activeElement === first;
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return { focused, tag: first.tagName };
  });
  check('list items are real buttons, focusable by keyboard', kbd.focused && kbd.tag === 'BUTTON');
  await page.keyboard.press('Enter'); await page.waitForTimeout(600);
  check('Enter opens the detail overlay',
    await page.evaluate(() => document.getElementById('detail').classList.contains('is-open')));
  await page.keyboard.press('Escape'); await page.waitForTimeout(400);

  const a11y = await page.evaluate(() => ({
    inlineOnclick: document.querySelectorAll('[onclick]').length,
    unlabelledButtons: [...document.querySelectorAll('button')]
      .filter((b) => b.offsetParent !== null && !b.textContent.trim() && !b.getAttribute('aria-label')).length,
    imagesWithoutAlt: [...document.querySelectorAll('img')].filter((i) => !i.hasAttribute('alt')).length,
    landmarks: document.querySelectorAll('main, nav, header').length,
    headings: document.querySelectorAll('h1, h2').length,
  }));
  check('no inline onclick handlers', a11y.inlineOnclick === 0, `${a11y.inlineOnclick}`);
  check('every visible button has an accessible name', a11y.unlabelledButtons === 0, `${a11y.unlabelledButtons}`);
  check('every image has alt text', a11y.imagesWithoutAlt === 0, `${a11y.imagesWithoutAlt}`);
  check('landmarks present', a11y.landmarks >= 5, `${a11y.landmarks}`);
  check('headings present', a11y.headings >= 2, `${a11y.headings}`);

  // ─────────────────────────────────────────────────────────
  console.log('\n─── no runaway network activity ───');
  // Old bug: a recursive setTimeout hammered OMDb forever with no exit.
  let omdbHits = 0;
  page.on('request', (r) => { if (r.url().includes('omdbapi')) omdbHits++; });
  await boot();
  await page.waitForTimeout(9000);
  check('makes no API calls without a configured key', omdbHits === 0, `${omdbHits} requests`);

  // ─────────────────────────────────────────────────────────
  console.log('\n─── all tabs render without error ───');
  for (const tab of ['tonight', 'discover', 'library', 'ask']) {
    await page.click(`[data-tab="${tab}"]`); await page.waitForTimeout(600);
    const ok = await page.evaluate((t) => {
      const s = document.getElementById(`screen-${t}`);
      return s.classList.contains('is-active') && s.textContent.trim().length > 0;
    }, tab);
    check(`${tab} renders`, ok);
  }
  await page.click('#screen-ask [data-nav="settings"]'); await page.waitForTimeout(700);
  check('settings renders', await page.evaluate(() => document.querySelector('#screen-settings [data-region="body"]').children.length > 3));
  check('tab bar stays visible on settings', await page.evaluate(() => !!document.querySelector('.tabbar')?.offsetParent));

  // ─────────────────────────────────────────────────────────
  console.log('\n─── the Ask key prompt goes away once a key is connected ───');
  // The prompt is rendered into the same thread element as the conversation,
  // and the greeting only ran when that element was empty. A key is connected
  // on a different screen, so coming back left the invitation stranded at the
  // top with replies stacking underneath it.
  await page.evaluate(async () => {
    const store = await import('./src/store.js');
    store.updateSettings({ aiKey: '' });
    store.saveNow();
  });
  await page.click('[data-tab="ask"]');
  await page.waitForTimeout(500);

  const noKey = await page.evaluate(() => ({
    prompt: !!document.querySelector('#screen-ask [data-no-key]'),
    text: document.querySelector('#screen-ask [data-region="thread"]').innerText,
  }));
  check('with no key, the prompt is shown', noKey.prompt);
  check('and it asks for one', /Connect a key/i.test(noKey.text), noKey.text.slice(0, 60));

  /* Connect a key the way a user does — on another screen, then come back. */
  await page.click('#screen-ask [data-nav="settings"]');
  await page.waitForTimeout(500);
  await page.evaluate(async () => {
    const store = await import('./src/store.js');
    store.updateSettings({ aiKey: 'sk-ant-test' });
    store.saveNow();
  });
  await page.click('[data-tab="ask"]');
  await page.waitForTimeout(500);

  const withKey = await page.evaluate(() => ({
    prompt: !!document.querySelector('#screen-ask [data-no-key]'),
    text: document.querySelector('#screen-ask [data-region="thread"]').innerText,
  }));
  check('the prompt is gone once a key is connected', withKey.prompt === false);
  check('and it greets instead', /Tell me what you fancy/i.test(withKey.text), withKey.text.slice(0, 60));

  /* The reverse must not be destructive: clearing a key should never wipe a
     conversation the user can still read. */
  await page.evaluate(() => {
    const thread = document.querySelector('#screen-ask [data-region="thread"]');
    const msg = document.createElement('div');
    msg.className = 'msg msg-user';
    msg.textContent = 'A REAL MESSAGE';
    thread.appendChild(msg);
  });
  await page.evaluate(async () => {
    const store = await import('./src/store.js');
    store.updateSettings({ aiKey: '' });
    store.saveNow();
  });
  await page.click('[data-tab="library"]');
  await page.waitForTimeout(300);
  await page.click('[data-tab="ask"]');
  await page.waitForTimeout(500);
  const kept = await page.evaluate(
    () => document.querySelector('#screen-ask [data-region="thread"]').innerText
  );
  check('clearing a key does not wipe an existing conversation', /A REAL MESSAGE/.test(kept), kept.slice(0, 80));

  // ─────────────────────────────────────────────────────────
  /* The screen that makes the recommendation has to find out whether it was
     right. Without this the taste profile never learns from the thing it just
     suggested, which is the one place in the app where that feedback is free. */
  console.log('\n─── Tonight closes its own loop ───');
  await page.click('[data-tab="tonight"]');
  await page.waitForTimeout(700);

  const heroBefore = await page.evaluate(() => ({
    title: document.querySelector('#screen-tonight .hero-title')?.textContent,
    labels: [...document.querySelectorAll('#screen-tonight .hero-actions button')].map((b) => b.textContent.trim()),
  }));
  check('the hero offers a one-tap "seen it"', heroBefore.labels.includes('Seen it'),
    heroBefore.labels.join(' | '));
  /* Two labels a letter apart, one of which edits the library, is a mis-tap
     waiting to happen. */
  check('and it is not confusable with the play action',
    !heroBefore.labels.includes('Watch it') && heroBefore.labels.includes('Put it on'),
    heroBefore.labels.join(' | '));

  const watchedBefore = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('wn.state.v3')).items.filter((i) => i.watched).length
  );
  await page.evaluate(() =>
    [...document.querySelectorAll('#screen-tonight .hero-actions button')]
      .find((b) => b.textContent.trim() === 'Seen it').click()
  );
  await page.waitForTimeout(700);

  const afterWatch = await page.evaluate(() => {
    const items = JSON.parse(localStorage.getItem('wn.state.v3')).items;
    return {
      watched: items.filter((i) => i.watched).length,
      stamped: items.filter((i) => i.watched && i.watchedAt).length,
      title: document.querySelector('#screen-tonight .hero-title')?.textContent,
    };
  });
  check('tapping it marks exactly one more title watched',
    afterWatch.watched === watchedBefore + 1, `${watchedBefore} -> ${afterWatch.watched}`);
  check('with a timestamp, so the taste profile can weight it by age',
    afterWatch.stamped === afterWatch.watched, `${afterWatch.stamped}/${afterWatch.watched}`);
  check('and the hero moves on to something else',
    afterWatch.title !== heroBefore.title, `${heroBefore.title} -> ${afterWatch.title}`);

  // ─────────────────────────────────────────────────────────
  /* Bulk edit. The operation that matters at five hundred titles: setting a
     format across a shelf, or marking a run as owned, is otherwise five hundred
     trips through the detail screen — which is why it does not get done, and why
     the format data on a big library is patchy. */
  console.log('\n─── selecting more than one thing at a time ───');
  await page.click('[data-tab="library"]');
  await page.waitForTimeout(600);
  await page.evaluate(() => window.__test.clearFilters());
  /* List view explicitly: an earlier test restores a backup that carries
     libraryView 'grid', and selection is list-only by design. */
  await page.evaluate(() => {
    if (!document.querySelector('#screen-library .row')) {
      document.querySelector('#screen-library [data-action="view"]').click();
    }
  });
  await page.waitForTimeout(500);

  const enterSelection = async (n) => {
    await page.evaluate((count) => {
      const rows = [...document.querySelectorAll('#screen-library .row')].slice(0, count);
      for (const r of rows) {
        r.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientY: 100 }));
      }
    }, n);
    await page.waitForTimeout(700);
  };

  await enterSelection(3);
  const selection = await page.evaluate(() => ({
    bar: !!document.querySelector('[data-region="select-bar"]'),
    count: document.querySelector('.select-count')?.textContent,
    marked: document.querySelectorAll('#screen-library .row.is-picked').length,
  }));
  check('holding a row starts a selection', selection.bar, JSON.stringify(selection));
  check('and says how many are in it', /3 selected/.test(selection.count || ''), selection.count);
  check('with the chosen rows marked', selection.marked === 3, String(selection.marked));

  const chosenUids = await page.evaluate(() => window.__test.visibleUids().slice(0, 3));
  const ownedBefore = await page.evaluate((uids) =>
    uids.map((u) => window.__test.byUid(u)).map((i) => ({ owned: i.owned, quality: i.quality })), chosenUids);

  await page.evaluate(() =>
    [...document.querySelectorAll('.select-act')].find((b) => /Owned/.test(b.textContent)).click()
  );
  await page.waitForTimeout(500);
  await page.evaluate(() =>
    [...document.querySelectorAll('.sheet-actions button')].find((b) => /Owned — 4K/.test(b.textContent)).click()
  );
  await page.waitForTimeout(700);

  const afterBulk = await page.evaluate((uids) =>
    uids.map((u) => window.__test.byUid(u)).map((i) => ({ owned: i.owned, quality: i.quality })), chosenUids);
  check('setting a format applies to every selected title',
    afterBulk.every((i) => i.owned === true && i.quality === '4K'), JSON.stringify(afterBulk));
  check('and the selection ends afterwards',
    await page.evaluate(() => !document.querySelector('[data-region="select-bar"]')));

  /* One undo for the batch, not one per title — thirty toasts is not an undo. */
  const undone = await page.evaluate(async () => {
    const btn = [...document.querySelectorAll('.toast button')].find((b) => /Undo/.test(b.textContent));
    if (!btn) return null;
    btn.click();
    await new Promise((r) => setTimeout(r, 500));
    return true;
  });
  check('a batch is one undo, not one per title', undone === true);
  if (undone) {
    const restored = await page.evaluate((uids) =>
      uids.map((u) => window.__test.byUid(u)).map((i) => ({ owned: i.owned, quality: i.quality })), chosenUids);
    check('and it puts every one of them back',
      JSON.stringify(restored) === JSON.stringify(ownedBefore),
      `${JSON.stringify(restored)} vs ${JSON.stringify(ownedBefore)}`);
  }

  // ─────────────────────────────────────────────────────────
  /* Telling the app to stop suggesting something. The scorer is otherwise
     unarguable: it picks, and the only recourse is saying "something else"
     forever. */
  console.log('\n─── stop suggesting this ───');
  await page.click('[data-tab="tonight"]');
  await page.waitForTimeout(700);

  const heroTitle = await page.evaluate(() =>
    document.querySelector('#screen-tonight .hero-title')?.textContent);
  await page.evaluate(() => document.querySelector('#screen-tonight .hero .card')?.click());
  await page.waitForTimeout(600);

  const hasMute = await page.evaluate(() =>
    [...document.querySelectorAll('#detail button')].some((b) => /Stop suggesting this/.test(b.textContent)));
  check('a title can be muted from its own screen', hasMute);

  await page.evaluate(() =>
    [...document.querySelectorAll('#detail button')].find((b) => /Stop suggesting this/.test(b.textContent)).click());
  await page.waitForTimeout(500);

  const stillThere = await page.evaluate((t) => {
    const items = JSON.parse(localStorage.getItem('wn.state.v3')).items;
    return items.some((i) => i.title === t);
  }, heroTitle);
  check('muting does not delete it — it stays in the library', stillThere, heroTitle);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);
  const newHero = await page.evaluate(() =>
    document.querySelector('#screen-tonight .hero-title')?.textContent);
  check('and Tonight suggests something else', newHero !== heroTitle, `${heroTitle} -> ${newHero}`);

  /* Reversible, and findable. A preference you cannot undo is a bug that looks
     like the app losing films. */
  await page.click('#screen-tonight [data-nav="settings"]');
  await page.waitForTimeout(700);
  const listed = await page.evaluate((t) =>
    [...document.querySelectorAll('#screen-settings button')].some((b) => b.textContent.includes(t)), heroTitle);
  check('it is listed in Settings so it can be found again', listed, heroTitle);

  await page.evaluate((t) =>
    [...document.querySelectorAll('#screen-settings button')].find((b) => b.textContent.includes(t))?.click(), heroTitle);
  await page.waitForTimeout(500);
  const unmuted = await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('wn.state.v3'));
    return (s.settings.taste?.never || []).length === 0;
  });
  check('and un-muting puts it back', unmuted);

  // ─────────────────────────────────────────────────────────
  /* Sending someone a shelf.
   *
   * The whole point is that it needs no server: the list lives in the URL
   * fragment, which browsers never transmit. So the assertions are that a link
   * round-trips, that opening one shows the films without touching the library,
   * and that adding is deliberate rather than automatic. */
  console.log('\n─── sending someone a shelf ───');

  const roundTrip = await page.evaluate(async () => {
    const { encodeShelf, decodeShelf, MAX_TITLES } = await import('./src/share.js');
    const films = [
      { title: 'The Thing', year: 1982, quality: '4K', watched: true },
      { title: "Rosemary's Baby", year: 1968, quality: null, watched: false },
      /* A title carrying the characters an encoder is most likely to break on. */
      { title: 'Amélie | 100% & "quotes"', year: 2001, quality: '1080p', watched: false },
    ];
    const url = await encodeShelf(films, { origin: 'https://example.test/app/index.html' });
    const back = await decodeShelf(url.slice(url.indexOf('#')));
    return { url, back, max: MAX_TITLES };
  });

  check('a shelf encodes into a link', /#l=1\./.test(roundTrip.url), roundTrip.url.slice(0, 60));
  check('the list travels in the fragment, which is never sent to a server',
    roundTrip.url.indexOf('#') > 0 && !/\?/.test(roundTrip.url.split('#')[0]));
  check('and decodes back to the same films',
    roundTrip.back.length === 3 && roundTrip.back[0].title === 'The Thing', JSON.stringify(roundTrip.back[0]));
  check('punctuation survives the round trip',
    roundTrip.back[2].title === 'Amélie | 100% & "quotes"', roundTrip.back[2].title);
  check('so do year, format and watch state',
    roundTrip.back[0].year === 1982 && roundTrip.back[0].quality === '4K' && roundTrip.back[0].watched === true,
    JSON.stringify(roundTrip.back[0]));

  /* The cap is what keeps a link inside what messaging apps will carry. */
  const size = await page.evaluate(async () => {
    const { encodeShelf } = await import('./src/share.js');
    const films = Array.from({ length: 100 }, (_, i) => ({
      title: `A Reasonably Long Film Title ${i}`, year: 1980 + (i % 45), quality: '4K', watched: i % 2 === 0,
    }));
    const url = await encodeShelf(films, { origin: 'https://example.test/app/index.html' });
    return url.length;
  });
  check('100 titles fit in a link any app will carry', size < 2600, `${size} chars`);

  /* Opening one. */
  const beforeShelf = await page.evaluate(() => window.__test.count());
  /* Setting the hash and reloading, not goto-with-a-fragment: a navigation that
     changes only the fragment is same-document, so boot never re-runs and the
     app never sees the shelf. */
  const openLink = async (fragment) => {
    await page.evaluate((f) => { location.hash = f; }, fragment);
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('body.is-ready');
    await page.waitForTimeout(900);
  };
  await openLink(roundTrip.url.slice(roundTrip.url.indexOf('#')));

  const shown = await page.evaluate(() => ({
    active: document.querySelector('.screen.is-active')?.id,
    text: document.querySelector('#screen-shelf [data-region="body"]')?.innerText || '',
    count: window.__test.count(),
  }));
  check('opening a link shows the shelf', shown.active === 'screen-shelf', String(shown.active));
  check('with the films on it', /The Thing/.test(shown.text), shown.text.slice(0, 120));
  check('and nothing is added to your own library until you say so',
    shown.count === beforeShelf, `${beforeShelf} -> ${shown.count}`);
  check('it says which ones you have not got', /have not got|already have all/.test(shown.text), shown.text.slice(0, 200));
  /* The recipient may not have the app, so the page has to explain itself. */
  check('and explains that nothing was uploaded', /nothing was uploaded/i.test(shown.text));

  const addedOne = await page.evaluate(async () => {
    const before = window.__test.count();
    [...document.querySelectorAll('#screen-shelf button')].find((b) => b.textContent.trim() === 'Add')?.click();
    await new Promise((r) => setTimeout(r, 600));
    return { before, after: window.__test.count() };
  });
  check('adding one is a single deliberate tap',
    addedOne.after === addedOne.before + 1, `${addedOne.before} -> ${addedOne.after}`);

  /* A truncated link must say so rather than render an empty shelf, which reads
     as "their shelf is empty" or as the app being broken. */
  await openLink('#l=1.thisisnotvalidbase64!!!');
  check('a truncated or corrupt link says so',
    await page.evaluate(() => /could not be read/.test(
      document.querySelector('#screen-shelf [data-region="body"]')?.innerText || '')));

  await page.evaluate(() => { history.replaceState(null, '', location.pathname); });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('body.is-ready');
  await page.waitForTimeout(700);

  // ─────────────────────────────────────────────────────────
  /* One shelf, two watch histories.
   *
   * The load-bearing property is that a solo library is untouched: with fewer
   * than two people nothing appears, nothing changes shape, and every existing
   * behaviour is the behaviour it always was. */
  console.log('\n─── one shelf, separate histories ───');

  await page.click('[data-tab="tonight"]');
  await page.waitForTimeout(600);
  const soloScreen = await page.evaluate(() =>
    document.querySelector('#screen-tonight [data-region="body"]').innerText);
  /* Case-insensitive deliberately: innerText returns rendered text and
     .eyebrow is uppercased in CSS, so /Watching/ matches nothing either way —
     which would make this assertion and its opposite both pass. */
  check('with nobody named, the app says nothing about people', !/watching/i.test(soloScreen));

  const beforePeople = await page.evaluate(() =>
    JSON.stringify(JSON.parse(localStorage.getItem('wn.state.v3')).items.map((i) => i.watched)));

  /* Adding the first person hands them the existing history, because it is
     theirs — the app has only ever had one user until this moment. */
  await page.evaluate(() => {
    window.__test.addPerson('Luke');
  });
  await page.waitForTimeout(500);
  const afterFirst = await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('wn.state.v3'));
    const id = s.settings.people[0].id;
    const watched = s.items.filter((i) => i.watched);
    return {
      people: s.settings.people.length,
      inherited: watched.every((i) => i.watchedBy && id in i.watchedBy),
      watchedFlags: JSON.stringify(s.items.map((i) => i.watched)),
    };
  });
  check('the first person inherits the existing watch history', afterFirst.inherited);
  check('and the shared watched flags are untouched by that',
    afterFirst.watchedFlags === beforePeople);

  const stillSolo = await page.evaluate(() => {
    document.querySelector('[data-tab="library"]').click();
    document.querySelector('[data-tab="tonight"]').click();
    return document.querySelector('#screen-tonight [data-region="body"]').innerText;
  });
  check('one person still shows no switcher — it is not a household yet',
    !/watching/i.test(stillSolo));

  await page.evaluate(() => window.__test.addPerson('Sam'));
  await page.waitForTimeout(600);
  await page.click('[data-tab="library"]');
  await page.waitForTimeout(300);
  await page.click('[data-tab="tonight"]');
  await page.waitForTimeout(700);
  check('a second person brings out the switcher',
    await page.evaluate(() => /watching/i.test(
      document.querySelector('#screen-tonight [data-region="body"]').innerText)));

  /* The point of the whole feature: a film one of them has seen is still a
     first watch for the other. */
  const perPerson = await page.evaluate(async () => {
    const st = await import('./src/store.js');
    const [luke, sam] = st.people();
    const film = st.items().find((i) => i.watched);
    return {
      lukeSeen: st.seenBy(film, luke.id),
      samSeen: st.seenBy(film, sam.id),
      shared: film.watched,
    };
  });
  check('a film watched before the household existed belongs to the first person',
    perPerson.lukeSeen === true);
  check('and is unwatched for the second', perPerson.samSeen === false);
  check('while the shared flag still says somebody here has seen it', perPerson.shared === true);

  /* Removing someone takes their marks with them rather than leaving orphans
     that quietly count towards "everyone here has seen this". */
  const afterRemoval = await page.evaluate(async () => {
    const st = await import('./src/store.js');
    const sam = st.people().find((p) => p.name === 'Sam');
    st.removePerson(sam.id);
    return {
      people: st.people().length,
      orphans: st.items().filter((i) => i.watchedBy && sam.id in i.watchedBy).length,
      titles: st.items().length,
    };
  });
  check('removing a person removes their marks', afterRemoval.orphans === 0);
  check('and does not touch the library', afterRemoval.titles > 0);

  await page.evaluate(async () => {
    const st = await import('./src/store.js');
    st.people().slice().forEach((p) => st.removePerson(p.id));
  });
  await page.waitForTimeout(400);

  /* Tonight's shortlist.
   *
   * The load-bearing property is the one in the brief — "it doesn't affect your
   * watchlist, it's just a way to pick a film there and then" — so the first
   * thing asserted is that a whole session through the deck changes nothing at
   * all. Not watched, not seen, not a timestamp. */
  console.log('\n─── tonight\'s shortlist changes nothing ───');

  await page.click('[data-tab="tonight"]');
  await page.waitForTimeout(600);
  const reachable = await page.evaluate(() =>
    [...document.querySelectorAll('#screen-tonight button')].some((b) => /Find something else/.test(b.textContent))
  );
  check('it is reachable from the Tonight pick', reachable);

  /* The entry point opens the sheet, not a hand. Landing straight on a deck
     dealt from whatever was set last session is the bug this replaced. */
  await page.evaluate(() =>
    [...document.querySelectorAll('#screen-tonight button')]
      .find((b) => /Find something else/.test(b.textContent))?.click()
  );
  await page.waitForTimeout(500);
  check('and asks what you fancy before dealing anything',
    await page.evaluate(() => !!document.querySelector('.sheet #pick-brief')));

  await page.evaluate(() =>
    [...document.querySelectorAll('.sheet button')].find((b) => /Deal me some/.test(b.textContent))?.click()
  );
  await page.waitForTimeout(900);

  const dealt = await page.evaluate(() => document.querySelectorAll('#screen-pick .deck-card').length);
  check('it deals a hand', dealt > 0, `${dealt} cards`);
  check('and dealing takes you to the deck',
    await page.evaluate(() => document.getElementById('screen-pick').classList.contains('is-active')));

  const beforeSession = await page.evaluate(() =>
    JSON.stringify(JSON.parse(localStorage.getItem('wn.state.v3')).items)
  );

  /* Swipe all the way through — every "no" the deck will take. */
  for (let i = 0; i < 14; i++) {
    const gone = await page.evaluate(() => {
      const b = document.querySelector('#screen-pick [data-action="no"]');
      return !b || b.closest('[data-region="controls"]').hidden;
    });
    if (gone) break;
    await page.click('#screen-pick [data-action="no"]');
    await page.waitForTimeout(280);
  }

  const afterSession = await page.evaluate(() =>
    JSON.stringify(JSON.parse(localStorage.getItem('wn.state.v3')).items)
  );
  check('a full session through the deck writes nothing to the library',
    beforeSession === afterSession, beforeSession === afterSession ? '' : 'the stored library changed');

  /* And structurally: the module has no way to write, which is a stronger
     guarantee than remembering not to. */
  const pickSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'screens', 'pick.js'), 'utf8');
  const writeCalls = ['store.update', 'store.add(', 'store.remove', 'store.bulk', 'store.saveNow',
                      'store.updateSettings', 'actions.', "from '../actions.js'"];
  const foundWrites = writeCalls.filter((w) => pickSrc.includes(w));
  check('and the picker cannot write even by accident', foundWrites.length === 0, foundWrites.join(', '));

  check('running out offers a way to widen rather than a dead end',
    await page.evaluate(() => {
      const empty = document.querySelector('#screen-pick .empty');
      return !!empty && /Widen it|Start again/.test(empty.textContent);
    }));

  /* Measured, not asserted from the property. `controls.hidden = true` sets the
     attribute and the attribute did nothing: the browser's `[hidden]` rule is
     outranked by any author `display`, and `.deck-controls` sets `display:flex`.
     Reading `.hidden` back said what the code had just written, so the swipe
     buttons sat live over an empty deck for weeks with a green test above
     them. getBoundingClientRect is the version that can fail. */
  const controlsGone = await page.evaluate(() => {
    const c = document.querySelector('#screen-pick [data-region="controls"]');
    return c.getBoundingClientRect().height === 0;
  });
  check('and takes the swipe buttons away with it', controlsGone, 'controls still occupy space');

  /* Constraints actually constrain. Under 90 minutes is the easiest to check
     against the real records. */
  await page.click('#screen-pick [data-action="constraints"]');
  await page.waitForTimeout(500);
  await page.evaluate(() =>
    [...document.querySelectorAll('.sheet .pill')].find((b) => b.textContent === 'Under 90 min')?.click()
  );
  await page.waitForTimeout(500);
  await page.evaluate(() =>
    [...document.querySelectorAll('.sheet button')].find((b) => /Deal me some/.test(b.textContent))?.click()
  );
  await page.waitForTimeout(800);

  const runtimes = await page.evaluate(() => {
    const titles = [...document.querySelectorAll('#screen-pick .deck-title')].map((n) => n.textContent);
    const items = JSON.parse(localStorage.getItem('wn.state.v3')).items;
    return titles.map((t) => items.find((i) => i.title === t)?.runtime ?? null);
  });
  check('a runtime constraint is honoured by every card dealt',
    runtimes.length > 0 && runtimes.every((r) => r === null || r <= 90), JSON.stringify(runtimes));

  const pickButtons = await page.evaluate(() =>
    [...document.querySelectorAll('#screen-pick .deck-controls [data-action]')].map((b) => b.dataset.action)
  );
  check('the shortlist offers exactly two answers', pickButtons.join(',') === 'no,yes', pickButtons.join(','));

  await page.click('#screen-pick [data-action="yes"]');
  await page.waitForTimeout(700);
  check('saying yes opens the film',
    await page.evaluate(() => document.getElementById('detail').getAttribute('aria-hidden') === 'false'));

  const afterYes = await page.evaluate(() =>
    JSON.stringify(JSON.parse(localStorage.getItem('wn.state.v3')).items)
  );
  check('and even a yes writes nothing on its own', afterYes === afterSession);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  // ─────────────────────────────────────────────────────────
  /*
   * Asking Claude for the hand.
   *
   * Every assertion here is about the boundary, because that is where the risk
   * is: a model returning a number for a film that is not on the shelf, a model
   * that is sent a parameter it rejects, a network that is not there. The
   * quality of the picks is not testable and is not what this guards.
   */
  console.log('\n─── the hand Claude deals ───');

  let lastAsk = null;
  let lastAskHeaders = null;
  let askStatus = 200;

  await ctx.route('https://api.anthropic.com/**', async (route) => {
    lastAsk = JSON.parse(route.request().postData() || '{}');
    lastAskHeaders = route.request().headers();
    if (askStatus !== 200) {
      await route.fulfill({
        status: askStatus,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'planted failure' } }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        stop_reason: 'end_turn',
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              note: 'Two on your shelf get close to that.',
              picks: [
                { n: 3, why: 'The third one, and the closest thing you own to that.' },
                { n: 1, why: 'The obvious one.' },
                /* A film that is not on the shelf. The whole point of sending
                   indices is that this cannot resolve to anything. */
                { n: 9999, why: 'Something you do not own.' },
              ],
            }),
          },
        ],
      }),
    });
  });

  await page.evaluate(async () => {
    const store = await import('./src/store.js');
    store.updateSettings({ aiKey: 'sk-ant-planted', aiModel: '' });
    store.saveNow();
  });

  const askFor = async (text) => {
    await page.click('[data-tab="tonight"]');
    await page.waitForTimeout(500);
    await page.evaluate(() =>
      [...document.querySelectorAll('#screen-tonight button')]
        .find((b) => /Find something else/.test(b.textContent))?.click()
    );
    await page.waitForTimeout(400);
    await page.fill('.sheet #pick-brief', text);
    await page.evaluate(() =>
      [...document.querySelectorAll('.sheet button')].find((b) => /Ask Claude/.test(b.textContent))?.click()
    );
    await page.waitForTimeout(900);
  };

  await askFor('horror in the vein of Ari Aster');

  /* What the shelf looked like from the model's side, so the reply above can be
     checked against the titles that actually went out. */
  const shelfLines = String(lastAsk?.messages?.[0]?.content || '')
    .split('\n')
    .filter((l) => /^\d+\.\s/.test(l))
    .map((l) => l.replace(/^\d+\.\s*/, '').replace(/\s+—.*$/, '').replace(/\s+\(\d{4}\)$/, ''));

  check('the ask reaches Anthropic', Boolean(lastAsk), 'no request captured');
  check('with the key from settings',
    lastAskHeaders?.['x-api-key'] === 'sk-ant-planted', lastAskHeaders?.['x-api-key']);
  check('and the header a browser needs to be allowed to call it at all',
    lastAskHeaders?.['anthropic-dangerous-direct-browser-access'] === 'true');
  check('the default model is the balanced one',
    lastAsk?.model === 'claude-sonnet-5', String(lastAsk?.model));
  check('and the reply is schema-constrained rather than parsed out of prose',
    lastAsk?.output_config?.format?.type === 'json_schema', JSON.stringify(lastAsk?.output_config));
  check('the whole shelf goes over, not a pre-filtered slice',
    shelfLines.length > 100, `${shelfLines.length} titles`);

  const hand = await page.evaluate(() => {
    /* The deck stacks back-to-front, so the last child is the card on top —
       reading querySelectorAll order here would silently assert the reverse. */
    const cards = [...document.querySelectorAll('#screen-pick [data-region="deck"] > .deck-card')];
    const title = (c) => c?.querySelector('.deck-title')?.textContent || null;
    return {
      front: title(cards[cards.length - 1]),
      behind: cards.length > 1 ? title(cards[0]) : null,
      frontWhy: cards[cards.length - 1]?.querySelector('.deck-why')?.textContent || '',
      meta: document.querySelector('#screen-pick [data-region="meta"]').innerText,
      active: document.getElementById('screen-pick').classList.contains('is-active'),
    };
  });

  check('the answer lands on the deck', hand.active);
  check('the card on top is the one Claude ranked first',
    hand.front === shelfLines[2], `${hand.front} vs ${shelfLines[2]}`);
  check('and the one behind it is its second',
    hand.behind === shelfLines[0], `${hand.behind} vs ${shelfLines[0]}`);
  check('each card carries why it is there',
    /closest thing you own/.test(hand.frontWhy), hand.frontWhy);
  /* Case-sensitively: this line used to be lowercased by CSS, which is fine for
     "tense · horror" and wrong for a title somebody typed. */
  check('the ask is quoted back exactly as it was typed',
    hand.meta.includes('Ari Aster'), hand.meta.replace(/\n/g, ' / '));
  check("and Claude's note is shown", /close to that/.test(hand.meta), hand.meta.replace(/\n/g, ' / '));

  /* The safety property. A number outside the list cannot become a film. */
  for (let i = 0; i < 3; i++) {
    const done = await page.evaluate(() => {
      const b = document.querySelector('#screen-pick [data-action="no"]');
      return !b || b.closest('[data-region="controls"]').hidden;
    });
    if (done) break;
    await page.click('#screen-pick [data-action="no"]');
    await page.waitForTimeout(300);
  }
  const exhaustedAfter = await page.evaluate(() =>
    document.querySelector('#screen-pick [data-region="controls"]').hidden
  );
  check('a number for a film you do not own is dropped, not invented',
    exhaustedAfter, 'a third card was dealt from an out-of-range index');

  const afterAsk = await page.evaluate(() =>
    JSON.stringify(JSON.parse(localStorage.getItem('wn.state.v3')).items)
  );
  check('and nothing Claude said was written to the library', afterAsk === afterSession);

  /* Haiku 4.5 rejects output_config.effort outright — a 400 for a parameter
     that is only ever an optimisation. Sending it anyway would take the whole
     feature down for anyone who picked the cheap model. */
  await page.evaluate(async () => {
    const store = await import('./src/store.js');
    store.updateSettings({ aiModel: 'claude-haiku-4-5' });
    store.saveNow();
  });
  await askFor('something short');
  check('the fast model is asked without the effort parameter it rejects',
    lastAsk?.model === 'claude-haiku-4-5' && lastAsk?.output_config?.effort === undefined,
    JSON.stringify({ model: lastAsk?.model, output_config: lastAsk?.output_config }));

  /* A phone in a pocket with no signal must still be able to pick a film. */
  askStatus = 500;
  await page.evaluate(async () => {
    const store = await import('./src/store.js');
    store.updateSettings({ aiModel: '' });
    store.saveNow();
  });
  await askFor('anything at all');
  const fallback = await page.evaluate(() => ({
    cards: document.querySelectorAll('#screen-pick .deck-card').length,
    toast: document.querySelector('.toast')?.innerText || '',
  }));
  check('a failed ask falls back to a hand rather than a dead end', fallback.cards > 0, `${fallback.cards} cards`);
  check('and says why it is not the one that was asked for',
    /trouble|Anthropic|reach/i.test(fallback.toast), fallback.toast);

  askStatus = 200;
  await ctx.unroute('https://api.anthropic.com/**');
  await page.evaluate(async () => {
    const store = await import('./src/store.js');
    store.updateSettings({ aiKey: '' });
    store.saveNow();
  });

  /* Your shelf, counted — and the card, which is the only channel this app has
     for anyone hearing about it. Both free on purpose. */
  console.log('\n─── your shelf, counted ───');
  await page.click('[data-tab="tonight"]');
  await page.waitForTimeout(600);

  const statBtn = await page.evaluate(() => {
    const b = [...document.querySelectorAll('#screen-tonight button')].find((x) => /titles.*watched/.test(x.textContent));
    if (b) b.click();
    return !!b;
  });
  check('the stat line is a way in, not a caption', statBtn);
  await page.waitForTimeout(700);

  const shelf = await page.evaluate(() => {
    const t = document.querySelector('#screen-stats [data-region="body"]').innerText;
    const items = JSON.parse(localStorage.getItem('wn.state.v3')).items;
    const pile = items.filter((i) => i.owned && !i.watched).length;
    return { text: t, pile, hasCard: /Make a card/.test(t) };
  });
  check('the pile is the headline number',
    new RegExp(`\\b${shelf.pile}\\b`).test(shelf.text), `expected ${shelf.pile}`);
  check('it says what the pile is', /never watched/.test(shelf.text));
  check('and offers the card', shelf.hasCard);

  /* The card is drawn locally and must produce a real PNG — a screenshot
     prompt would be a different, worse feature. */
  const card = await page.evaluate(async () => {
    const net = () => performance.getEntriesByType('resource').filter((e) => /upload|api\./.test(e.name)).length;
    /* Bracketed around the click rather than counted for the whole session.
       Counting from boot made this a claim about the entire run that happened
       to hold only while nothing else in the suite had called an API — it went
       red the moment a Claude test ran earlier in the same page. */
    const beforeNet = net();
    const before = document.querySelectorAll('a[download]').length;
    [...document.querySelectorAll('#screen-stats button')].find((b) => /Make a card/.test(b.textContent)).click();
    await new Promise((r) => setTimeout(r, 900));
    return {
      madeALink: document.querySelectorAll('a[download]').length >= before,
      newRequests: net() - beforeNet,
    };
  });
  check('making a card does not throw', card.madeALink);
  check('and uploads nothing', card.newRequests === 0, `${card.newRequests} requests`);

  console.log('\n─── uncaught JS errors ───');
  check('no uncaught errors during the whole run', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '));

  console.log(`\n══════════  ${pass} passed, ${fail} failed  ══════════`);
  if (failures.length) { console.log('\nFailures:'); failures.forEach((f) => console.log('  · ' + f)); }
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE CRASHED:', e.message, '\n', e.stack); process.exit(2); });

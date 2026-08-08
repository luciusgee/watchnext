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
  check('seeds the library on first run', s.items.length === 228, `got ${s.items.length}`);
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

  await page.click('[data-action="skip"]'); await page.waitForTimeout(600);
  await page.click('[data-action="skip"]'); await page.waitForTimeout(600);
  await page.click('[data-action="save"]'); await page.waitForTimeout(600);
  s = await state();
  const seenCount = s.items.filter((i) => i.seen).length;
  check('swiping marks items seen', seenCount === 3, `${seenCount} seen`);
  check('swiping right onto watchlist sets saved', s.items.filter((i) => i.saved).length >= 1);

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

  console.log('\n─── uncaught JS errors ───');
  check('no uncaught errors during the whole run', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | '));

  console.log(`\n══════════  ${pass} passed, ${fail} failed  ══════════`);
  if (failures.length) { console.log('\nFailures:'); failures.forEach((f) => console.log('  · ' + f)); }
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE CRASHED:', e.message, '\n', e.stack); process.exit(2); });

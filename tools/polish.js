/*
 * The polish pass, held in place.
 *
 * Most of what that pass changed is feel — easing, spacing, press states — and
 * is judged by eye. These are the parts that were outright broken, or that the
 * pass itself could have broken, measured in a real browser so they cannot
 * quietly come back.
 */
const { chromium, devices } = require('/opt/node22/lib/node_modules/playwright');

const APP_URL = 'http://127.0.0.1:8899/index.html'; // not `URL`: that shadows the constructor

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ ...devices['iPhone 13 Pro'] });
  /* The people this is for are on iPhones with iOS 18 or later, where the
     switch control exists and every marked control carries a haptic overlay
     (haptics.js). Chromium has no switch; this makes the page believe it
     does, so the whole run goes through the overlays the way their taps do. */
  await ctx.addInitScript(() => {
    Object.defineProperty(HTMLInputElement.prototype, 'switch', {
      configurable: true,
      get() { return this.hasAttribute('switch'); },
      set(v) { this.toggleAttribute('switch', !!v); },
    });
  });
  await ctx.route(/image\.tmdb\.org|m\.media-amazon\.com|api\.themoviedb\.org|omdbapi\.com|api\.anthropic\.com|api\.github\.com/, (r) => r.abort());
  const page = await ctx.newPage();
  const jsErrors = [];
  page.on('pageerror', (e) => jsErrors.push(e.message));
  const boot = async () => { await page.goto(APP_URL, { waitUntil: 'networkidle' }); await page.waitForTimeout(700); };
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('wn.state.v3')).items);
  /* Add and Settings are not tabs; they are reached from the top bar. */
  const tab = async (name) => {
    await page.evaluate((n) => {
      const b = document.querySelector(`[data-tab="${n}"]`) ||
        document.querySelector(`.screen.is-active [data-nav="${n}"]`) ||
        document.querySelector(`[data-nav="${n}"]`);
      b.click();
    }, name);
    await page.waitForTimeout(400);
  };

  await boot();

  console.log('\n─── launch ───');
  /* The hook was set on every launch and styled by nothing. */
  const shell = await page.evaluate(() => ({
    ready: document.body.classList.contains('is-ready'),
    opacity: getComputedStyle(document.getElementById('app')).opacity,
  }));
  check('the shell fades in once the first screen is ready', shell.ready && shell.opacity === '1', JSON.stringify(shell));

  console.log('\n─── titles pasted with their bullets ───');
  await page.evaluate(async () => {
    const st = await import('./src/store.js');
    st.add({ title: '•\tThe Power', year: 2021 });
    st.add({ title: '•\tRare Exports: A Christmas Tale', year: 2010 });
    st.add({ title: 'X-Men', year: 2000 });
    st.saveNow();
  });
  await boot();
  const repaired = await stored();
  const t = (y) => repaired.find((i) => i.year === y);
  check('a stored bullet is repaired on load', t(2021)?.title === 'The Power', JSON.stringify(t(2021)?.title));
  check('and its sort key with it', t(2021)?.sortTitle === 'power', JSON.stringify(t(2021)?.sortTitle));
  check('a title with a colon comes through whole', t(2010)?.title === 'Rare Exports: A Christmas Tale');
  check('and a hyphenated title is left alone', t(2000)?.title === 'X-Men');
  /* Persisted on the next write, not only fixed in memory: a backup taken now
     carries the clean title. */
  const exported = await page.evaluate(async () => {
    const st = await import('./src/store.js');
    return st.exportPayload().items.map((i) => i.title);
  });
  check('an export straight after carries the clean title', exported.includes('The Power') && !exported.some((x) => /•/.test(x)));

  await tab('add');
  await page.evaluate(() => [...document.querySelectorAll('#screen-add .seg button')].find((b) => b.textContent === 'Paste a list').click());
  await page.waitForTimeout(200);
  const addDisabled = await page.evaluate(() =>
    [...document.querySelectorAll('#screen-add .btn-primary')].find((b) => /Add to library/.test(b.textContent)).disabled
  );
  check('the paste button waits for something to paste', addDisabled);
  await page.fill('#bulk-input', '•\tThe Outwaters\n- Hereditary (2018)\n1. Alien\n2. Aliens');
  await page.evaluate(() =>
    [...document.querySelectorAll('#screen-add .btn-primary')].find((b) => /Add to library/.test(b.textContent)).click()
  );
  await page.waitForTimeout(400);
  const pasted = (await stored()).map((i) => i.title);
  check('a pasted bullet list goes in clean',
    ['The Outwaters', 'Hereditary', 'Alien', 'Aliens'].every((x) => pasted.includes(x)),
    JSON.stringify(pasted.slice(-4)));
  check('and nothing with a marker got in', !pasted.some((x) => /^[•\-\d]/.test(x) && x !== 'X-Men'));

  console.log('\n─── adding one by hand ───');
  /* The whole mode was inert: button() made it type=button inside a form. */
  await page.evaluate(() => [...document.querySelectorAll('#screen-add .seg button')].find((b) => b.textContent === 'By hand').click());
  await page.waitForTimeout(200);
  const before = (await stored()).length;
  await page.click('#screen-add button[type="submit"]');
  await page.waitForTimeout(300);
  check('an empty title is refused out loud', (await stored()).length === before &&
    (await page.evaluate(() => /title first/.test(document.querySelector('.toast')?.textContent || ''))));
  await page.fill('#add-title', 'Oldboy');
  await page.fill('#add-year', '2003');
  await page.click('#screen-add button[type="submit"]');
  await page.waitForTimeout(300);
  const byHand = (await stored()).find((i) => i.title === 'Oldboy');
  check('the Add button adds the title', !!byHand, `library went ${before} → ${(await stored()).length}`);
  check('with its year', byHand?.year === 2003);
  check('and the form clears for the next one', (await page.inputValue('#add-title')) === '');

  console.log('\n─── searching with no key ───');
  /* A native submit navigated to index.html?, dropping the route and cold
     rebooting the app back to Tonight. */
  await page.evaluate(() => [...document.querySelectorAll('#screen-add .seg button')].find((b) => b.textContent === 'Search').click());
  await page.waitForTimeout(200);
  await page.evaluate(() => { window.__stillHere = true; });
  await page.evaluate(() => document.querySelector('#screen-add form').requestSubmit());
  await page.waitForTimeout(500);
  const stayed = await page.evaluate(() => ({
    here: window.__stillHere === true,
    screen: document.querySelector('.screen.is-active')?.id,
    disabled: document.getElementById('add-search').disabled,
  }));
  check('submitting does not reload the app', stayed.here && stayed.screen === 'screen-add', JSON.stringify(stayed));
  check('and the search box says it cannot work yet', stayed.disabled);

  console.log('\n─── selecting in the library ───');
  await page.evaluate(() => window.__test.loadSample());
  await page.waitForTimeout(500);
  await tab('library');
  await page.evaluate(async () => {
    const st = await import('./src/store.js');
    st.updateSettings({ libraryView: 'list' });
  });
  /* Deep enough that the rows are past the first chunk. */
  const deep = await page.evaluate(async () => {
    const sc = document.querySelector('#screen-library .scroll');
    for (let i = 0; i < 6; i++) { sc.scrollTop = sc.scrollHeight; await new Promise((r) => setTimeout(r, 120)); }
    sc.scrollTop = 4000;
    await new Promise((r) => setTimeout(r, 150));
    return { top: sc.scrollTop, rows: document.querySelectorAll('#screen-library .row').length };
  });
  const target = await page.evaluate(() => {
    const sc = document.querySelector('#screen-library .scroll');
    const box = sc.getBoundingClientRect();
    const row = [...document.querySelectorAll('#screen-library .row')].find((r) => {
      const b = r.getBoundingClientRect();
      return b.top > box.top + 80 && b.bottom < box.bottom - 120;
    });
    const b = row.getBoundingClientRect();
    return { uid: row.dataset.uid, x: b.x + b.width / 2, y: b.y + b.height / 2 };
  });
  await page.mouse.move(target.x, target.y);
  await page.mouse.down();
  await page.waitForTimeout(600);
  await page.mouse.up();
  await page.waitForTimeout(400);
  const afterHold = await page.evaluate((uid) => {
    const sc = document.querySelector('#screen-library .scroll');
    const row = document.querySelector(`#screen-library .row[data-uid="${uid}"]`);
    const bar = document.querySelector('[data-region="select-bar"]');
    return {
      top: sc.scrollTop,
      rows: document.querySelectorAll('#screen-library .row').length,
      picked: row?.classList.contains('is-picked'),
      bar: bar ? bar.classList.contains('is-open') : false,
      count: bar?.querySelector('.select-count')?.textContent,
    };
  }, target.uid);
  /* The hold's own click used to be harmless only because the rebuild threw the
     row away. Rows now survive selecting, so the click has to be swallowed. */
  check('a long press selects the row and it stays selected', afterHold.picked, JSON.stringify(afterHold));
  check('the selection bar slides in', afterHold.bar && afterHold.count === '1 selected', JSON.stringify(afterHold));
  check('and the list stays exactly where it was', Math.abs(afterHold.top - deep.top) < 2 && afterHold.rows >= deep.rows,
    `scroll ${deep.top} → ${afterHold.top}, rows ${deep.rows} → ${afterHold.rows}`);

  const tapped = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#screen-library .row:not(.is-picked)')];
    const sc = document.querySelector('#screen-library .scroll').getBoundingClientRect();
    const r = rows.find((x) => { const b = x.getBoundingClientRect(); return b.top > sc.top && b.bottom < sc.bottom - 120; });
    r.click();
    return r.dataset.uid;
  });
  await page.waitForTimeout(200);
  check('a tap adds to the selection rather than opening the film',
    await page.evaluate((uid) =>
      document.querySelector(`#screen-library .row[data-uid="${uid}"]`).classList.contains('is-picked') &&
      document.getElementById('detail').getAttribute('aria-hidden') === 'true', tapped));

  await page.evaluate(() => [...document.querySelectorAll('.select-act')].find((b) => /Done/.test(b.textContent)).click());
  await page.waitForTimeout(400);
  const cleared = await page.evaluate(() => ({
    picked: document.querySelectorAll('#screen-library .row.is-picked').length,
    bar: !!document.querySelector('[data-region="select-bar"]'),
    marks: document.querySelectorAll('#screen-library .row-pick.is-on').length,
  }));
  check('Done clears the selection and the bar goes', !cleared.picked && !cleared.bar && !cleared.marks, JSON.stringify(cleared));

  console.log('\n─── the library filter sheet ───');
  await page.click('#screen-library [data-action="filter"]');
  await page.waitForTimeout(400);
  const opened = await page.evaluate(() => {
    const sheet = [...document.querySelectorAll('.sheet')].find((s) => s.getAttribute('aria-label') === 'Filter library');
    sheet.scrollTop = sheet.scrollHeight;
    return { top: sheet.scrollTop, slid: getComputedStyle(sheet).transform };
  });
  await page.evaluate(() =>
    [...document.querySelectorAll('.sheet .pill')].find((b) => b.textContent === 'Not watched').click()
  );
  await page.waitForTimeout(250);
  const afterPill = await page.evaluate(() => {
    const sheets = [...document.querySelectorAll('.sheet')].filter((s) => s.getAttribute('aria-label') === 'Filter library');
    const sheet = sheets[0];
    const pill = [...sheet.querySelectorAll('.pill')].find((b) => b.textContent === 'Not watched');
    return { count: sheets.length, top: sheet.scrollTop, pressed: pill.getAttribute('aria-pressed'),
      show: [...sheet.querySelectorAll('.btn')].find((b) => /^Show|Nothing/.test(b.textContent))?.textContent };
  });
  check('choosing a filter keeps the same sheet', afterPill.count === 1, `${afterPill.count} sheets`);
  check('and it stays scrolled where you were', afterPill.top > 0 && Math.abs(afterPill.top - opened.top) < 2,
    `${opened.top} → ${afterPill.top}`);
  check('the pill shows as chosen', afterPill.pressed === 'true');
  check('and the button says how many it will show', /^Show \d+ titles?$/.test(afterPill.show || ''), afterPill.show);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  check('Escape closes it', await page.evaluate(() => !document.querySelector('.sheet[aria-label="Filter library"]')));

  console.log('\n─── the detail overlay ───');
  await page.evaluate(async () => {
    const lib = await import('./src/screens/library.js');
    document.querySelector('#screen-library .row, #screen-library .card').click();
  });
  await page.waitForTimeout(400);
  const open = await page.evaluate(() => ({
    label: document.getElementById('detail').getAttribute('aria-labelledby'),
    title: document.getElementById('detail-title')?.textContent,
    close: document.querySelector('.detail-back')?.getAttribute('aria-label'),
  }));
  check('the dialog is named by the film, not "Title details"', open.label === 'detail-title' && !!open.title, JSON.stringify(open));
  check('and on first open its button says Close', open.close === 'Close');
  await page.click('.detail-back');
  await page.waitForTimeout(80);
  const closing = await page.evaluate(() => getComputedStyle(document.getElementById('detail')).display);
  await page.waitForTimeout(400);
  const closed = await page.evaluate(() => ({
    display: getComputedStyle(document.getElementById('detail')).display,
    cls: document.getElementById('detail').className,
  }));
  check('closing animates out rather than vanishing', closing === 'flex', `display mid-close: ${closing}`);
  check('and then it is gone', closed.display === 'none' && !/is-closing/.test(closed.cls), JSON.stringify(closed));

  console.log('\n─── no errors ───');
  check('no JavaScript errors across all of that', jsErrors.length === 0, jsErrors.join(' | '));

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('\nFailures:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.log('SUITE CRASHED:', e.message); process.exit(1); });

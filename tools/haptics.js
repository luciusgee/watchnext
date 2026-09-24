/*
 * Haptics.
 *
 * A headless browser cannot feel anything, and Chromium has no switch control,
 * so the page is told it is Safari on iOS 18+ (the switch attribute exists)
 * and what is tested is the part that can be wrong in code:
 *
 *   - a tap on a marked control lands on the overlay label, and the label
 *     hands a TRUSTED click to its switch — since iOS 26.5 that is the only
 *     click the switch will tick for;
 *   - the control's own handler still runs exactly once per tap;
 *   - the switch's click, input and change never reach anything else;
 *   - disabled controls and the Settings switch being off leave taps alone;
 *   - nothing is built where the switch does not exist.
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
  const block = /image\.tmdb\.org|m\.media-amazon\.com|api\.themoviedb\.org|omdbapi\.com|api\.anthropic\.com|api\.github\.com/;
  const errors = [];

  const ctx = await browser.newContext({ ...devices['iPhone 13 Pro'] });
  await ctx.route(block, (r) => r.abort());
  await ctx.addInitScript(() => {
    /* What Safari on iOS 18+ looks like to feature detection. */
    Object.defineProperty(HTMLInputElement.prototype, 'switch', {
      configurable: true,
      get() { return this.hasAttribute('switch'); },
      set(v) { this.toggleAttribute('switch', !!v); },
    });
    /* Every click that reaches an overlay switch is a tick on a real phone —
       if it is trusted. Capture phase, so the switch's own stopPropagation
       does not hide it from the count. */
    window.__ticks = [];
    window.__leaks = 0;
    /* Counted where haptics.js stops the switch's click rather than by a
       listener on the document: a control whose handler re-renders it has
       taken the switch out of the page by the time the label passes the click
       on, so the click never travels through the document at all. WebKit
       still plays the tick for it — the haptic does not need the switch to be
       on screen. */
    const stop = Event.prototype.stopPropagation;
    Event.prototype.stopPropagation = function () {
      if (this.type === 'click' && this.target?.classList?.contains('haptic-switch')) window.__ticks.push(this.isTrusted);
      return stop.call(this);
    };
    for (const type of ['click', 'input', 'change']) {
      document.addEventListener(type, (e) => {
        if (e.target?.classList?.contains('haptic-switch')) window.__leaks++;
      });
    }
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(APP_URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('body.is-ready');
  await page.evaluate(() => window.__test.loadSample());
  await page.waitForTimeout(400);

  const ticks = () => page.evaluate(() => window.__ticks.slice());
  const reset = () => page.evaluate(() => { window.__ticks = []; });
  /* Count the clicks the control itself receives, from now on. */
  const countHost = (selector) => page.evaluate((s) => {
    const host = document.querySelector(s);
    window.__hostClicks = 0;
    /* One counter at a time: the deck buttons are the same elements all run. */
    window.__counted?.el.removeEventListener('click', window.__counted.fn);
    const fn = () => window.__hostClicks++;
    host?.addEventListener('click', fn);
    window.__counted = host ? { el: host, fn } : null;
    return !!host;
  }, selector);
  const hostClicks = () => page.evaluate(() => window.__hostClicks);

  console.log('\n─── a tap on the control is a tap on the switch ───');
  await page.tap('[data-tab="discover"]');
  await page.waitForTimeout(500);
  const SKIP = '#screen-discover [data-action="skip"]';
  const shape = await page.evaluate((s) => {
    const host = document.querySelector(s);
    const label = host.querySelector(':scope > .haptic');
    const sw = label?.querySelector('input');
    const a = host.getBoundingClientRect();
    const b = label.getBoundingClientRect();
    const hit = document.elementFromPoint(a.x + a.width / 2, a.y + a.height / 2);
    const cs = getComputedStyle(sw);
    return {
      isLabel: label?.tagName === 'LABEL' && label.classList.contains('haptic'),
      hidden: label?.getAttribute('aria-hidden'),
      sw: sw?.type === 'checkbox' && sw.hasAttribute('switch'),
      tabindex: sw?.hasAttribute('tabindex'),
      /* Out to the border edge, with at most a pixel to spare. */
      covers: b.x <= a.x && b.y <= a.y && b.right >= a.right && b.bottom >= a.bottom && b.width - a.width <= 2 && b.height - a.height <= 2,
      hitLabel: hit === label,
      opacity: cs.opacity,
      appearance: cs.appearance,
    };
  }, SKIP);
  check('a marked control gets a label over its whole face', shape.isLabel && shape.covers && shape.hitLabel, JSON.stringify(shape));
  check('wrapping a native switch with no tabindex', shape.sw && !shape.tabindex, JSON.stringify(shape));
  check('invisible, but keeping its native appearance', shape.opacity === '0' && shape.appearance !== 'none', JSON.stringify(shape));
  check('and hidden from VoiceOver', shape.hidden === 'true');

  const before = await page.evaluate(() => document.querySelector('#screen-discover .deck-card:last-child')?.textContent);
  await countHost(SKIP);
  await reset();
  await page.tap(SKIP);
  await page.waitForTimeout(400);
  const t1 = await ticks();
  check('a tap on a deck button reaches the switch as a trusted click', t1.length === 1 && t1[0] === true, JSON.stringify(t1));
  check('and the button’s own handler runs once', (await hostClicks()) === 1, String(await hostClicks()));
  const after = await page.evaluate(() => document.querySelector('#screen-discover .deck-card:last-child')?.textContent);
  check('and the card is decided', before && after && before !== after);

  await page.waitForSelector('.toast.is-open .toast-action');
  await countHost('.toast-action');
  await reset();
  await page.tap('.toast-action');
  await page.waitForTimeout(400);
  check('Undo ticks', (await ticks()).length === 1, JSON.stringify(await ticks()));
  check('and undoes once', (await hostClicks()) === 1);
  const back = await page.evaluate(() => document.querySelector('#screen-discover .deck-card:last-child')?.textContent);
  check('and the card comes back', back === before);

  /* A pill that ran its handler twice would switch on and straight back off. */
  await page.tap('[data-tab="library"]');
  await page.waitForTimeout(400);
  await page.tap('#screen-library [data-action="filter"]');
  await page.waitForTimeout(500);
  const PILL = '.pill[data-haptic][data-value]:not([data-value="all"])';
  const pillBefore = await page.evaluate((s) => document.querySelector(s)?.getAttribute('aria-pressed'), PILL);
  await reset();
  await page.tap(PILL);
  await page.waitForTimeout(300);
  const pillAfter = await page.evaluate((s) => document.querySelector(s)?.getAttribute('aria-pressed'), PILL);
  check('a filter pill ticks', (await ticks()).length === 1, JSON.stringify(await ticks()));
  check('and switches on, not on and back off', pillBefore === 'false' && pillAfter === 'true', `${pillBefore} → ${pillAfter}`);
  await page.evaluate(() => window.__test.clearFilters?.());
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  await page.tap('[data-tab="tonight"]');
  await page.waitForTimeout(500);
  const seenUid = await page.evaluate(() => {
    const items = window.__test.items();
    const title = document.querySelector('#screen-tonight .hero h1, #screen-tonight .hero h2')?.textContent;
    return items.find((i) => i.title === title)?.uid || null;
  });
  await reset();
  await page.locator('#screen-tonight .hero button', { hasText: 'Seen it' }).tap();
  await page.waitForTimeout(400);
  check('Seen it ticks', (await ticks()).length === 1, JSON.stringify(await ticks()));
  if (seenUid) check('and marks it watched', await page.evaluate((u) => window.__test.byUid(u)?.watched === true, seenUid));

  /* A caption set with textContent takes the label with it. */
  const rearmed = await page.evaluate(async () => {
    const host = document.querySelector('#screen-tonight [data-haptic]');
    host.textContent = host.textContent;
    await new Promise((r) => setTimeout(r, 0));
    return !!host.querySelector(':scope > .haptic');
  });
  check('a control whose caption is replaced gets its label back', rearmed);

  const disabled = await page.evaluate(() => {
    const host = document.querySelector('#screen-tonight [data-haptic]');
    host.disabled = true;
    const r = host.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    const out = { display: getComputedStyle(host.querySelector(':scope > .haptic')).display, hitLabel: hit?.classList.contains('haptic') };
    host.disabled = false;
    return out;
  });
  check('a disabled control drops its label, so the tap does nothing', disabled.display === 'none' && !disabled.hitLabel, JSON.stringify(disabled));

  /* Every button, not a chosen few. */
  const coverage = await page.evaluate(() => {
    const hosts = [...document.querySelectorAll('button, a[href]:not([download])')].filter(
      (b) => !b.parentElement.closest('.haptic, button, a[href]')
    );
    const bare = hosts.filter((b) => !b.querySelector(':scope > .haptic'));
    return { hosts: hosts.length, bare: bare.map((b) => b.outerHTML.slice(0, 80)) };
  });
  check('every button and link in the app carries a label', coverage.hosts > 30 && coverage.bare.length === 0, JSON.stringify(coverage));
  const caption = await page.evaluate(() => {
    const b = document.querySelector('#screen-tonight .btn');
    return b.firstElementChild?.classList.contains('haptic') && !b.lastElementChild?.classList.contains('haptic');
  });
  check('it goes in first, so code changing a caption through lastElementChild still finds the caption', caption);

  /* The label takes the click's default action, so a submit button has to be
     submitted by hand — once. */
  await page.tap('[data-tab="tonight"]');
  await page.waitForTimeout(300);
  await page.evaluate(() => document.querySelector('#screen-tonight [data-nav="add"]').click());
  await page.waitForTimeout(400);
  await page.locator('#screen-add .seg button', { hasText: 'By hand' }).tap();
  await page.waitForTimeout(300);
  const countBefore = await page.evaluate(() => window.__test.count());
  await page.fill('#add-title', 'Haptic Submit Film');
  await page.evaluate(() => document.activeElement?.blur());
  await reset();
  await page.tap('#screen-add button[type="submit"]');
  await page.waitForTimeout(400);
  const countAfter = await page.evaluate(() => window.__test.count());
  check('a submit button ticks', (await ticks()).length === 1, JSON.stringify(await ticks()));
  check('and submits its form exactly once', countAfter === countBefore + 1, `${countBefore} → ${countAfter}`);
  await reset();
  await page.tap('#screen-add button[type="submit"]');
  await page.waitForTimeout(300);
  check('and an empty one is still refused, not submitted blank', (await page.evaluate(() => window.__test.count())) === countAfter);

  /* And a link has to be followed by hand — once. */
  const opened = await page.evaluate(async () => {
    const calls = [];
    const real = window.open;
    window.open = (...a) => { calls.push(a[0]); return null; };
    const a = document.createElement('a');
    a.href = 'https://example.com/trailer';
    a.target = '_blank';
    a.textContent = 'Trailer';
    a.style.cssText = 'position:fixed;top:200px;left:100px;padding:20px;z-index:5000;background:#333';
    document.body.appendChild(a);
    await new Promise((r) => setTimeout(r, 0));
    const r = a.getBoundingClientRect();
    window.__linkBox = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    window.__openCalls = calls;
    window.__restoreOpen = () => { window.open = real; a.remove(); };
    return !!a.querySelector(':scope > .haptic');
  });
  const box = await page.evaluate(() => window.__linkBox);
  const popups = [];
  page.context().on('page', (p) => popups.push(p.url()));
  await reset();
  await page.touchscreen.tap(box.x, box.y);
  await page.waitForTimeout(400);
  const linkCalls = await page.evaluate(() => { const c = window.__openCalls.slice(); window.__restoreOpen(); return c; });
  check('a link carries a label too', opened);
  check('and ticks', (await ticks()).length === 1, JSON.stringify(await ticks()));
  check('and opens once', linkCalls.length + popups.length === 1, JSON.stringify({ linkCalls, popups }));

  check('the switch’s click, input and change never reach anything else', (await page.evaluate(() => window.__leaks)) === 0, String(await page.evaluate(() => window.__leaks)));

  console.log('\n─── off means off ───');
  await page.tap('[data-tab="settings"]').catch(() => {});
  if (!(await page.evaluate(() => !!document.getElementById('haptics-switch')))) {
    await page.evaluate(() => document.querySelector('[data-nav="settings"]')?.click());
  }
  await page.waitForTimeout(500);
  const sw = await page.evaluate(() => {
    const s = document.getElementById('haptics-switch');
    return s ? { checked: s.checked, disabled: s.disabled, native: s.hasAttribute('switch') } : null;
  });
  check('Settings has a Haptics switch, on by default', sw && sw.checked && !sw.disabled && sw.native, JSON.stringify(sw));
  await page.tap('label[for="haptics-switch"]');
  await page.waitForTimeout(200);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('wn.state.v3')).settings.haptics);
  check('turning it off is saved', stored === false, String(stored));
  /* A switch is an input, and "an input has focus" used to mean "a keyboard is
     coming" — so tapping this hid the tab bar. */
  const barShown = await page.evaluate(() => !document.body.classList.contains('is-typing') &&
    document.querySelector('.tabbar').getClientRects().length > 0);
  check('and tapping the switch leaves the tab bar where it is', barShown);
  await page.tap('[data-tab="discover"]');
  await page.waitForTimeout(500);
  await countHost(SKIP);
  await reset();
  await page.tap(SKIP);
  await page.waitForTimeout(400);
  check('and nothing ticks after that', (await ticks()).length === 0, JSON.stringify(await ticks()));
  check('while the button still works', (await hostClicks()) === 1, String(await hostClicks()));
  const synced = await page.evaluate(async () => {
    const st = await import('./src/store.js');
    return 'haptics' in (st.syncSnapshot().settings || {});
  });
  check('and it is not synced to the other phone', synced === false);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('body.is-ready');
  check('and it is still off after a reload', await page.evaluate(() => document.documentElement.classList.contains('no-haptics')));
  await ctx.close();

  console.log('\n─── nothing where there is no switch ───');
  for (const [name, device] of [['a desktop', devices['Desktop Chrome']], ['an iPhone before iOS 18', devices['iPhone 13 Pro']]]) {
    const c = await browser.newContext({ ...device });
    await c.route(block, (r) => r.abort());
    const p = await c.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(APP_URL, { waitUntil: 'networkidle' });
    await p.waitForSelector('body.is-ready');
    await p.evaluate(() => window.__test.loadSample());
    await p.waitForTimeout(300);
    await p.click('[data-tab="discover"]');
    await p.waitForTimeout(400);
    const n = await p.evaluate(() => document.querySelectorAll('.haptic').length);
    check(`${name} gets no overlays`, n === 0, String(n));
    await c.close();
  }

  console.log('\n─── no errors ───');
  check('no JavaScript errors', errors.length === 0, errors.join(' | '));

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('\nFailures:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.log('SUITE CRASHED:', e.message); process.exit(1); });

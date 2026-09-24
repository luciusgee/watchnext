/*
 * Haptics.
 *
 * A headless browser cannot feel anything, so what is tested is the part that
 * can be wrong in code: the right kind plays at the right moment, nothing plays
 * when the setting is off, and the iPhone technique — clicking a hidden label
 * wrapped round a native switch — is built so it cannot take focus from a text
 * field or pop the keyboard.
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

  /* ── Android: navigator.vibrate, recorded ── */
  const ctx = await browser.newContext({ ...devices['Pixel 7'] });
  await ctx.route(block, (r) => r.abort());
  await ctx.addInitScript(() => {
    window.__buzz = [];
    navigator.vibrate = (p) => { window.__buzz.push(p); return true; };
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(APP_URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('body.is-ready');
  await page.evaluate(() => window.__test.loadSample());
  await page.waitForTimeout(400);
  const buzz = () => page.evaluate(() => window.__buzz.slice());
  const reset = () => page.evaluate(() => { window.__buzz = []; });

  console.log('\n─── the right feel at the right moment ───');
  await page.click('[data-tab="discover"]');
  await page.waitForTimeout(500);
  await reset();
  await page.click('#screen-discover [data-action="skip"]');
  await page.waitForTimeout(350);
  check('a swipe decision lands with a firm tap', JSON.stringify(await buzz()) === '[14]', JSON.stringify(await buzz()));

  await reset();
  await page.evaluate(() => [...document.querySelectorAll('.toast-action')].find((b) => /Undo/.test(b.textContent))?.click());
  await page.waitForTimeout(300);
  check('Undo plays the light tick', JSON.stringify(await buzz()) === '[8]', JSON.stringify(await buzz()));

  await page.click('[data-tab="tonight"]');
  await page.waitForTimeout(500);
  await reset();
  await page.evaluate(() => [...document.querySelectorAll('#screen-tonight .hero button')].find((b) => /Seen it/.test(b.textContent))?.click());
  await page.waitForTimeout(300);
  check('marking something watched plays success', JSON.stringify(await buzz()) === JSON.stringify([[12, 70, 18]]), JSON.stringify(await buzz()));

  await reset();
  await page.evaluate(() => document.querySelector('#screen-tonight .hero-scope button')?.click());
  await page.waitForTimeout(200);
  check('a toggle plays the light tick', JSON.stringify(await buzz()) === '[8]', JSON.stringify(await buzz()));

  await page.evaluate(() => document.querySelector('#screen-tonight [data-nav="add"]').click());
  await page.waitForTimeout(400);
  await page.evaluate(() => [...document.querySelectorAll('#screen-add .seg button')].find((b) => b.textContent === 'By hand').click());
  await page.waitForTimeout(200);
  await reset();
  await page.click('#screen-add button[type="submit"]');
  await page.waitForTimeout(200);
  check('a refused form plays error', JSON.stringify(await buzz()).includes('[28,60,28,60,28]'), JSON.stringify(await buzz()));
  await reset();
  await page.fill('#add-title', 'Haptic Test Film');
  await page.click('#screen-add button[type="submit"]');
  await page.waitForTimeout(200);
  check('adding by hand plays success', JSON.stringify(await buzz()) === JSON.stringify([[12, 70, 18]]), JSON.stringify(await buzz()));

  /* The by-hand form refocuses its title field, and a focused field hides the
     tab bar on a phone. */
  await page.evaluate(() => document.activeElement?.blur());
  await page.waitForTimeout(300);

  /* The deck tick as a card crosses the line where letting go decides —
     once per crossing, not once per pixel. */
  await page.click('[data-tab="discover"]');
  await page.waitForTimeout(500);
  await reset();
  const box = await page.evaluate(() => {
    const c = document.querySelector('#screen-discover .deck-card:last-child').getBoundingClientRect();
    return { x: c.x + c.width / 2, y: c.y + c.height / 2 };
  });
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(box.x + i * 10, box.y, { steps: 1 });
  const midDrag = await buzz();
  await page.mouse.move(box.x + 20, box.y, { steps: 3 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  check('dragging past the decision line ticks once', JSON.stringify(midDrag) === '[8]', JSON.stringify(midDrag));
  check('and pulling back and letting go decides nothing', JSON.stringify(await buzz()) === '[8]', JSON.stringify(await buzz()));

  console.log('\n─── off means off ───');
  await page.evaluate(() => document.querySelector('.screen.is-active [data-nav="settings"]')?.click() || document.querySelector('[data-nav="settings"]').click());
  await page.waitForTimeout(500);
  const sw = await page.evaluate(() => {
    const s = document.getElementById('haptics-switch');
    return s ? { checked: s.checked, disabled: s.disabled, native: s.hasAttribute('switch') } : null;
  });
  check('Settings has a Haptics switch, on by default', sw && sw.checked && !sw.disabled && sw.native, JSON.stringify(sw));
  await page.click('label[for="haptics-switch"]');
  await page.waitForTimeout(200);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('wn.state.v3')).settings.haptics);
  check('turning it off is saved', stored === false, String(stored));
  /* A switch is an input, and "an input has focus" used to mean "a keyboard is
     coming" — so tapping this hid the tab bar. */
  const barShown = await page.evaluate(() => !document.body.classList.contains('is-typing') &&
    document.querySelector('.tabbar').getClientRects().length > 0);
  check('and tapping the switch leaves the tab bar where it is', barShown);
  await page.click('[data-tab="discover"]');
  await page.waitForTimeout(500);
  await reset();
  await page.click('#screen-discover [data-action="skip"]');
  await page.waitForTimeout(350);
  check('and nothing plays after that', (await buzz()).length === 0, JSON.stringify(await buzz()));
  const synced = await page.evaluate(async () => {
    const st = await import('./src/store.js');
    return 'haptics' in (st.syncSnapshot().settings || {});
  });
  check('and it is not synced to the other phone', synced === false);
  await ctx.close();

  /* ── iPhone: no vibrate, a native switch to click ── */
  console.log('\n─── the iPhone technique ───');
  const ios = await browser.newContext({ ...devices['iPhone 13 Pro'] });
  await ios.route(block, (r) => r.abort());
  await ios.addInitScript(() => {
    /* What Safari on iOS 18+ looks like to feature detection. */
    delete Navigator.prototype.vibrate;
    Object.defineProperty(HTMLInputElement.prototype, 'switch', {
      configurable: true,
      get() { return this.hasAttribute('switch'); },
      set(v) { this.toggleAttribute('switch', !!v); },
    });
    window.__ticks = 0;
    const click = HTMLElement.prototype.click;
    HTMLElement.prototype.click = function () {
      if (this.tagName === 'LABEL' && this.querySelector('input[switch]')) window.__ticks++;
      return click.call(this);
    };
  });
  const p2 = await ios.newPage();
  p2.on('pageerror', (e) => errors.push(e.message));
  await p2.goto(APP_URL, { waitUntil: 'networkidle' });
  await p2.waitForSelector('body.is-ready');
  await p2.evaluate(() => window.__test.loadSample());
  await p2.waitForTimeout(400);
  await p2.click('[data-tab="discover"]');
  await p2.waitForTimeout(500);
  await p2.evaluate(() => { window.__ticks = 0; });
  await p2.click('#screen-discover [data-action="skip"]');
  await p2.waitForTimeout(350);
  check('a decision clicks the hidden switch', (await p2.evaluate(() => window.__ticks)) === 1, String(await p2.evaluate(() => window.__ticks)));
  const where = await p2.evaluate(() => {
    const l = document.querySelector('head > label');
    const i = l?.querySelector('input');
    return l ? { inHead: true, hidden: l.getAttribute('aria-hidden'), type: i?.type, sw: i?.hasAttribute('switch'), count: document.querySelectorAll('input[switch]').length } : null;
  });
  check('it is one reusable switch, parked in <head>', where && where.inHead && where.type === 'checkbox' && where.sw && where.count === 1, JSON.stringify(where));
  check('and hidden from VoiceOver', where?.hidden === 'true');

  /* The one thing it must never do: take focus from a text field, which on a
     phone would drop the keyboard mid-sentence. */
  await p2.click('[data-tab="ask"]');
  await p2.waitForTimeout(300);
  await p2.evaluate(async () => {
    const st = await import('./src/store.js');
    st.updateSettings({ aiKey: 'sk-ant-test' });
  });
  await p2.click('[data-tab="library"]');
  await p2.waitForTimeout(300);
  await p2.focus('#library-search');
  const kept = await p2.evaluate(async () => {
    const h = await import('./src/haptics.js');
    h.selection();
    h.success();
    await new Promise((r) => setTimeout(r, 300));
    return document.activeElement?.id;
  });
  check('a tick while typing leaves focus in the field', kept === 'library-search', String(kept));

  console.log('\n─── no errors ───');
  check('no JavaScript errors', errors.length === 0, errors.join(' | '));

  await ios.close();
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('\nFailures:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.log('SUITE CRASHED:', e.message); process.exit(1); });

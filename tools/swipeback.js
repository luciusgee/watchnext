/*
 * Swipe back.
 *
 * Real touch events through the DevTools protocol, so the gesture goes
 * through the same touchstart / touchmove / touchend path a finger does.
 */
const { chromium, devices } = require('/opt/node22/lib/node_modules/playwright');

const APP_URL = 'http://127.0.0.1:8899/index.html';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

(async () => {
  /* Chromium's own history swipe would otherwise take any horizontal drag
     that is not cancelled and unload the page. A home-screen app on an
     iPhone has no such gesture; this makes the test browser match. */
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--overscroll-history-navigation=0'],
  });
  const ctx = await browser.newContext({ ...devices['iPhone 13 Pro'] });
  await ctx.route(/image\.tmdb\.org|m\.media-amazon\.com|api\.themoviedb\.org|omdbapi\.com|api\.anthropic\.com|api\.github\.com/, (r) => r.abort());
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const cdp = await ctx.newCDPSession(page);
  await page.goto(APP_URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('body.is-ready');
  await page.evaluate(() => window.__test.loadSample());
  await page.waitForTimeout(400);

  const touch = (type, x, y) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  /* A finger dragged from (x0, y) to (x1, y + drop), in steps, then lifted. */
  const swipe = async (x0, x1, { y = 400, drop = 0, steps = 12, stepMs = 16 } = {}) => {
    await touch('touchStart', x0, y);
    for (let i = 1; i <= steps; i++) {
      await touch('touchMove', x0 + ((x1 - x0) * i) / steps, y + (drop * i) / steps);
      await page.waitForTimeout(stepMs);
    }
    await touch('touchEnd');
    await page.waitForTimeout(450);
  };
  /* A swipe the app is meant to ignore. Chromium runs its own history swipe
     on any drag nobody cancels, and even with the flag above it unloads the
     page — so for these checks the page cancels it itself. What is tested is
     that the app does not react. */
  const ignored = async (x0, x1) => {
    await page.evaluate(() => {
      window.__block = (e) => e.preventDefault();
      document.addEventListener('touchmove', window.__block, { passive: false });
    });
    await swipe(x0, x1);
    await page.evaluate(() => document.removeEventListener('touchmove', window.__block, { passive: false }));
  };
  const active = () => page.evaluate(() => document.querySelector('.screen.is-active')?.id);
  const open = (nav) => page.evaluate((n) => document.querySelector(`.screen.is-active [data-nav="${n}"]`).click(), nav);

  console.log('\n─── from a screen you went into ───');
  await open('settings');
  await page.waitForTimeout(500);
  check('Settings is open', (await active()) === 'screen-settings');
  await swipe(6, 300);
  check('a swipe from the left edge goes back', (await active()) === 'screen-tonight', await active());
  const clean = await page.evaluate(() => {
    const s = [...document.querySelectorAll('.screen')];
    return s.every((n) => !n.style.transform && !n.classList.contains('is-under') && !n.classList.contains('is-swiping'));
  });
  check('and leaves nothing behind — no transforms, no half-shown screen', clean);
  check('and the address says where you are', (await page.evaluate(() => location.hash)) === '#tonight');

  await open('settings');
  await page.waitForTimeout(500);
  /* Mid-swipe: the screen underneath shows through. */
  await touch('touchStart', 6, 400);
  for (let i = 1; i <= 6; i++) { await touch('touchMove', 6 + i * 20, 400); await page.waitForTimeout(16); }
  const mid = await page.evaluate(() => ({
    moved: document.getElementById('screen-settings').style.transform,
    under: document.getElementById('screen-tonight').classList.contains('is-under') &&
      getComputedStyle(document.getElementById('screen-tonight')).display !== 'none',
  }));
  /* Held still, then lifted: not a flick, and not a third of the way. */
  await page.waitForTimeout(200);
  await touch('touchEnd');
  await page.waitForTimeout(450);
  check('mid-swipe the screen follows the finger', /translateX\(1[0-9]{2}/.test(mid.moved), mid.moved);
  check('with the one it returns to showing underneath', mid.under);
  check('a short swipe, held and let go, springs back and stays put', (await active()) === 'screen-settings', await active());
  await touch('touchStart', 6, 400);
  for (let i = 1; i <= 4; i++) { await touch('touchMove', 6 + i * 22, 400); await page.waitForTimeout(8); }
  await touch('touchEnd');
  await page.waitForTimeout(450);
  check('but a quick flick goes back however short', (await active()) === 'screen-tonight', await active());
  await open('settings');
  await page.waitForTimeout(500);

  await swipe(6, 60, { drop: 200, steps: 8 });
  check('a mostly downward drag from the edge is a scroll, not a back', (await active()) === 'screen-settings');
  await ignored(120, 380);
  check('a swipe that starts away from the edge does nothing', (await active()) === 'screen-settings', await active() + ' ' + await page.evaluate(() => location.hash));
  await swipe(6, 300);
  check('then back again', (await active()) === 'screen-tonight');

  console.log('\n─── back through more than one ───');
  await open('settings');
  await page.waitForTimeout(400);
  await page.evaluate(() => (document.querySelector('.screen.is-active [data-nav="add"]') || document.querySelector('[data-nav="add"]'))?.click());
  await page.waitForTimeout(400);
  const deep = await active();
  await swipe(6, 300);
  const one = await active();
  await swipe(6, 300);
  check('each swipe goes back one screen', deep === 'screen-add' && one === 'screen-settings' && (await active()) === 'screen-tonight', `${deep} → ${one} → ${await active()}`);

  console.log('\n─── tabs are where you start ───');
  await page.tap('[data-tab="library"]');
  await page.waitForTimeout(400);
  await ignored(6, 300);
  check('on a tab there is nothing to go back to, so nothing happens', (await active()) === 'screen-library');

  console.log('\n─── a film’s details ───');
  await page.evaluate(async () => {
    const d = await import('./src/screens/detail.js');
    d.openDetail(window.__test.items()[0].uid);
  });
  await page.waitForTimeout(500);
  const detailOpen = await page.evaluate(() => document.getElementById('detail').classList.contains('is-open'));
  check('details are open', detailOpen);
  await swipe(6, 300);
  const closed = await page.evaluate(() => ({
    open: document.getElementById('detail').classList.contains('is-open'),
    transform: document.getElementById('detail').style.transform,
  }));
  check('a swipe from the edge closes them', !closed.open && !closed.transform, JSON.stringify(closed));
  check('back to the screen underneath', (await active()) === 'screen-library');

  console.log('\n─── not under a sheet ───');
  await open('settings').catch(() => {});
  await page.evaluate(() => document.querySelector('[data-nav="settings"]')?.click());
  await page.waitForTimeout(400);
  await page.evaluate(async () => (await import('./src/ui.js')).openSheet({ title: 'x', actions: [] }));
  await page.waitForTimeout(400);
  await ignored(6, 300);
  check('with a sheet open, the edge swipe is left alone', (await active()) === 'screen-settings');
  await page.evaluate(async () => (await import('./src/ui.js')).closeSheet());
  await page.waitForTimeout(300);

  console.log('\n─── no errors ───');
  check('no JavaScript errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('\nFailures:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.log('SUITE CRASHED:', e.message); process.exit(1); });

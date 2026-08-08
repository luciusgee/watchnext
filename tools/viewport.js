/*
 * Shell geometry.
 *
 * The app must fill the screen exactly — no band of dead space under the tab
 * bar, no content hidden behind the notch, and nothing lost behind the
 * on-screen keyboard. iOS standalone with viewport-fit=cover is the case that
 * broke it: `height: 100%` does not reliably resolve to the full screen there,
 * so the tab bar floated above a black gap.
 */
const { chromium, devices } = require('/opt/node22/lib/node_modules/playwright');

let pass = 0, fail = 0; const failures = [];
const check = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ok    ${n}`); }
  else { fail++; failures.push(n + (d ? ` — ${d}` : '')); console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`); }
};

const URL = 'http://127.0.0.1:8899/index.html';
const BLANK = Buffer.from('R0lGODlhAQABAAAAACw=', 'base64');

/* Headless Chromium reports env(safe-area-inset-*) as 0, so the notched-device
   case is simulated by overriding the tokens with the insets a real iPhone
   reports. That is exactly the condition under which the bug appeared. */
const INSETS = `:root { --st: 59px !important; --sb: 34px !important; }`;

async function measure(page) {
  return page.evaluate(() => {
    const app = document.getElementById('app');
    const bar = document.querySelector('.tabbar');
    const a = app.getBoundingClientRect();
    const b = bar.getBoundingClientRect();
    return {
      viewport: { w: innerWidth, h: innerHeight },
      app: { top: Math.round(a.top), bottom: Math.round(a.bottom), height: Math.round(a.height) },
      bar: { top: Math.round(b.top), bottom: Math.round(b.bottom), height: Math.round(b.height) },
      gapBelowBar: Math.round(innerHeight - b.bottom),
      overflowY: document.documentElement.scrollHeight > innerHeight + 1,
    };
  });
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });

  for (const [label, extraCss] of [['no safe-area insets', ''], ['notched device insets', INSETS]]) {
    console.log(`\n─── ${label} ───`);
    const ctx = await browser.newContext({ ...devices['iPhone 13 Pro'] });
    await ctx.route('**://image.tmdb.org/**', (r) => r.fulfill({ status: 200, contentType: 'image/gif', body: BLANK }));
    await ctx.route('**://m.media-amazon.com/**', (r) => r.fulfill({ status: 200, contentType: 'image/gif', body: BLANK }));
    const page = await ctx.newPage();
    page.setDefaultTimeout(15000);
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.waitForSelector('body.is-ready');
    if (extraCss) await page.addStyleTag({ content: extraCss });
    await page.waitForTimeout(400);

    const m = await measure(page);
    check(`[${label}] shell starts at the top of the screen`, m.app.top === 0, `top=${m.app.top}`);
    check(`[${label}] shell reaches the bottom of the screen`, m.app.bottom === m.viewport.h,
      `app bottom=${m.app.bottom}, viewport=${m.viewport.h}`);
    check(`[${label}] shell height equals the viewport`, m.app.height === m.viewport.h,
      `${m.app.height} vs ${m.viewport.h}`);
    check(`[${label}] no dead space under the tab bar`, m.gapBelowBar === 0, `${m.gapBelowBar}px gap`);
    check(`[${label}] page does not scroll behind the shell`, m.overflowY === false);

    /* With a bottom inset the bar must be taller — the padding keeps the labels
       clear of the home indicator rather than the bar floating above it. */
    if (extraCss) {
      check(`[${label}] tab bar absorbs the bottom inset`, m.bar.height >= 56 + 30,
        `bar height=${m.bar.height}`);
    }

    /* Every screen, not just the first — a screen that sizes itself differently
       would show the same gap only on that tab. */
    for (const tab of ['discover', 'library', 'ask']) {
      await page.click(`[data-tab="${tab}"]`);
      await page.waitForTimeout(350);
      const t = await measure(page);
      check(`[${label}] ${tab} fills the screen`, t.app.bottom === t.viewport.h && t.gapBelowBar === 0,
        `bottom=${t.app.bottom}/${t.viewport.h} gap=${t.gapBelowBar}`);
    }

    await ctx.close();
  }

  console.log('\n─── the keyboard does not cover the composer ───');
  const ctx = await browser.newContext({ ...devices['iPhone 13 Pro'] });
  await ctx.route('**://image.tmdb.org/**', (r) => r.fulfill({ status: 200, contentType: 'image/gif', body: BLANK }));
  await ctx.route('**://m.media-amazon.com/**', (r) => r.fulfill({ status: 200, contentType: 'image/gif', body: BLANK }));
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('body.is-ready');
  await page.click('[data-tab="ask"]');
  await page.waitForTimeout(400);

  /* Headless has no keyboard, so drive the same signal iOS sends: shrink the
     visual viewport and dispatch its resize event. */
  const shrunk = await page.evaluate(async () => {
    const KEYBOARD = 300;
    const vv = window.visualViewport;
    if (!vv) return { supported: false };
    /* A keyboard only appears because a field has focus, and that focus is the
       gate the app uses to tell a keyboard from browser chrome. Simulating the
       viewport shrink without it would be testing a state that cannot occur. */
    document.getElementById('ask-input').focus();
    Object.defineProperty(vv, 'height', { get: () => window.innerHeight - KEYBOARD, configurable: true });
    Object.defineProperty(vv, 'offsetTop', { get: () => 0, configurable: true });
    vv.dispatchEvent(new Event('resize'));
    await new Promise((r) => setTimeout(r, 250));
    const kb = getComputedStyle(document.documentElement).getPropertyValue('--kb').trim();
    const composer = document.querySelector('.composer').getBoundingClientRect();
    return { supported: true, kb, composerBottom: Math.round(composer.bottom), visible: window.innerHeight - KEYBOARD };
  });

  if (shrunk.supported) {
    check('the shell reacts to the keyboard', shrunk.kb === '300px', `--kb=${shrunk.kb}`);
    check('the composer stays above the keyboard', shrunk.composerBottom <= shrunk.visible + 1,
      `composer bottom=${shrunk.composerBottom}, visible area ends at ${shrunk.visible}`);
  } else {
    console.log('  (VisualViewport unavailable — skipped)');
  }

  console.log('\n─── browser chrome is not a keyboard ───');
  /* The regression that caused the reported gap: Safari's visual viewport is
     permanently shorter than the layout viewport by the height of the URL bar.
     Measuring that difference unconditionally shrinks the shell by the height
     of the address bar and leaves dead space under the tab bar. */
  const chrome = await page.evaluate(async () => {
    const URL_BAR = 90;
    const vv = window.visualViewport;
    document.activeElement?.blur();
    Object.defineProperty(vv, 'height', { get: () => window.innerHeight - URL_BAR, configurable: true });
    Object.defineProperty(vv, 'offsetTop', { get: () => 0, configurable: true });
    vv.dispatchEvent(new Event('resize'));
    await new Promise((r) => setTimeout(r, 300));
    const app = document.getElementById('app').getBoundingClientRect();
    const bar = document.querySelector('.tabbar').getBoundingClientRect();
    return {
      kb: getComputedStyle(document.documentElement).getPropertyValue('--kb').trim(),
      shellBottom: Math.round(app.bottom),
      gapBelowBar: Math.round(window.innerHeight - bar.bottom),
      viewportH: window.innerHeight,
    };
  });
  check('a URL bar sized shrink is ignored with nothing focused', chrome.kb === '0px', `--kb=${chrome.kb}`);
  check('the shell still reaches the bottom with browser chrome showing',
    chrome.shellBottom === chrome.viewportH, `${chrome.shellBottom}/${chrome.viewportH}`);
  check('no dead space under the tab bar with browser chrome showing',
    chrome.gapBelowBar === 0, `${chrome.gapBelowBar}px gap`);

  /* And a small shrink while a field IS focused is still browser chrome, not a
     keyboard — no phone keyboard is 90px tall. */
  const smallWhileFocused = await page.evaluate(async () => {
    document.getElementById('ask-input').focus();
    window.visualViewport.dispatchEvent(new Event('resize'));
    await new Promise((r) => setTimeout(r, 300));
    return getComputedStyle(document.documentElement).getPropertyValue('--kb').trim();
  });
  check('a 90px shrink is not treated as a keyboard even when focused',
    smallWhileFocused === '0px', `--kb=${smallWhileFocused}`);

  await ctx.close();
  console.log(`\n══════════  ${pass} passed, ${fail} failed  ══════════`);
  if (failures.length) { console.log('\nFailures:'); failures.forEach((f) => console.log('  · ' + f)); }
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASHED:', e.message, '\n', e.stack); process.exit(2); });

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

  /*
   * iOS shrinks a home-screen web app's viewport by the status bar height the
   * first time a keyboard opens and never restores it — innerHeight drops from
   * 932 to 873 and stays there, leaving a dead band under the tab bar. The only
   * known cure is to blank a full-height element so WebKit re-measures.
   *
   * Simulated faithfully: innerHeight reports the shrunk value until the shell
   * is actually flipped to display:none, then reports the true one. Nothing
   * here is a test-only branch in app code — the app sees ordinary DOM.
   */
  const REAL = 932, SHRUNK = 873;

  const standaloneCtx = async (healable) => {
    const c = await browser.newContext({ ...devices['iPhone 13 Pro'] });
    await c.route('**://image.tmdb.org/**', (r) => r.fulfill({ status: 200, contentType: 'image/gif', body: BLANK }));
    await c.route('**://m.media-amazon.com/**', (r) => r.fulfill({ status: 200, contentType: 'image/gif', body: BLANK }));
    const p = await c.newPage();
    await p.addInitScript(
      ([real, shrunk, canHeal]) => {
        Object.defineProperty(navigator, 'standalone', { get: () => true, configurable: true });
        window.__flips = 0;
        window.__healed = false;
        Object.defineProperty(window.screen, 'height', { get: () => real, configurable: true });
        Object.defineProperty(window, 'innerHeight', {
          get: () => (window.__healed ? real : shrunk),
          configurable: true,
        });
        document.addEventListener('DOMContentLoaded', () => {
          const app = document.getElementById('app');
          /* The shell is blanked and restored inside one task, so by the time an
             observer callback runs the style is already back. The restore is
             what identifies a completed flip — match on the value it came FROM,
             not the value it currently has. */
          new MutationObserver((records) => {
            for (const r of records) {
              if ((r.oldValue || '').includes('display: none')) {
                window.__flips++;
                if (canHeal) window.__healed = true;
                break;
              }
            }
          }).observe(app, { attributes: true, attributeFilter: ['style'], attributeOldValue: true });
        });
      },
      [REAL, SHRUNK, healable]
    );
    await p.goto(URL, { waitUntil: 'networkidle' });
    await p.waitForSelector('body.is-ready');
    return { c, p };
  };

  console.log('\n─── recovering from the iOS keyboard viewport shrink ───');
  {
    const { c, p } = await standaloneCtx(true);
    await p.waitForTimeout(1200); // the startup heal runs at 400ms

    /* Only the *reported* height can be faked here — Chromium's real layout
       viewport stays 390x664 — so the shell's own rect is not meaningful in
       this section. That the shell fills whatever viewport it is handed is
       already asserted against real geometry further up. What matters here is
       the number the app reasons from: does the withheld space reach zero. */
    const after = await p.evaluate(() => ({
      flips: window.__flips,
      innerHeight: window.innerHeight,
      withheld: window.screen.height - window.innerHeight,
    }));
    check('a viewport that boots short is healed', after.flips >= 1, `${after.flips} flips`);
    check('the viewport is restored to the full screen', after.innerHeight === REAL, `${after.innerHeight}`);
    check('no screen height is left withheld', after.withheld === 0, `${after.withheld}pt`);

    /* Healing must not cost the user their place in a 500-title list. */
    await p.click('[data-tab="library"]');
    await p.waitForTimeout(400);
    const scrolled = await p.evaluate(async () => {
      const s = document.querySelector('#screen-library .scroll');
      s.scrollTop = 600;
      await new Promise((r) => setTimeout(r, 60));
      window.__healed = false; // shrink again
      document.dispatchEvent(new Event('focusout'));
      await new Promise((r) => setTimeout(r, 700));
      return { top: Math.round(s.scrollTop), healed: window.__healed };
    });
    check('healing preserves scroll position', scrolled.top === 600, `scrollTop=${scrolled.top}`);
    check('a later shrink is healed too', scrolled.healed === true);

    console.log('\n─── it does not fight a keyboard that is genuinely open ───');
    const withFocus = await p.evaluate(async () => {
      document.querySelector('[data-tab="ask"]').click();
      await new Promise((r) => setTimeout(r, 300));
      const before = window.__flips;
      window.__healed = false; // viewport shrinks, as it legitimately does
      document.getElementById('ask-input').focus();
      document.dispatchEvent(new Event('focusout')); // fires while the field still holds focus
      await new Promise((r) => setTimeout(r, 600));
      return { flipsAdded: window.__flips - before };
    });
    check('no heal while a text field holds focus', withFocus.flipsAdded === 0, `${withFocus.flipsAdded} flips`);

    await c.close();
  }

  console.log('\n─── it gives up rather than flickering forever ───');
  {
    /* If a future iOS shrinks the viewport for a reason the flip cannot fix,
       blanking the app on every keyboard dismissal would be worse than the bug. */
    const { c, p } = await standaloneCtx(false);
    await p.waitForTimeout(1000);
    const flips = await p.evaluate(async () => {
      for (let i = 0; i < 4; i++) {
        document.dispatchEvent(new Event('focusout'));
        await new Promise((r) => setTimeout(r, 400));
      }
      return window.__flips;
    });
    /* Three, not two: WebKit does not always report the restored height on the
       next frame, so a heal that worked can look like a failure. The budget has
       to tolerate that without switching itself off for the session — but it
       still has to be bounded, or a device this cannot fix gets its whole UI
       blinked on every keyboard dismissal. */
    check('stops after three ineffective attempts', flips <= 3, `${flips} flips`);
    await c.close();
  }

  console.log('\n─── the app cannot be zoomed ───');
  {
    const c = await browser.newContext({ ...devices['iPhone 13 Pro'] });
    await c.route('**://image.tmdb.org/**', (r) => r.fulfill({ status: 200, contentType: 'image/gif', body: BLANK }));
    await c.route('**://m.media-amazon.com/**', (r) => r.fulfill({ status: 200, contentType: 'image/gif', body: BLANK }));
    const p = await c.newPage();
    await p.goto(URL, { waitUntil: 'networkidle' });
    await p.waitForSelector('body.is-ready');

    /* The one that actually bites: iOS zooms the whole page when a field under
       16px takes focus. Every field has to clear it, on every screen, so this
       walks the real rendered DOM rather than trusting the stylesheet. */
    for (const tab of ['tonight', 'discover', 'library', 'ask']) {
      await p.click(`[data-tab="${tab}"]`);
      await p.waitForTimeout(250);
    }
    await p.click('[data-tab="tonight"]');
    await p.waitForTimeout(200);
    await p.click('#screen-tonight [data-nav="settings"]');
    await p.waitForTimeout(600);

    const fields = await p.evaluate(() =>
      [...document.querySelectorAll('input, textarea, select')]
        /* Only controls that can actually summon a keyboard can trigger the
           auto-zoom. A file picker or a checkbox cannot, and neither can
           anything that is not rendered. */
        .filter(
          (n) =>
            !['checkbox', 'radio', 'button', 'submit', 'hidden', 'file', 'range', 'color'].includes(
              n.type
            ) && n.offsetParent !== null
        )
        .map((n) => ({
          id: n.id || n.className || n.tagName,
          size: parseFloat(getComputedStyle(n).fontSize),
        }))
    );
    const tooSmall = fields.filter((f) => f.size < 16);
    check('at least one real text field was inspected', fields.length > 0, `${fields.length} fields`);
    check(
      'no focusable field is under the 16px iOS auto-zoom threshold',
      tooSmall.length === 0,
      tooSmall.map((f) => `${f.id}=${f.size}px`).join(', ')
    );

    const gestures = await p.evaluate(() => {
      const out = {};
      for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
        const ev = new Event(type, { bubbles: true, cancelable: true });
        document.dispatchEvent(ev);
        out[type] = ev.defaultPrevented;
      }
      return out;
    });
    check('pinch zoom start is cancelled', gestures.gesturestart === true);
    check('pinch zoom movement is cancelled', gestures.gesturechange === true);
    check('pinch zoom end is cancelled', gestures.gestureend === true);

    const touch = await p.evaluate(() => ({
      body: getComputedStyle(document.body).touchAction,
      /* The Discover deck must keep its own value or the swipe breaks. */
      deck: (() => {
        const card = document.querySelector('.deck-card');
        return card ? getComputedStyle(card).touchAction : null;
      })(),
      scrollable: (() => {
        const s = document.querySelector('.screen.is-active .scroll');
        return s ? getComputedStyle(s).overflowY : null;
      })(),
    }));
    check('double-tap zoom is disabled on the body', touch.body === 'manipulation', touch.body);
    check('scrolling is left alone', touch.scrollable === 'auto', String(touch.scrollable));

    await p.click('[data-tab="discover"]');
    await p.waitForTimeout(400);
    const deck = await p.evaluate(() => {
      const card = document.querySelector('.deck-card');
      return card ? getComputedStyle(card).touchAction : 'no card';
    });
    check('the Discover swipe deck keeps its own touch handling', deck === 'none', deck);

    await c.close();
  }

  console.log(`\n══════════  ${pass} passed, ${fail} failed  ══════════`);
  if (failures.length) { console.log('\nFailures:'); failures.forEach((f) => console.log('  · ' + f)); }
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASHED:', e.message, '\n', e.stack); process.exit(2); });

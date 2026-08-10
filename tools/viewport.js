/*
 * Shell geometry.
 *
 * The app must fill the screen exactly — no band of dead space under the tab
 * bar, no content hidden behind the notch, nothing lost behind the on-screen
 * keyboard, and no labels under the home indicator. A home-screen web app on
 * iOS is the case that breaks all four: `height: 100%` does not reliably
 * resolve to the full screen there, so the tab bar floated above a black gap.
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
    const bar = document.querySelector('.tabbar');
    return {
      supported: true,
      kb,
      composerBottom: Math.round(composer.bottom),
      visible: window.innerHeight - KEYBOARD,
      barShown: bar.getClientRects().length > 0,
    };
  });

  if (shrunk.supported) {
    check('the shell reacts to the keyboard', shrunk.kb === '300px', `--kb=${shrunk.kb}`);
    check('the composer stays above the keyboard', shrunk.composerBottom <= shrunk.visible + 1,
      `composer bottom=${shrunk.composerBottom}, visible area ends at ${shrunk.visible}`);
    /* Reported from the phone: the tab bar rode up and sat on top of the
       keyboard. Nothing on iOS does that — the bar goes away while you type,
       both because it is not tappable in any useful sense mid-sentence and
       because those 56pt are most of what is left of the screen. */
    check('the tab bar is out of the way while typing', !shrunk.barShown);

    /* The composer takes the space the bar gave up, rather than the app leaving
       a band of nothing between the text field and the keyboard. */
    const flush = await page.evaluate(() => {
      const app = document.getElementById('app').getBoundingClientRect();
      const composer = document.querySelector('.composer').getBoundingClientRect();
      return Math.round(app.bottom - composer.bottom);
    });
    check('and the composer sits against the keyboard', flush <= 1, `${flush}px of dead space`);

    const after = await page.evaluate(async () => {
      document.activeElement?.blur();
      await new Promise((r) => setTimeout(r, 400));
      const bar = document.querySelector('.tabbar');
      return {
        shown: bar.getClientRects().length > 0,
        kb: getComputedStyle(document.documentElement).getPropertyValue('--kb').trim(),
        barBottom: Math.round(bar.getBoundingClientRect().bottom),
        viewportH: window.innerHeight,
      };
    });
    check('and it comes back when the keyboard goes', after.shown, `--kb=${after.kb}`);
    check('back at the bottom, where it was', after.barBottom === after.viewportH,
      `${after.barBottom}/${after.viewportH}`);

    /* And it goes on focus, not on the measurement. iOS reports the viewport
       shrinking all the way through its keyboard animation, so a bar that waits
       for 150px of it visibly rides the keyboard up first — which is the
       original complaint, still there, with a vanishing act on the end. This is
       the first frame after focus and before any viewport change at all. */
    const onFocusAlone = await page.evaluate(async () => {
      const vv = window.visualViewport;
      document.activeElement?.blur();
      Object.defineProperty(vv, 'height', { get: () => window.innerHeight, configurable: true });
      vv.dispatchEvent(new Event('resize'));
      await new Promise((r) => setTimeout(r, 200));
      const before = document.querySelector('.tabbar').getClientRects().length > 0;
      document.getElementById('ask-input').focus();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return { before, after: document.querySelector('.tabbar').getClientRects().length > 0 };
    });
    check('the bar is there before the field is touched', onFocusAlone.before);
    check('and gone by the frame after focus, before the keyboard has moved',
      !onFocusAlone.after);
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
      barShown: document.querySelector('.tabbar').getClientRects().length > 0,
    };
  });
  check('a URL bar sized shrink is ignored with nothing focused', chrome.kb === '0px', `--kb=${chrome.kb}`);
  /* Hiding the bar is keyed off the same signal, so it must not fire here —
     losing the navigation for the whole session in Safari would be worse than
     the gap this test was originally written for. */
  check('and the tab bar is not hidden by browser chrome', chrome.barShown);
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

  /* Focus hides the bar because on a phone a focused field means a keyboard is
     coming. With a mouse and a real keyboard nothing is coming, and whipping the
     navigation away the moment someone clicks a search box would be gratuitous. */
  {
    const c = await browser.newContext({ viewport: { width: 1280, height: 900 }, hasTouch: false });
    await c.route('**://image.tmdb.org/**', (r) => r.fulfill({ status: 200, contentType: 'image/gif', body: BLANK }));
    await c.route('**://m.media-amazon.com/**', (r) => r.fulfill({ status: 200, contentType: 'image/gif', body: BLANK }));
    const p = await c.newPage();
    await p.goto(URL, { waitUntil: 'networkidle' });
    await p.waitForSelector('body.is-ready');
    await p.click('[data-tab="ask"]');
    await p.waitForTimeout(400);
    const shown = await p.evaluate(async () => {
      document.getElementById('ask-input').focus();
      await new Promise((r) => setTimeout(r, 250));
      return document.querySelector('.tabbar').getClientRects().length > 0;
    });
    check('with a real pointer, focus alone leaves the bar alone', shown);
    await c.close();
  }

  /*
   * iOS shrinks a home-screen web app's viewport by the status bar height the
   * first time a keyboard opens and never restores it — innerHeight drops from
   * 932 to 873 and stays there, leaving a dead band under the tab bar. The only
   * known cure is to blank a full-height element so WebKit re-measures.
   *
   * Note what this is NOT: a viewport that is already short at boot. That looks
   * identical in every measurement and is a different fault — iOS 26 simply
   * hands a home-screen app less than the screen — and blanking the shell does
   * not recover a pixel of it (measured 0/3 on the device). The app tells them
   * apart by when the shortfall appears, so the simulation has to as well: this
   * one boots at full height and shrinks later, which is the only case the heal
   * is for. An earlier version of this file booted short, so it was testing the
   * mechanism against the fault it cannot fix.
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
        /* Full height until something shrinks it, exactly as the device does. */
        window.__shrunk = false;
        Object.defineProperty(window, 'innerHeight', {
          get: () => (window.__shrunk && !window.__healed ? shrunk : real),
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
    /* The heal tests need a library: something to scroll, and a card in the
       Discover deck. The starter set is opt-in now, so ask for it. */
    await p.evaluate(() => window.__test?.loadSample());
    await p.waitForTimeout(500);
    return { c, p };
  };

  console.log('\n─── recovering from the iOS keyboard viewport shrink ───');
  {
    const { c, p } = await standaloneCtx(true);
    await p.waitForTimeout(1200);

    /* Nothing has gone wrong yet, so nothing should have happened. The heal
       blanks the entire UI for a frame; doing that speculatively at every
       launch is exactly the cost this is not allowed to impose. */
    const quiet = await p.evaluate(() => window.__flips);
    check('nothing is blanked while the viewport is the right size', quiet === 0, `${quiet} flips`);

    /* Now the fault: the keyboard opens, closes, and iOS keeps the space.
       Only the *reported* height can be faked here — Chromium's real layout
       viewport stays 390x664 — so the shell's own rect is not meaningful in
       this section. That the shell fills whatever viewport it is handed is
       already asserted against real geometry further up. What matters here is
       the number the app reasons from: does the withheld space reach zero. */
    const after = await p.evaluate(async () => {
      window.__shrunk = true;
      document.dispatchEvent(new Event('focusout'));
      await new Promise((r) => setTimeout(r, 700));
      return {
        flips: window.__flips,
        innerHeight: window.innerHeight,
        withheld: window.screen.height - window.innerHeight,
      };
    });
    check('a viewport the keyboard shrank is healed', after.flips >= 1, `${after.flips} flips`);
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
      window.__shrunk = true; // and this one never comes back
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

  /*
   * iOS 26 hands a home-screen web app a viewport of screen-height minus the
   * status bar inset — 873 on a 932pt phone — and that 59pt is genuinely
   * outside the web view.
   *
   * A build tried to reclaim it by growing the shell, on the theory that both
   * safe-area insets being non-zero proved the frame reached the bottom of the
   * screen. It does not prove that: iOS reports insets from the screen's
   * geometry, not the view's. The extra was clipped and took the tab bar's
   * labels off screen with it — icons still visible, text gone.
   *
   * So the assertion is the invariant that broke, not the theory that broke it:
   * whatever the viewport turns out to be, the shell and the tab bar stay
   * inside it.
   */
  console.log('\n─── a short viewport is reported, never overrun ───');

  const ios26 = async ({ screenH = 932, viewportH = 873, top = 59, bottom = 34, standalone = true } = {}) => {
    const c = await browser.newContext({ ...devices['iPhone 13 Pro'] });
    await c.route('**://image.tmdb.org/**', (r) => r.fulfill({ status: 200, contentType: 'image/gif', body: BLANK }));
    await c.route('**://m.media-amazon.com/**', (r) => r.fulfill({ status: 200, contentType: 'image/gif', body: BLANK }));
    const p = await c.newPage();
    await p.addInitScript(
      ([sh, vh, t, b, sa]) => {
        if (sa) Object.defineProperty(navigator, 'standalone', { get: () => true, configurable: true });
        Object.defineProperty(window.screen, 'height', { get: () => sh, configurable: true });
        Object.defineProperty(window, 'innerHeight', { get: () => vh, configurable: true });
        /* Count blank-and-reflow attempts the same way standaloneCtx does. This
           was missing, so `flips` read 0 whether or not the heal ran and the
           assertion below could not fail — which is how a change that switched
           the heal back on shipped, and had to be caught off a diagnostics line
           from the phone instead. */
        window.__flips = 0;
        /* env() cannot be overridden, so insets are substituted through the
           --st/--sb tokens the app already resolves them with. */
        document.addEventListener('DOMContentLoaded', () => {
          const st = document.createElement('style');
          st.textContent = `:root{--st:${t}px !important;--sb:${b}px !important}`;
          document.head.appendChild(st);
          const app = document.getElementById('app');
          new MutationObserver((records) => {
            for (const r of records) {
              if ((r.oldValue || '').includes('display: none')) {
                window.__flips++;
                break;
              }
            }
          }).observe(app, { attributes: true, attributeFilter: ['style'], attributeOldValue: true });
        });
      },
      [screenH, viewportH, top, bottom, standalone]
    );
    await p.goto(URL, { waitUntil: 'networkidle' });
    await p.waitForSelector('body.is-ready');
    await p.waitForTimeout(300);
    return { c, p };
  };

  {
    const { c, p } = await ios26();
    const m = await p.evaluate(() => {
      const app = document.getElementById('app');
      const bar = document.querySelector('.tabbar');
      /* The real layout viewport — only the *reported* number can be faked. */
      const view = document.documentElement.clientHeight;
      return {
        shell: Math.round(app.getBoundingClientRect().height),
        barBottom: Math.round(bar.getBoundingClientRect().bottom),
        view,
        labels: [...bar.querySelectorAll('.tab')].map((t) => ({
          text: t.innerText.trim(),
          bottom: Math.round(t.getBoundingClientRect().bottom),
        })),
        flips: window.__flips || 0,
      };
    });

    check('the shell never exceeds the viewport it was given', m.shell <= m.view, `${m.shell} > ${m.view}`);
    check('the tab bar stays inside the viewport', m.barBottom <= m.view, `bar bottom ${m.barBottom} > ${m.view}`);
    check('every tab still has its label', m.labels.every((l) => l.text.length > 0),
      JSON.stringify(m.labels.map((l) => l.text)));
    /* The symptom that made the regression obvious on the device: icons on
       screen, labels below the fold. */
    check('no label is pushed past the bottom of the viewport',
      m.labels.every((l) => l.bottom <= m.view), JSON.stringify(m.labels));
    check('the blank-and-reflow fallback does not run for this fault',
      m.flips === 0, `${m.flips} flips`);

    const reported = await p.evaluate(async () => {
      const { healState } = await import('./src/viewport.js');
      return healState().shortfall;
    });
    check('the shortfall is measured so Settings can report it', reported === 59, String(reported));

    await c.close();
  }

  /* The shipped configuration, which the case above does not cover: the app does
     not ask for viewport-fit=cover, so BOTH insets report 0. An earlier guard
     compared the shortfall against the top inset to confirm it was status-bar
     sized, which made it undetectable once the insets went to 0 — and an
     undetected shortfall is what re-enables the heal, so the app blinked itself
     three times at every launch to fix something it cannot fix. */
  {
    const { c, p } = await ios26({ top: 0, bottom: 0 });
    /* Past the last of the heal's retries at 400/1200/2500ms. */
    await p.waitForTimeout(3000);
    const m = await p.evaluate(async () => ({
      shortfall: (await import('./src/viewport.js')).healState().shortfall,
      flips: window.__flips || 0,
    }));
    check('the shortfall is still measured with no insets to compare it against',
      m.shortfall === 59, String(m.shortfall));
    check('so the heal that was measured not to work never starts',
      m.flips === 0, `${m.flips} flips`);
    await c.close();
  }

  console.log('\n─── and is not claimed where it does not apply ───');

  for (const [label, opts] of [
    ['a viewport that measures correctly', { viewportH: 932 }],
    ['in-browser rather than home screen', { standalone: false }],
    ['a shortfall far too large to be the status bar', { viewportH: 800 }],
  ]) {
    const { c, p } = await ios26(opts);
    const reported = await p.evaluate(async () => {
      const { healState } = await import('./src/viewport.js');
      return healState().shortfall;
    });
    check(`not reported: ${label}`, !reported, `shortfall=${reported}`);
    await c.close();
  }

  /*
   * The app stays inside the safe area, and that is not the modern default.
   *
   * viewport-fit=cover asks iOS for the whole screen and is the obvious choice;
   * on iOS 26 it hands back a viewport 59pt shorter than the screen with nothing
   * painted in the gap. Without it the viewport IS the safe area, the insets all
   * report 0, and WebKit fills the outside with the page background — so the app
   * reads as edge to edge without ever being given those pixels.
   *
   * It was a user-facing toggle for a build or two. The mechanism was the whole
   * problem: iOS reads this meta once, at load, so a switch had to write a key
   * and reload, that key drifted out of step with the copy in the saved state,
   * and the app came up on the wrong fit with the switch showing the right one.
   * Now it is a constant, which is why this asserts the shipped markup rather
   * than any behaviour — the failure mode is somebody adding viewport-fit=cover
   * back because it looks like an oversight.
   */
  console.log('\n─── the app stays inside the safe area ───');
  {
    const c = await browser.newContext({ ...devices['iPhone 13 Pro'] });
    await c.route('**://image.tmdb.org/**', (r) => r.fulfill({ status: 200, contentType: 'image/gif', body: BLANK }));
    await c.route('**://m.media-amazon.com/**', (r) => r.fulfill({ status: 200, contentType: 'image/gif', body: BLANK }));
    const p = await c.newPage();
    await p.goto(URL, { waitUntil: 'networkidle' });
    await p.waitForSelector('body.is-ready');

    const meta = await p.evaluate(() =>
      document.querySelector('meta[name="viewport"]').getAttribute('content')
    );
    check('the shipped viewport meta does not ask for the whole screen',
      !/viewport-fit/.test(meta), meta);
    check('and is otherwise a normal responsive viewport',
      /width=device-width/.test(meta) && /initial-scale=1/.test(meta), meta);

    /* Nothing may rewrite it at runtime either — that was the cosmetic version
       of the setting, which appeared to work and did not. */
    await p.click('[data-tab="tonight"]');
    await p.waitForTimeout(200);
    await p.click('#screen-tonight [data-nav="settings"]');
    await p.waitForTimeout(600);
    const after = await p.evaluate(() =>
      document.querySelector('meta[name="viewport"]').getAttribute('content')
    );
    check('and nothing rewrites it once the app is running', after === meta, `${meta} -> ${after}`);

    /* The retired keys are cleaned off any device that saw the toggle. */
    check('the keys behind the retired setting are cleared',
      (await p.evaluate(() => [localStorage.getItem('wn.fit'), localStorage.getItem('wn.fit.checked')]))
        .every((v) => v === null));

    const fits = await p.evaluate(() => {
      const app = document.getElementById('app').getBoundingClientRect();
      const bar = document.querySelector('.tabbar').getBoundingClientRect();
      const view = document.documentElement.clientHeight;
      return { shell: Math.round(app.height), barBottom: Math.round(bar.bottom), view };
    });
    check('the shell fills the viewport this produces', fits.shell === fits.view,
      `${fits.shell} vs ${fits.view}`);
    check('and the tab bar is inside it', fits.barBottom <= fits.view,
      `${fits.barBottom} > ${fits.view}`);

    await c.close();
  }

  /*
   * The home indicator, in safe-area mode.
   *
   * Inside the safe area — where this app lives — iOS reports a bottom inset of
   * 0, on the basis that the viewport already excludes the indicator, and then
   * draws the pill over the bottom of the web view anyway, straight across the
   * tab bar's labels. So the floor has to apply exactly where there is something
   * to clear and nowhere else, or a phone with a physical home button gets a
   * band of dead space under the bar for no reason.
   */
  console.log('\n─── the tab bar clears the home indicator ───');

  for (const [label, opts, expected] of [
    ['a home-screen app on a phone with a home indicator', { bottom: 0 }, 20],
    ['in the browser, where the bar is not the bottom of the screen', { bottom: 0, standalone: false }, 0],
    ['a phone with no furniture to clear', { bottom: 0, screenH: 873 }, 0],
  ]) {
    const { c, p } = await ios26(opts);
    const m = await p.evaluate(() => {
      const bar = document.querySelector('.tabbar');
      const text = bar.querySelector('.tab span');
      return {
        floor: getComputedStyle(document.documentElement).getPropertyValue('--sb-floor').trim(),
        pad: Math.round(parseFloat(getComputedStyle(bar).paddingBottom) || 0),
        clearance: Math.round(bar.getBoundingClientRect().bottom - text.getBoundingClientRect().bottom),
      };
    });
    check(`${expected}px of clearance: ${label}`, m.pad === expected,
      `--sb-floor ${m.floor || 'unset'}, padding ${m.pad}px`);
    if (expected) {
      check('and the labels sit above it rather than under the pill',
        m.clearance >= expected, `${m.clearance}px`);
    }
    await c.close();
  }

  /* Anything anchored above the tab bar has to be offset by how tall the bar
     really is, floor included. The toast was offset by --sb alone, which is 0
     on this app, so it sat exactly the height of the floor inside the bar. */
  {
    const { c, p } = await ios26({ bottom: 0 });
    const m = await p.evaluate(async () => {
      const { toast } = await import('./src/ui.js');
      toast('Checking clearance');
      await new Promise((r) => setTimeout(r, 350));
      const t = document.querySelector('.toast').getBoundingClientRect();
      const bar = document.querySelector('.tabbar').getBoundingClientRect();
      return { overlap: Math.round(t.bottom - bar.top) };
    });
    check('a toast clears the tab bar rather than tucking behind it',
      m.overlap <= 0, `overlaps by ${m.overlap}px`);
    await c.close();
  }

  /* A platform that reports a real bottom inset must use that instead of adding
     the floor to it — stacking would push the bar up by the pill twice. iOS does
     not report one here, but the CSS is written not to care, and the rule is
     cheap to hold to. */
  {
    const { c, p } = await ios26({ bottom: 34 });
    const pad = await p.evaluate(() =>
      Math.round(parseFloat(getComputedStyle(document.querySelector('.tabbar')).paddingBottom) || 0)
    );
    check('edge to edge uses its real inset, not inset plus floor', pad === 34, `${pad}px`);
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
    /* Needs a deck card to check the swipe surface keeps its own touch-action. */
    await p.evaluate(() => window.__test?.loadSample());
    await p.waitForTimeout(500);

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

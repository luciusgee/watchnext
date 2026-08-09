/*
 * Shell geometry.
 *
 * Two separate problems live here, and conflating them is what made the screen
 * fit so hard to pin down:
 *
 *   1. The keyboard genuinely covers the bottom of the screen while it is open,
 *      and the shell has to move out of its way.
 *   2. iOS permanently shrinks the viewport of a home-screen web app the first
 *      time that keyboard appears, and never gives the space back.
 *
 * The first is a live measurement. The second is a bug to be undone. They look
 * identical from a resize event — both shrink the viewport — and the only thing
 * that tells them apart is whether a text field currently holds focus.
 *
 * Its own module because both main.js (which drives it) and settings.js (which
 * reports it) need it, and importing one screen from another would be circular.
 */

/* Observable state, purely so Settings can show whether this ran and whether it
   worked. Diagnosing this from a screenshot without it took several wrong
   guesses. */
const state = {
  standalone: false,
  attempts: 0,
  recovered: 0,
  gaveUp: false,
  tallest: 0,
  shortfall: 0,
  fit: 'cover',
};

/**
 * env() inside a custom property is not resolved by getPropertyValue on every
 * engine, so the insets are measured off a real element rather than read as
 * text. Applied through the --st/--sb tokens rather than raw env(): the tokens
 * are defined as env() so the value is identical on a device, and going through
 * them means a test can substitute known insets, which raw env() does not allow.
 */
export function safeAreaInsets() {
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:absolute;visibility:hidden;pointer-events:none;top:0;left:0;' +
    'padding-top:var(--st,0px);padding-bottom:var(--sb,0px)';
  document.body.appendChild(probe);
  const s = getComputedStyle(probe);
  const insets = {
    top: Math.round(parseFloat(s.paddingTop) || 0),
    bottom: Math.round(parseFloat(s.paddingBottom) || 0),
  };
  probe.remove();
  return insets;
}

/**
 * Choose how the page relates to the phone's safe areas.
 *
 * `viewport-fit=cover` asks for the whole screen — the page runs under the
 * status bar and home indicator, and env(safe-area-inset-*) reports real
 * numbers so padding can keep content clear of them. That is the modern
 * answer, and on iOS 26 it is also how you end up with a viewport 59pt shorter
 * than the screen and nothing painted in the gap.
 *
 * `viewport-fit=auto` is the older behaviour: the viewport IS the safe area,
 * the insets all report 0, and WebKit fills the area outside with the page's
 * own background — so the app reads as edge-to-edge without ever being handed
 * those pixels. Less capable, frequently better looking.
 *
 * Which one wins depends on the phone and the iOS version, and no amount of
 * reasoning from here settles it, so it is a setting.
 *
 * It takes effect at load, not on write. Rewriting the meta on a live page
 * does NOT make iOS recompute — it goes on reporting the same viewport and
 * the same insets, so the setting looks applied and changes nothing. The
 * value is mirrored to its own small key that an inline script in the head
 * reads before first layout; this function only records what is in force.
 */
const FIT_KEY = 'wn.fit';

export function persistScreenFit(fit) {
  const value = fit === 'safe' ? 'safe' : 'cover';
  try {
    localStorage.setItem(FIT_KEY, value);
  } catch {
    /* storage unavailable: the setting simply will not survive a relaunch */
  }
  return value;
}

/** What the head script actually applied, read back off the meta. */
export function activeScreenFit() {
  const meta = document.querySelector('meta[name="viewport"]');
  const applied = /viewport-fit=cover/.test(meta?.getAttribute('content') || '') ? 'cover' : 'safe';
  state.fit = applied;
  return applied;
}

/**
 * Keep the tab bar clear of the home indicator.
 *
 * Inside the safe area, iOS reports a bottom inset of 0 — the viewport is
 * supposed to already exclude it — but it still draws the home indicator over
 * the bottom of the web view, so the tab labels come out underneath the pill.
 * Edge-to-edge does not need this: there --sb is the real inset and the bar's
 * own padding already handles it.
 *
 * Applied only where there is something to clear. A screen taller than the
 * viewport in a home-screen web app means iOS is holding back space for its
 * own furniture; a phone with a physical home button reports the two as equal
 * and gets no padding it does not need.
 */
export function applyHomeIndicatorFloor() {
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const hasFurniture = screen.height > window.innerHeight;
  /* Enough to clear the pill (~5pt tall, ~8pt up) with room to breathe, without
     reserving the full 34pt inset for a bar that does not need it. */
  const floor = standalone && hasFurniture ? '20px' : '0px';
  document.documentElement.style.setProperty('--sb-floor', floor);
  return floor;
}

/**
 * Record how much of the screen iOS is not giving us. Measurement only.
 *
 * In a home-screen web app on iOS 26 the layout viewport is the screen height
 * minus the status bar inset — 873 on a 932pt phone. That 59pt is genuinely
 * outside the web view: a build that grew the shell by the shortfall had the
 * extra clipped, taking the tab bar's labels off screen with it.
 *
 * Note the trap, because it is convincing: BOTH safe area insets come back
 * non-zero, and a non-zero bottom inset looks like proof that the view reaches
 * the bottom of the screen. It is not — iOS reports insets from the screen's
 * geometry, not the view's. Nothing here should act on that reading.
 *
 * Kept because the number is worth showing in Settings: it is the difference
 * between "the app is laid out wrong" and "iOS handed us a shorter screen",
 * and telling those apart from a screenshot cost several wrong guesses.
 */
export function measureShortfall() {
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  state.standalone = standalone;
  if (!standalone) return 0;

  const shortfall = screen.height - window.innerHeight;
  const { top } = safeAreaInsets();

  /* Only the status-bar-sized shortfall is the known iOS 26 behaviour. Anything
     else is a different problem and should not be labelled as this one. */
  if (shortfall <= 0 || top <= 0 || Math.abs(shortfall - top) > 1) return 0;

  state.shortfall = shortfall;
  return shortfall;
}

export function healState() {
  return { ...state };
}

/**
 * Stop the app being zoomed.
 *
 * Three separate gestures, and only two of them are worth blocking here:
 *
 *   · double-tap zoom — handled in CSS with `touch-action: manipulation`.
 *   · pinch zoom — blocked below. `user-scalable=no` in the viewport meta is
 *     the obvious route and iOS Safari has ignored it since iOS 10, precisely
 *     so that pages cannot do this. WebKit's non-standard `gesture*` events are
 *     what actually work, and unlike a touchmove handler they cost nothing on
 *     the scrolling path.
 *   · the system-wide accessibility zoom — untouched, and deliberately so. It
 *     is not ours to disable and nothing here reaches it.
 *
 * This does remove a capability someone may rely on (WCAG 2.2 SC 1.4.4, Resize
 * Text). It is confined to this one function so it can be removed by deleting
 * the call, and the layout is fully responsive and reflows to 200% text without
 * it — the field sizes above are what stop the app zooming when you tap a
 * search box, and those are an improvement for everyone.
 */
export function blockZoom() {
  /* Passive listeners cannot cancel anything, and these default to passive on
     some engines, so the flag is not optional. */
  const stop = (e) => e.preventDefault();
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(type, stop, { passive: false });
  }
}

/**
 * Keep the shell matched to the visible viewport.
 *
 * The shell is position:fixed so it always fills the screen, but a fixed
 * element does not shrink when the on-screen keyboard appears — iOS shrinks the
 * visual viewport and leaves the layout viewport alone, so the composer on the
 * Ask tab and the search field in Library end up hidden behind the keyboard.
 */
export function syncViewport() {
  const vv = window.visualViewport;
  if (!vv) return;

  /* The difference between the layout and visual viewports is NOT necessarily
     the keyboard. In Safari it is also the browser's own URL bar, which is
     always there — so measuring the gap unconditionally shrinks the app by the
     height of the address bar and leaves a dead band under the tab bar. Only a
     focused text field can summon a keyboard, so that is the gate. */
  const isEditing = () => {
    const node = document.activeElement;
    if (!node) return false;
    return node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.isContentEditable;
  };

  /* Below this, a shrink is browser chrome rather than a keyboard. No on-screen
     keyboard is under ~150px on any phone. */
  const KEYBOARD_MIN = 150;

  let frame = 0;
  const apply = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      let covered = 0;
      if (isEditing()) {
        const gap = window.innerHeight - vv.height - vv.offsetTop;
        if (gap >= KEYBOARD_MIN) covered = gap;
      }
      document.documentElement.style.setProperty('--kb', `${Math.round(covered)}px`);
    });
  };

  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  /* Focus changes are what actually open and close the keyboard; the viewport
     events alone can fire before activeElement has settled. */
  document.addEventListener('focusin', apply);
  document.addEventListener('focusout', () => setTimeout(apply, 50));
  apply();

  /* The shortfall is a property of the current orientation, not the session. */
  const remeasure = () => measureShortfall();
  window.addEventListener('orientationchange', () => setTimeout(remeasure, 300));
  window.addEventListener('resize', remeasure);

  /* The blank-and-reflow trick below undoes a viewport that was full height and
     then shrank. The iOS 26 shortfall is not that — it is short from the first
     frame, it was measured at 0/3 on the affected device, and running it anyway
     just blinks the whole UI three times at launch for nothing. */
  if (!state.shortfall) initViewportHeal(isEditing, apply);
}

/**
 * Undo iOS's permanent viewport shrink.
 *
 * In a home-screen web app, the first time the on-screen keyboard opens iOS
 * shrinks the layout viewport by the height of the status bar and then never
 * gives it back — innerHeight, visualViewport.height and 100dvh all drop
 * together (932 → 873 on an iPhone Pro Max) and stay there until the app is
 * force quit. Everything downstream is then correct about a wrong number: the
 * shell fills the viewport perfectly, the viewport is simply 59pt shorter than
 * the screen, and the difference shows up as a dead band under the tab bar.
 *
 * Blanking a full-height element forces WebKit to re-measure, which restores
 * the real height. It is a blunt instrument — a reflow, and one blank frame —
 * so it only runs when there is a measured shortfall and no field is focused.
 */
function initViewportHeal(isEditing, afterHeal) {
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  state.standalone = standalone;
  if (!standalone) return; // mobile Safari does not have this bug

  const app = document.getElementById('app');
  if (!app) return;

  let tallest = window.innerHeight;

  /* A launch can inherit the shrink from a previous session, so the screen is
     used as a second opinion — but only when the gap is status-bar sized. A
     wildly different number means something we do not understand, and healing
     towards it would be guessing. */
  const plausible = screen.height - window.innerHeight;
  if (plausible > 0 && plausible <= 120) tallest = Math.max(tallest, screen.height);
  state.tallest = tallest;

  let failures = 0;
  let busy = false;

  window.addEventListener('resize', () => {
    tallest = Math.max(tallest, window.innerHeight);
    state.tallest = tallest;
  });

  function heal() {
    if (state.gaveUp || busy) return;
    if (isEditing()) return; // the keyboard is genuinely up; the shrink is real
    const before = window.innerHeight;
    if (tallest - before <= 4) return;

    busy = true;
    state.attempts += 1;

    /* Blanking the shell resets every scroll container inside it. */
    const scrollers = [...document.querySelectorAll('.scroll')];
    const tops = scrollers.map((s) => s.scrollTop);

    app.style.display = 'none';
    void app.offsetHeight; // force a synchronous reflow while it is gone
    app.style.display = '';

    scrollers.forEach((s, i) => {
      s.scrollTop = tops[i];
    });

    /* WebKit does not necessarily report the new height on the very next frame,
       and judging it too early is how a heal that actually worked gets counted
       as a failure — twice in a row and we would switch ourselves off for the
       rest of the session. Give it a beat before deciding. */
    setTimeout(() => {
      requestAnimationFrame(() => {
        busy = false;
        if (window.innerHeight > before) {
          failures = 0;
          state.recovered += 1;
          afterHeal();
        } else if (++failures >= 3) {
          /* Three flips with nothing to show for it: stop, rather than blinking
             the whole app at someone on every keyboard dismissal for no gain. */
          state.gaveUp = true;
          console.info('[viewport] shrink could not be healed — leaving it alone');
        }
      });
    }, 180);
  }

  /* Dismissing the keyboard is what leaves the viewport stuck, so that is the
     moment to check. The delay lets iOS finish its own animation first. */
  document.addEventListener('focusout', () => setTimeout(heal, 160));
  /* And returning to the app, which is when a shrink inherited from earlier in
     the session becomes visible again. */
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) setTimeout(heal, 120);
  });
  window.addEventListener('pageshow', () => setTimeout(heal, 120));
  window.addEventListener('orientationchange', () => setTimeout(heal, 300));

  /* At startup — the case the user actually reported: the app opened already
     short, with no keyboard involved. Retried a few times because the first
     attempt can land before the shell has settled. */
  [400, 1200, 2500].forEach((t) => setTimeout(heal, t));

  /* Manual override, for confirming the mechanism works on a device that is not
     in front of us. Resets the give-up latch so it is always worth a try. */
  window.wn = Object.assign(window.wn || {}, {
    fixViewport() {
      state.gaveUp = false;
      failures = 0;
      heal();
      return healState();
    },
  });
}

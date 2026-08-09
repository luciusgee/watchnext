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
};

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

  initViewportHeal(isEditing, apply);
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

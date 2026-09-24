/*
 * Swipe from the left edge to go back.
 *
 * Every iOS app has it, and a home-screen web app gets none of it for free:
 * Safari's own back swipe belongs to the browser, and in standalone mode there
 * is no browser. So a screen you went into could only be left by reaching for
 * the Back arrow in the top corner.
 *
 * The screen follows the finger, the one it came from shows through
 * underneath, and letting go past a third of the way — or flicking — finishes
 * the job. Anything less springs back.
 *
 * Touch events rather than pointer events: the first horizontal move has to
 * be cancelled before iOS decides the touch is a scroll, and only a
 * non-passive touchmove can do that.
 */

const EDGE = 24; // px from the left edge a back swipe may start in
const ENGAGE = 8; // px of sideways travel before it counts as a swipe
const DISTANCE = 1 / 3; // share of the width that commits it on release
const VELOCITY = 0.35; // px per ms that commits it however short
const MS = 220;

const reduceMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * @param {() => null | {
 *   layer: HTMLElement,          what slides away
 *   under?: HTMLElement | null,  what shows through (already on screen if omitted)
 *   reveal?: () => void,         called once `under` is on screen, to put its scroll back
 *   onBack: () => void,          commit: navigate back, without its own animation
 * }} resolve  asked at the start of every edge touch; null means "nowhere to go"
 */
export function initSwipeBack(resolve) {
  let t = null;

  const reset = () => {
    if (!t) return;
    const { layer, under } = t.target;
    for (const node of [layer, under]) {
      if (!node) continue;
      node.style.transition = '';
      node.style.transform = '';
      node.style.boxShadow = '';
      node.style.height = '';
    }
    layer.classList.remove('is-swiping');
    under?.classList.remove('is-under');
    t = null;
  };

  const paint = (dx) => {
    const { layer, under } = t.target;
    layer.style.transform = `translateX(${dx}px)`;
    /* The screen underneath starts a little to the left and slides home as
       this one leaves, the way iOS pages do. */
    if (under) under.style.transform = `translateX(${(-0.3 * (t.width - dx)).toFixed(1)}px)`;
  };

  document.addEventListener(
    'touchstart',
    (e) => {
      if (t || e.touches.length !== 1) return;
      const touch = e.touches[0];
      if (touch.clientX > EDGE) return;
      /* A card on a deck is dragged, not swiped back from. Nor does anything
         go back from under an open sheet. */
      if (e.target.closest?.('.deck, [data-no-swipeback]')) return;
      if (document.querySelector('.sheet.is-open, .panel.is-open, .scrim.is-open')) return;
      const target = resolve();
      if (!target) return;
      t = {
        target,
        x0: touch.clientX,
        y0: touch.clientY,
        dx: 0,
        engaged: false,
        width: target.layer.getBoundingClientRect().width || innerWidth,
        samples: [],
      };
    },
    { passive: true }
  );

  document.addEventListener(
    'touchmove',
    (e) => {
      if (!t) return;
      const touch = e.touches[0];
      const dx = touch.clientX - t.x0;
      const dy = touch.clientY - t.y0;
      if (!t.engaged) {
        /* Mostly downward: a scroll that happened to start near the edge. */
        if (Math.abs(dy) > ENGAGE && Math.abs(dy) > Math.abs(dx)) {
          t = null;
          return;
        }
        if (dx < ENGAGE || dx < Math.abs(dy)) return;
        t.engaged = true;
        const { layer, under } = t.target;
        layer.classList.add('is-swiping');
        layer.style.transition = 'none';
        layer.style.boxShadow = '-12px 0 32px rgba(0, 0, 0, 0.45)';
        if (under) {
          under.style.height = `${layer.getBoundingClientRect().height}px`;
          under.style.transition = 'none';
          under.classList.add('is-under');
          t.target.reveal?.();
        }
      }
      e.preventDefault();
      t.dx = Math.max(0, dx);
      const now = performance.now();
      t.samples.push([now, t.dx]);
      while (t.samples.length > 2 && now - t.samples[0][0] > 100) t.samples.shift();
      paint(t.dx);
    },
    { passive: false }
  );

  const end = (cancelled) => {
    if (!t) return;
    if (!t.engaged) {
      t = null;
      return;
    }
    const [[t0, x0] = [0, 0]] = t.samples;
    const [t1, x1] = t.samples[t.samples.length - 1] || [0, 0];
    /* A finger that stopped before it lifted is not flicking, however fast
       it was going earlier. */
    const v = t1 > t0 && performance.now() - t1 < 100 ? (x1 - x0) / (t1 - t0) : 0;
    const commit = !cancelled && (t.dx > t.width * DISTANCE || (v > VELOCITY && t.dx > ENGAGE * 3));
    const { layer, under } = t.target;
    const ms = reduceMotion() ? 0 : MS;
    const ease = `transform ${ms}ms cubic-bezier(.22,.61,.36,1)`;
    layer.style.transition = ease;
    if (under) under.style.transition = ease;
    paint(commit ? t.width : 0);
    const finish = () => {
      if (!t) return;
      const { onBack } = t.target;
      if (commit) onBack();
      reset();
    };
    if (ms) setTimeout(finish, ms);
    else finish();
  };

  document.addEventListener('touchend', () => end(false));
  document.addEventListener('touchcancel', () => end(true));
}

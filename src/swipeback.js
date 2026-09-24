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
 * the job. Anything less, or letting go while moving back, springs back.
 *
 * Touch events rather than pointer events: the first horizontal move has to
 * be cancelled before iOS decides the touch is a scroll, and only a
 * non-passive touchmove can do that. That listener goes only on the surfaces
 * that can be swiped back from — a non-passive touchmove on the whole
 * document would put every scroll in the app behind the main thread.
 */

const EDGE = 24; // px from the left edge a back swipe may start in
const ENGAGE = 8; // px of sideways travel before it counts as a swipe
const DISTANCE = 1 / 3; // share of the width that commits it on release
const VELOCITY = 0.35; // px per ms that commits it however short
const MS = 220;

const reduceMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

let cancelActive = () => {};

/** Abandon any swipe in progress or settling, without going back. Called by
    navigation, so a tab tapped while a swipe settles is not overridden by it. */
export function cancelSwipe() {
  cancelActive();
}

/**
 * @param {() => null | {
 *   layer: HTMLElement,          what slides away
 *   under?: HTMLElement | null,  what shows through (already on screen if omitted)
 *   onStart?: () => void,        the swipe has engaged and `under` is on screen
 *   onEnd?: () => void,          the swipe is over, either way
 *   onBack: () => void,          commit: navigate back, without its own animation
 * }} resolve  asked at the start of every edge touch; null means "nowhere to go"
 * @param {HTMLElement[]} surfaces  where a back swipe can start
 */
export function initSwipeBack(resolve, surfaces) {
  let t = null;
  /* An event reaching both the surface and the node it started on is handled
     once. */
  const seen = new WeakSet();

  const reset = () => {
    if (!t) return;
    const { layer, under, onEnd } = t.target;
    clearTimeout(t.timer);
    for (const node of [layer, under]) {
      if (!node) continue;
      node.style.transition = '';
      node.style.transform = '';
      node.style.boxShadow = '';
      node.style.height = '';
    }
    layer.classList.remove('is-swiping');
    under?.classList.remove('is-under');
    for (const [type, fn] of t.local) t.origin.removeEventListener(type, fn);
    const engaged = t.engaged;
    t = null;
    if (engaged) onEnd?.();
  };
  cancelActive = reset;

  /* Land a settling swipe now rather than when its animation ends. */
  const land = () => {
    if (!t) return;
    const { onBack } = t.target;
    const commit = t.commit;
    reset();
    if (commit) onBack();
  };

  const paint = (dx) => {
    const { layer, under } = t.target;
    layer.style.transform = `translateX(${dx}px)`;
    /* The screen underneath starts a little to the left and slides home as
       this one leaves, the way iOS pages do. */
    if (under) under.style.transform = `translateX(${(-0.3 * (t.width - dx)).toFixed(1)}px)`;
  };

  /* The finger this swipe belongs to, among whatever else is touching. */
  const ours = (e) => [...e.changedTouches].find((x) => x.identifier === t.id);

  const onMove = (e) => {
    if (!t || t.settling || seen.has(e)) return;
    seen.add(e);
    const touch = ours(e);
    if (!touch) return;
    const dx = touch.clientX - t.x0;
    const dy = touch.clientY - t.y0;
    if (!t.engaged) {
      /* Mostly downward: a scroll that happened to start near the edge. And
         if iOS has already begun a scroll, this touch is not ours to take —
         cancelling later moves does nothing once it has. */
      if ((Math.abs(dy) > ENGAGE && Math.abs(dy) > Math.abs(dx)) || !e.cancelable) {
        reset();
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
      }
      t.target.onStart?.();
    }
    e.preventDefault();
    t.dx = Math.max(0, dx);
    const now = performance.now();
    t.samples.push([now, t.dx]);
    while (t.samples.length > 2 && now - t.samples[0][0] > 100) t.samples.shift();
    paint(t.dx);
  };

  const onEnd = (e) => {
    if (!t || t.settling || seen.has(e)) return;
    seen.add(e);
    if (!ours(e)) return;
    if (!t.engaged) {
      reset();
      return;
    }
    const [[t0, x0] = [0, 0]] = t.samples;
    const [t1, x1] = t.samples[t.samples.length - 1] || [0, 0];
    /* A finger that stopped before it lifted is not flicking, however fast
       it was going earlier. */
    const v = t1 > t0 && performance.now() - t1 < 100 ? (x1 - x0) / (t1 - t0) : 0;
    t.commit =
      e.type === 'touchend' &&
      /* Letting go while moving back is changing your mind, as on iOS. */
      v > -VELOCITY &&
      (t.dx > t.width * DISTANCE || (v > VELOCITY && t.dx > ENGAGE * 3));
    const { layer, under } = t.target;
    const ms = reduceMotion() ? 0 : MS;
    const ease = `transform ${ms}ms cubic-bezier(.22,.61,.36,1)`;
    layer.style.transition = ease;
    if (under) under.style.transition = ease;
    paint(t.commit ? t.width : 0);
    /* Settling: the rest of this finger, and any other, is ignored until the
       screens have landed. */
    t.settling = true;
    if (ms) t.timer = setTimeout(land, ms);
    else land();
  };

  const onStart = (e) => {
    /* A new touch while the last swipe settles: land it now, then consider
       this one afresh. */
    if (t?.settling) land();
    if (t || e.touches.length !== 1) return;
    const touch = e.touches[0];
    if (touch.clientX > EDGE) return;
    /* A card on a deck is dragged, not swiped back from. Nor does anything
       go back from under an open sheet. */
    if (e.target.closest?.('.deck-card, [data-no-swipeback]')) return;
    if (document.querySelector('.sheet.is-open, .panel.is-open, .scrim.is-open')) return;
    const target = resolve();
    if (!target) return;
    t = {
      target,
      id: touch.identifier,
      x0: touch.clientX,
      y0: touch.clientY,
      dx: 0,
      engaged: false,
      settling: false,
      commit: false,
      timer: 0,
      width: target.layer.getBoundingClientRect().width || innerWidth,
      samples: [],
      /* The node the finger landed on keeps receiving this touch's events
         even if a re-render takes it out of the page — a sync arriving
         mid-swipe rebuilds a film's details — and then they never reach the
         surface. Listen there too. */
      origin: e.target,
      local: [
        ['touchmove', onMove],
        ['touchend', onEnd],
        ['touchcancel', onEnd],
      ],
    };
    for (const [type, fn] of t.local) t.origin.addEventListener(type, fn, { passive: type !== 'touchmove' });
  };

  for (const surface of surfaces) {
    if (!surface) continue;
    surface.addEventListener('touchstart', onStart, { passive: true });
    surface.addEventListener('touchmove', onMove, { passive: false });
    surface.addEventListener('touchend', onEnd, { passive: true });
    surface.addEventListener('touchcancel', onEnd, { passive: true });
  }
  /* Put away, mid-swipe: nothing more is coming for this finger. */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') reset();
  });
}

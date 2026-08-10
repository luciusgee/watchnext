/*
 * Card swiping, shared by every deck in the app.
 *
 * There are two of them now — Discover, which asks whether you have seen a
 * film, and the session picker, which asks whether you fancy one tonight — and
 * a third would have been the point at which the copies quietly diverged. The
 * tab bar was already rebuilt once for exactly that reason.
 *
 * Deliberately knows nothing about the store. It reports which way a card went
 * and leaves every consequence to the caller, which is what lets the picker
 * guarantee it writes nothing at all: there is no code path from here to a
 * save, so that is a property of the module rather than a flag someone has to
 * remember to pass.
 */

/* Past this, a drag is a decision. Either distance or speed will do — a quick
   flick never travels far. */
const DISTANCE = 96;
const VELOCITY = 0.45; // px per ms

/**
 * Make a card draggable.
 *
 * Pointer Events cover mouse, touch and pen in one code path. The version this
 * replaces registered four separate touch and mouse handlers and never removed
 * them, leaking a listener set per card.
 *
 * @param {HTMLElement} card       the element to drag
 * @param {object}      handlers
 * @param {() => void}  handlers.onRight  swiped right (the affirmative)
 * @param {() => void}  handlers.onLeft   swiped left
 * @param {() => boolean} [handlers.blocked]  return true to ignore input, e.g.
 *        while a previous card is still animating out
 * @returns {() => void} teardown — call before dropping the card
 */
export function attachSwipe(card, { onRight, onLeft, blocked = () => false }) {
  let startX = 0;
  let startY = 0;
  let startT = 0;
  let dx = 0;
  let dy = 0;
  let dragging = false;
  let pointerId = null;

  /* Optional: a deck without stamps simply gets no feedback overlay. */
  const stamps = {
    right: card.querySelector('[data-stamp="right"]'),
    left: card.querySelector('[data-stamp="left"]'),
  };
  const paint = (node, distance) => {
    if (node) node.style.opacity = distance > 30 ? String(Math.min(1, (distance - 30) / 70)) : '0';
  };
  const clearStamps = () => {
    for (const s of Object.values(stamps)) if (s) s.style.opacity = '0';
  };

  const onDown = (e) => {
    if (blocked() || e.button > 0) return;
    dragging = true;
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    startT = performance.now();
    card.setPointerCapture(pointerId);
    card.style.transition = 'none';
  };

  const onMove = (e) => {
    if (!dragging || e.pointerId !== pointerId) return;
    dx = e.clientX - startX;
    dy = e.clientY - startY;
    /* The card follows the finger on both axes so the drag feels physical, but
       only horizontal travel decides anything — vertical drift is carried, not
       interpreted. */
    card.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 18}deg)`;
    paint(stamps.right, dx);
    paint(stamps.left, -dx);
  };

  const onUp = (e) => {
    if (!dragging || e.pointerId !== pointerId) return;
    dragging = false;
    try {
      card.releasePointerCapture(pointerId);
    } catch {
      /* capture may already be gone */
    }
    card.style.transition = '';

    const vx = dx / Math.max(1, performance.now() - startT);
    if (dx > DISTANCE || vx > VELOCITY) return onRight();
    if (dx < -DISTANCE || vx < -VELOCITY) return onLeft();

    /* snap back */
    card.style.transform = '';
    clearStamps();
    dx = dy = 0;
  };

  card.addEventListener('pointerdown', onDown);
  card.addEventListener('pointermove', onMove);
  card.addEventListener('pointerup', onUp);
  card.addEventListener('pointercancel', onUp);

  return () => {
    card.removeEventListener('pointerdown', onDown);
    card.removeEventListener('pointermove', onMove);
    card.removeEventListener('pointerup', onUp);
    card.removeEventListener('pointercancel', onUp);
  };
}

/** Throw a card off screen. Resolves when it is gone. */
export function flingOut(card, direction) {
  card.style.transition = 'transform .28s cubic-bezier(.22,.61,.36,1), opacity .28s linear';
  card.style.transform =
    direction === 'right'
      ? 'translate(140%, 40px) rotate(22deg)'
      : 'translate(-140%, 40px) rotate(-22deg)';
  card.style.opacity = '0';
}

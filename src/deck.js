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
/* Reads one setting (whether haptics are on) and writes nothing, so what is
   said above about this module and saving still holds. */
import * as haptics from './haptics.js';

const DISTANCE = 96;
const VELOCITY = 0.45; // px per ms

/* How long a caller should wait before rebuilding the deck under a card it has
   just flung. The reduced-motion block in app.css kills the transition with
   !important, which outranks the inline shorthand flingOut writes — so for
   anyone with the preference on the card is already gone and the wait was a
   quarter-second of empty deck. Exported so both decks read the same number. */
export const FLING_MS =
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    ? 0
    : 220;

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
  /* Which side of the decision line the card is on, so crossing it can be
     felt: -1 past the left, 1 past the right, 0 in between. */
  let side = 0;

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
    side = 0;
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
    /* A tick as the card crosses the line where letting go decides — the feel
       of a native swipe action. Once per crossing, in either direction. */
    const now = dx > DISTANCE ? 1 : dx < -DISTANCE ? -1 : 0;
    if (now !== side) {
      if (now !== 0) haptics.selection();
      side = now;
    }
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

/**
 * Play the decision on a card the user did not drag.
 *
 * Tapping the yes/no button is the same decision as the swipe, and used to
 * look completely different: the stamp is painted by the pointermove handler,
 * which a tap never runs, so the card just left with no label. This lights the
 * stamp, promotes the card behind it, and throws the front card — so both
 * routes to the same outcome land in the same place.
 */
export function playDecision(deckEl, direction) {
  const card = deckEl && deckEl.lastElementChild;
  if (!card || !card.classList.contains('deck-card')) return false;
  const stamp = card.querySelector(`[data-stamp="${direction}"]`);
  if (stamp) stamp.style.opacity = '1';
  /* Both routes land here — the swipe's pointerup and the button's click —
     so the decision feels the same either way. */
  haptics.impact();
  /* The card behind used to sit at scale(.94) until it was replaced wholesale
     by a full-size one, so the stack blinked a size up instead of the next
     card rising into the gap. */
  const back = deckEl.querySelector('.deck-card:not(:last-child)');
  if (back) {
    back.style.transform = 'scale(1) translateY(0)';
    back.style.opacity = '1';
  }
  flingOut(card, direction);
  return true;
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

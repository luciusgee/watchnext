/*
 * Haptics.
 *
 * There is no haptics API on the web for iPhone. navigator.vibrate is Android
 * only — Safari has never shipped it, in a tab or on the home screen. What iOS
 * 18 and later do have is the native switch control, <input type=checkbox
 * switch>, which plays the system selection tick when it toggles. Clicking a
 * hidden label wrapped round one is the same toggle, so it plays the same
 * tick. It is one feel only — a light, crisp tap — so the stronger kinds below
 * are built from it rather than being different sensations.
 *
 * Android gets real patterns through navigator.vibrate.
 *
 * Everything here is best-effort and silent on failure: a phone with System
 * Haptics switched off, a desktop, an older iOS — all simply feel nothing,
 * which is the right outcome. Nothing may ever throw out of this module into a
 * tap handler.
 */

import * as store from './store.js';

const canVibrate = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';

/* The switch attribute is reflected on HTMLInputElement where it is
   supported (Safari 17.4+). Coarse pointer, so a Mac with Safari toggling a
   hidden checkbox does not pretend to be a phone. */
const canTick =
  !canVibrate &&
  typeof HTMLInputElement !== 'undefined' &&
  'switch' in HTMLInputElement.prototype &&
  typeof matchMedia === 'function' &&
  matchMedia('(pointer: coarse)').matches;

let tickLabel = null;

/* Built once and reused. It lives in <head>, where nothing renders and
   nothing can take focus, so it cannot move focus or dismiss a keyboard that
   is up for a text field. */
function ensureTick() {
  if (tickLabel?.isConnected) return tickLabel;
  const label = document.createElement('label');
  label.setAttribute('aria-hidden', 'true');
  label.style.display = 'none';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.setAttribute('switch', '');
  input.tabIndex = -1;
  label.appendChild(input);
  document.head.appendChild(label);
  tickLabel = label;
  return label;
}

function tick() {
  try {
    ensureTick().click();
  } catch {
    /* best effort */
  }
}

/** Is there anything on this device that can be felt? */
export function supported() {
  return canVibrate || canTick;
}

function enabled() {
  try {
    return store.settings().haptics !== false;
  } catch {
    return true;
  }
}

function play(pattern, ticks) {
  if (!enabled()) return;
  if (canVibrate) {
    try {
      navigator.vibrate(pattern);
    } catch {
      /* best effort */
    }
    return;
  }
  if (!canTick) return;
  tick();
  /* Further ticks for the heavier kinds. Spaced far enough apart to be felt
     as separate taps. */
  for (let i = 1; i < ticks; i++) setTimeout(tick, i * 110);
}

/** Something was chosen: a segment, a pill, a filter, a switch. */
export function selection() {
  play(8, 1);
}

/** A decision landed: a card swiped away, a hold that started selecting. */
export function impact() {
  play(14, 1);
}

/** It worked: a film added, marked watched, a hand dealt. */
export function success() {
  play([12, 70, 18], 2);
}

/** Look before you tap: a destructive confirm is about to be asked. */
export function warning() {
  play([20, 90, 20], 2);
}

/** That did not work: a form refused, an ask that failed. */
export function error() {
  play([28, 60, 28, 60, 28], 3);
}

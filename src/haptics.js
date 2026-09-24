/*
 * Haptics, iPhone only.
 *
 * Safari has never had a vibration API. What iOS 18 and later do have is the
 * native switch control, <input type=checkbox switch>, which plays the system
 * selection tick when it is toggled — one feel, a light crisp tap.
 *
 * For a while a script could toggle a hidden one and borrow the tick from
 * anywhere. iOS 26.5 closed that: the switch now only ticks for a trusted
 * click, one that came from a real finger. So the finger has to land on it.
 *
 * What this does instead: any control marked `data-haptic` gets a transparent
 * <label> laid over its whole face, wrapping a tiny invisible switch. A tap on
 * the control is a tap on the label; the label passes that trusted click to
 * its switch, which ticks. The label's own click still bubbles to the control,
 * so the control's handler runs exactly as before — the switch's click is
 * stopped before it can reach the control a second time.
 *
 * A label rather than the bare switch because a switch under the finger marks
 * touchstart as handled, and a row of pills could no longer be scrolled by a
 * drag that started on one.
 *
 * What this cannot do: a tick that is not a tap. A swipe landing, a drag
 * crossing a threshold, a long press, an answer arriving from Claude — none
 * of those is a click on anything, so none can be felt.
 *
 * Never on a submit button: the label takes the click's default action, so
 * the form would not submit. arm() refuses them.
 */

import * as store from './store.js';

/* The switch attribute is reflected on HTMLInputElement where it exists
   (Safari 17.4+). Coarse pointer, so a Mac running Safari does not grow
   invisible labels over every button for a tick it cannot play. */
const canTick =
  typeof HTMLInputElement !== 'undefined' &&
  'switch' in HTMLInputElement.prototype &&
  typeof matchMedia === 'function' &&
  matchMedia('(pointer: coarse)').matches;

/** Can this device play the tick at all? */
export function supported() {
  return canTick;
}

function enabled() {
  try {
    return store.settings().haptics !== false;
  } catch {
    return true;
  }
}

const stop = (e) => e.stopPropagation();

function arm(host) {
  if (host.querySelector(':scope > .haptic')) return;
  if (host instanceof HTMLButtonElement && host.type === 'submit') return;
  const label = document.createElement('label');
  label.className = 'haptic';
  label.setAttribute('aria-hidden', 'true');
  const sw = document.createElement('input');
  sw.type = 'checkbox';
  sw.setAttribute('switch', '');
  sw.className = 'haptic-switch';
  /* No tabindex: in WebKit that makes the switch mouse-focusable, and a tap
     would move focus off a text field and drop the keyboard. */
  /* The label's click is the one the control should see. The switch's copy,
     and the input and change it fires, belong to nobody — a form listening
     for input would otherwise hear a field it does not have. */
  sw.addEventListener('click', stop);
  sw.addEventListener('input', stop);
  sw.addEventListener('change', stop);
  label.appendChild(sw);
  host.appendChild(label);
}

/* Re-arming is needed as well as arming: a control whose caption is set with
   textContent loses its children, the label with them. */
function sweep() {
  for (const host of document.querySelectorAll('[data-haptic]')) arm(host);
}

let observer = null;

/** Call once the settings are loaded. */
export function start() {
  if (!canTick || observer) return;
  refresh();
  sweep();
  observer = new MutationObserver(sweep);
  observer.observe(document.body, { childList: true, subtree: true });
}

/** Apply the Settings switch. Off hides every label, so taps land on the
    controls themselves exactly as they would without any of this. */
export function refresh() {
  document.documentElement.classList.toggle('no-haptics', !enabled());
}

/*
 * Haptics, iPhone only: a light tick on every tap of a button.
 *
 * Safari has never had a vibration API. What iOS 18 and later do have is the
 * native switch control, <input type=checkbox switch>, which plays the system
 * selection tick when it is toggled — one feel, a light crisp tap.
 *
 * For a while a script could toggle a hidden one and borrow the tick from
 * anywhere. iOS 26.5 closed that: the switch now only ticks for a trusted
 * click, one that came from a real finger. So the finger has to land on it.
 *
 * What this does instead: every button, and every link dressed as one, gets a
 * transparent <label> laid over its whole face, wrapping a tiny invisible
 * switch. A tap on the button is a tap on the label; the label passes that
 * trusted click to its switch, which ticks. The label's own click still
 * bubbles to the button, so the button's handler runs exactly as before — the
 * switch's click is stopped before it can reach the button a second time.
 *
 * A label rather than the bare switch because a switch under the finger marks
 * touchstart as handled, and a list of buttons could no longer be scrolled by
 * a drag that started on one.
 *
 * The one cost: the label takes the click's default action. For most buttons
 * there is none. A link would no longer open, so that is done here by hand,
 * once the click has been through every handler and nobody has cancelled it.
 * A submit button still submits in WebKit — the label's click goes on to
 * dispatch DOMActivate, which reaches the button — but not in every engine,
 * so it is submitted by hand only if nothing else did.
 *
 * And assistive technology: VoiceOver, Voice Control and Switch Control press
 * a button by hit-testing its centre, which finds the label, which presses
 * the switch directly — so a press on the switch that did not come through
 * the label is handed to the button it covers.
 *
 * What this cannot do: a tick that is not a tap. A swipe, a long press, an
 * answer arriving from Claude — none of those is a click on anything.
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

/* What gets a tick. `data-no-haptic` opts a control out. */
const HOSTS = 'button, a[href]:not([download]), [role="button"], [data-haptic]';

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

/* The label whose tap is being passed on to its switch right now. */
let forwarding = null;
/* Labels this module built, so a copy made by serialising a button's markup —
   which would carry a switch with none of the listeners below — is told apart
   and replaced. */
const ours = new WeakSet();

function eligible(host) {
  if (!(host instanceof HTMLElement) || !host.matches(HOSTS)) return false;
  if (host.matches('[data-no-haptic], input, select, textarea, label, .haptic')) return false;
  /* A control inside another one ticks through the outer label already. */
  if (host.parentElement?.closest('.haptic, button, a[href], [role="button"]')) return false;
  return true;
}

function arm(host) {
  if (!eligible(host)) return;
  for (const child of host.children) {
    if (!child.classList.contains('haptic')) continue;
    if (ours.has(child)) return;
    child.remove();
    break;
  }
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
  label.addEventListener('click', () => {
    forwarding = label;
    /* In case the forward never comes — a handler cancelled the click. */
    setTimeout(() => {
      if (forwarding === label) forwarding = null;
    }, 0);
  });
  sw.addEventListener('click', (e) => {
    e.stopPropagation();
    if (forwarding === label) {
      forwarding = null;
      return;
    }
    /* Pressed without a tap on the label: assistive technology. The press
       was meant for the button. */
    e.preventDefault();
    label.parentElement?.click();
  });
  sw.addEventListener('input', stop);
  sw.addEventListener('change', stop);
  label.appendChild(sw);
  /* First, not last: code that reaches for a button's last child to change
     its caption must still find the caption. */
  host.prepend(label);
  ours.add(label);
  /* The hook the stylesheet positions the label against. An attribute, not a
     class: a later `className =` on the control would drop a class, and the
     label would then cover whatever ancestor happened to be positioned. */
  host.setAttribute('data-haptic', '');
}

function scan(root) {
  if (!(root instanceof Element)) return;
  if (root.matches(HOSTS)) arm(root);
  for (const host of root.querySelectorAll(HOSTS)) arm(host);
}

/* Only what changed. A control whose caption is set with textContent loses
   its children, the label with them — the mutation's target is that control. */
function onMutations(records) {
  for (const r of records) {
    if (r.target instanceof Element && r.target.matches(HOSTS)) arm(r.target);
    for (const node of r.addedNodes) scan(node);
  }
}

/* The default action the label took away, put back. Runs on the way out of
   the click, after every handler on the control, and only if none of them
   cancelled it — exactly when the browser would have done it itself. */
function onClick(e) {
  const label = e.target;
  if (!(label instanceof Element) || !label.classList.contains('haptic') || e.defaultPrevented) return;
  const host = label.parentElement;
  if (!host) return;
  if (host instanceof HTMLButtonElement && host.type === 'submit' && host.form && !host.disabled) {
    /* WebKit submits this itself, straight after this click, through
       DOMActivate; submitting here as well sent the form twice — "Added
       Alien", then "Give it a title first" for the emptied form. Only if
       nothing has submitted by the end of the task is it done here. */
    const form = host.form;
    let submitted = false;
    const saw = (ev) => {
      if (ev.target === form) submitted = true;
    };
    document.addEventListener('submit', saw, true);
    setTimeout(() => {
      document.removeEventListener('submit', saw, true);
      if (!submitted && host.isConnected && !host.disabled) form.requestSubmit(host);
    }, 0);
  } else if (host instanceof HTMLAnchorElement && host.href) {
    if (host.target === '_blank') {
      /* The link's own promise not to send a referrer, kept. */
      const features = /\bnoreferrer\b/i.test(host.rel) ? 'noopener,noreferrer' : 'noopener';
      window.open(host.href, '_blank', features);
    } else location.assign(host.href);
  }
}

let observer = null;

/** Call once the settings are loaded. */
export function start() {
  if (!canTick || observer) return;
  refresh();
  scan(document.body);
  observer = new MutationObserver(onMutations);
  observer.observe(document.body, { childList: true, subtree: true });
  document.addEventListener('click', onClick);
}

/** Apply the Settings switch. Off hides every label, so taps land on the
    controls themselves exactly as they would without any of this. */
export function refresh() {
  document.documentElement.classList.toggle('no-haptics', !enabled());
}

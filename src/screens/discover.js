/*
 * Discover — swipe triage.
 *
 * The old version had a one-way latch: the queue filtered on `swipedSeen`,
 * every swipe set it true, and the only code that could clear it was behind a
 * mode flag that was never assigned. Meanwhile all three reset buttons cleared
 * a *different* field (`swiped`) that nothing read. The tab died permanently
 * and three buttons lied about fixing it.
 *
 * Here there is exactly one field (`seen`), and reset is the literal inverse of
 * the queue predicate. See isPending() / actions.resetDiscover().
 */

import * as store from '../store.js';
import * as actions from '../actions.js';
import { el, clear, poster, emptyState, button, toast } from '../ui.js';
import { icon } from '../icons.js';
import { runtime, rating } from '../format.js';
import { openDetail } from './detail.js';

const SWIPE_THRESHOLD = 96;
const VELOCITY_THRESHOLD = 0.45;

let root = null;
let deckEl = null;
let queue = [];
let busy = false;
let teardown = null;

/** The single source of truth for "should this appear in Discover". */
export function isPending(item) {
  return !item.seen && !item.watched;
}

export function initDiscover() {
  root = document.getElementById('screen-discover');
  deckEl = root.querySelector('[data-region="deck"]');

  root.querySelector('[data-action="skip"]').addEventListener('click', () => commit('skip'));
  root.querySelector('[data-action="save"]').addEventListener('click', () => commit('save'));
  root.querySelector('[data-action="watched"]').addEventListener('click', () => commit('watched'));

  store.subscribe((r) => {
    if (r === 'item' && root.classList.contains('is-active') && !busy) refill();
  });
}

export function showDiscover() {
  refill();
}

function refill() {
  const pending = store.items().filter(isPending);
  /* Shuffle once per session, not per render, so the deck is stable. */
  if (!queue.length || queue.some((uid) => !store.byUid(uid) || !isPending(store.byUid(uid)))) {
    queue = shuffle(pending.map((i) => i.uid));
  }
  render();
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function render() {
  teardown?.();
  teardown = null;
  clear(deckEl);

  const controls = root.querySelector('[data-region="controls"]');
  const progress = root.querySelector('[data-region="progress"]');

  const total = store.items().filter((i) => !i.watched).length;
  const left = queue.length;
  const done = Math.max(0, total - left);

  if (!left) {
    controls.hidden = true;
    progress.hidden = true;
    const anySeen = store.items().some((i) => i.seen);
    deckEl.appendChild(
      emptyState({
        iconName: 'check',
        title: anySeen ? 'You’ve been through everything' : 'Nothing to sort',
        message: anySeen
          ? 'Reset to run through your library again.'
          : 'Add some titles to your library first.',
        action: anySeen
          ? {
              label: 'Start again',
              onClick: () => {
                actions.resetDiscover();
                queue = [];
                refill();
              },
            }
          : null,
      })
    );
    return;
  }

  controls.hidden = false;
  progress.hidden = false;

  const pct = total ? Math.round((done / total) * 100) : 0;
  progress.querySelector('[data-region="bar"]').style.width = `${pct}%`;
  progress.querySelector('[data-region="left"]').textContent = `${left} to sort`;
  progress.querySelector('[data-region="done"]').textContent = `${done} sorted`;

  /* Render the next card behind the current one so the stack has depth. */
  const next = queue[1] && store.byUid(queue[1]);
  if (next) {
    const back = cardFor(next, false);
    back.style.transform = 'scale(.94) translateY(10px)';
    back.style.opacity = '.55';
    back.setAttribute('aria-hidden', 'true');
    deckEl.appendChild(back);
  }

  const item = store.byUid(queue[0]);
  if (!item) {
    queue.shift();
    render();
    return;
  }
  const card = cardFor(item, true);
  deckEl.appendChild(card);
  teardown = attachGesture(card, item);
}

function cardFor(item, interactive) {
  const card = el('article', { class: 'deck-card', 'aria-label': item.title });
  card.appendChild(poster(item, { lazy: false }));

  if (interactive) {
    card.appendChild(el('div', { class: 'deck-stamp stamp-yes', 'data-stamp': 'watched', text: 'Seen it' }));
    card.appendChild(el('div', { class: 'deck-stamp stamp-no', 'data-stamp': 'skip', text: 'Skip' }));
    card.appendChild(el('div', { class: 'deck-stamp stamp-save', 'data-stamp': 'save', text: 'Watchlist' }));
  }

  const info = el('div', { class: 'deck-info' });
  info.appendChild(el('h2', { class: 'deck-title', text: item.title }));

  const chips = el('div', { class: 'chips' });
  if (item.year) chips.appendChild(el('span', { class: 'chip', text: String(item.year) }));
  if (item.rating) {
    const r = el('span', { class: 'chip chip-rating' });
    r.appendChild(el('span', { html: icon('starFill', 13) }).firstChild);
    r.appendChild(el('span', { text: rating(item.rating) }));
    chips.appendChild(r);
  }
  if (item.runtime) {
    const t = el('span', { class: 'chip' });
    t.appendChild(el('span', { html: icon('clock', 13) }).firstChild);
    t.appendChild(el('span', { text: runtime(item.runtime) }));
    chips.appendChild(t);
  }
  if (item.genre) chips.appendChild(el('span', { class: 'tag', text: item.genre }));
  if (item.quality) chips.appendChild(el('span', { class: 'tag tag-accent', text: item.quality }));
  info.appendChild(chips);

  if (item.overview) info.appendChild(el('p', { class: 'deck-overview', text: item.overview }));

  if (interactive) {
    info.appendChild(
      el(
        'div',
        { style: 'margin-top:14px' },
        button('More about this', {
          kind: 'quiet',
          iconName: 'info',
          size: 'sm',
          block: true,
          onClick: () => openDetail(item.uid),
        })
      )
    );
  }

  card.appendChild(info);
  return card;
}

/* ── gesture ──
   Pointer Events cover mouse, touch and pen with one code path. The old
   version registered four separate touch/mouse handlers and never removed
   them, leaking a listener set per card. */
function attachGesture(card, item) {
  let startX = 0;
  let startY = 0;
  let startT = 0;
  let dx = 0;
  let dy = 0;
  let dragging = false;
  let pointerId = null;

  const stamps = {
    watched: card.querySelector('[data-stamp="watched"]'),
    skip: card.querySelector('[data-stamp="skip"]'),
    save: card.querySelector('[data-stamp="save"]'),
  };

  const onDown = (e) => {
    if (busy || e.button > 0) return;
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
    const rot = dx / 18;
    card.style.transform = `translate(${dx}px, ${dy}px) rotate(${rot}deg)`;

    stamps.watched.style.opacity = dx > 30 ? String(Math.min(1, (dx - 30) / 70)) : '0';
    stamps.skip.style.opacity = dx < -30 ? String(Math.min(1, (-dx - 30) / 70)) : '0';
    stamps.save.style.opacity = dy < -40 && Math.abs(dx) < 60 ? String(Math.min(1, (-dy - 40) / 70)) : '0';
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

    const dt = Math.max(1, performance.now() - startT);
    const vx = dx / dt;
    const vy = dy / dt;

    if (dy < -SWIPE_THRESHOLD && Math.abs(dx) < 80) return commit('save', card);
    if (dx > SWIPE_THRESHOLD || vx > VELOCITY_THRESHOLD) return commit('watched', card);
    if (dx < -SWIPE_THRESHOLD || vx < -VELOCITY_THRESHOLD) return commit('skip', card);

    /* snap back */
    card.style.transform = '';
    Object.values(stamps).forEach((s) => (s.style.opacity = '0'));
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

function commit(action, cardEl) {
  if (busy) return;
  const uid = queue[0];
  const item = uid && store.byUid(uid);
  if (!item) return;
  busy = true;

  const card = cardEl || deckEl.querySelector('.deck-card:last-child');
  if (card) {
    const to =
      action === 'skip'
        ? 'translate(-140%, 40px) rotate(-22deg)'
        : action === 'watched'
          ? 'translate(140%, 40px) rotate(22deg)'
          : 'translateY(-130%) scale(.86)';
    card.style.transition = 'transform .28s cubic-bezier(.22,.61,.36,1), opacity .28s linear';
    card.style.transform = to;
    card.style.opacity = '0';
  }

  const prev = { seen: item.seen, seenAt: item.seenAt, saved: item.saved, watched: item.watched };

  setTimeout(() => {
    store.update(uid, { seen: true, seenAt: Date.now() });
    if (action === 'save') actions.setSaved(uid, true, { silent: true });
    if (action === 'watched') actions.setWatched(uid, true, { silent: true });

    queue.shift();
    busy = false;
    render();

    const label = { skip: 'Skipped', save: 'Added to watchlist', watched: 'Marked watched' }[action];
    toast(`${label} · ${item.title}`, {
      action: 'Undo',
      duration: 2600,
      onAction: () => {
        store.update(uid, prev);
        queue.unshift(uid);
        store.emit('item');
      },
    });
  }, 220);
}

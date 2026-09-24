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
import { attachSwipe, playDecision, FLING_MS } from '../deck.js';
import * as actions from '../actions.js';
import { el, clear, poster, emptyState, button, toast } from '../ui.js';
import { icon } from '../icons.js';
import { runtime, rating } from '../format.js';
import { openDetail } from './detail.js';


let root = null;
let deckEl = null;
let navigate = null;
let queue = [];
let busy = false;
let teardown = null;
/* Which way an undone card left, so it can fly back in the same way. */
let returning = null;
/* A sync that lands while a finger is on the card waits for the finger. */
let holding = false;
let stale = false;

/** The single source of truth for "should this appear in Discover". */
export function isPending(item) {
  return !item.seen && !item.watched;
}

export function initDiscover(opts = {}) {
  navigate = opts.navigate || null;
  root = document.getElementById('screen-discover');
  deckEl = root.querySelector('[data-region="deck"]');

  root.querySelector('[data-action="skip"]').addEventListener('click', () => commit('skip'));
  root.querySelector('[data-action="watched"]').addEventListener('click', () => commit('watched'));

  /* A sync from the other phone emits 'item' every so often, and rebuilding
     the deck then took the card out from under a finger mid-drag. */
  deckEl.addEventListener('pointerdown', () => {
    holding = true;
  });
  const release = () => {
    holding = false;
    if (stale && !busy) refill();
    stale = false;
  };
  deckEl.addEventListener('pointerup', release);
  deckEl.addEventListener('pointercancel', release);

  store.subscribe((r) => {
    if (r !== 'item' || !root.classList.contains('is-active') || busy) return;
    if (holding) {
      stale = true;
      return;
    }
    refill();
  });
}

export function showDiscover() {
  refill();
}

/**
 * Keep the order already dealt and deal anything new in behind it.
 *
 * It used to rebuild only when the queue was empty or a queued title had
 * changed, so titles imported, added or synced after the first visit never
 * reached the deck — and it said "You’ve been through everything" with them
 * sitting unsorted. It also reshuffled the whole deck whenever one queued
 * title changed.
 */
function refill() {
  const pending = store.items().filter(isPending).map((i) => i.uid);
  const live = new Set(pending);
  queue = queue.filter((uid) => live.has(uid));
  const dealt = new Set(queue);
  queue.push(...shuffle(pending.filter((uid) => !dealt.has(uid))));
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
  const hadFocus = root.querySelector('[data-region="controls"]').contains(document.activeElement);
  clear(deckEl);

  const controls = root.querySelector('[data-region="controls"]');
  const progress = root.querySelector('[data-region="progress"]');

  /* Everything out of the deck counts as sorted — the literal inverse of
     isPending(). Counting only unwatched titles meant "Seen it" removed a title
     from both sides at once, so twenty of them in a row left the bar at zero. */
  const all = store.items().length;
  const left = queue.length;
  const done = Math.max(0, all - left);

  if (!left) {
    controls.hidden = true;
    /* The payoff of sorting a whole library: the bar lands at full and the
       count says so, rather than both vanishing in the frame the last card
       goes. */
    if (all) {
      progress.hidden = false;
      progress.querySelector('[data-region="bar"]').style.width = '100%';
      progress.querySelector('[data-region="done"]').textContent = `All ${all} sorted`;
      progress.querySelector('[data-region="left"]').textContent = '';
    } else {
      progress.hidden = true;
    }
    deckEl.appendChild(emptyFor());
    /* The button that had focus has just been hidden; hand focus to whatever
       the empty state offers instead of dropping it on <body>. */
    if (hadFocus) deckEl.querySelector('.empty button')?.focus();
    return;
  }

  controls.hidden = false;
  progress.hidden = false;

  const pct = all ? Math.round((done / all) * 100) : 0;
  progress.querySelector('[data-region="bar"]').style.width = `${pct}%`;
  const meter = progress.querySelector('[data-region="meter"]');
  meter.setAttribute('aria-valuemax', String(all));
  meter.setAttribute('aria-valuenow', String(done));
  meter.setAttribute('aria-valuetext', `${done} of ${all} sorted`);
  progress.querySelector('[data-region="left"]').textContent = `${left} to sort`;
  progress.querySelector('[data-region="done"]').textContent = `${done} sorted`;

  /* The next card sits behind the current one, scaled from its bottom edge so
     it peeks out below whatever the card's height. It carries the same content
     as a front card, so when it rises into place it is already the card that
     lands — a shorter back card used to pop 58px taller at the swap. */
  const next = queue[1] && store.byUid(queue[1]);
  if (next) {
    const back = cardFor(next, false);
    back.style.transform = 'scale(.94) translateY(10px)';
    back.style.opacity = '.55';
    back.setAttribute('aria-hidden', 'true');
    back.inert = true;
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

  /* An undone card flies back in the way it left, rather than reappearing in
     the middle in one frame. .deck-card's own transition carries it home. */
  if (returning) {
    const d = returning === 'right' ? 1 : -1;
    returning = null;
    card.style.transition = 'none';
    card.style.transform = `translate(${d * 140}%, 40px) rotate(${d * 22}deg)`;
    card.style.opacity = '0';
    void card.offsetWidth;
    card.style.transition = '';
    card.style.transform = '';
    card.style.opacity = '';
  }

  teardown = attachSwipe(card, {
    blocked: () => busy,
    onRight: () => commit('watched'),
    onLeft: () => commit('skip'),
  });
}

/* Three different situations. A library where everything is watched used to
   offer "Start again", which reset nothing that could come back and then said
   "Add some titles to your library first" to someone with 500 of them. */
function emptyFor() {
  const all = store.items();
  const unwatched = all.filter((i) => !i.watched).length;
  if (!all.length) {
    return emptyState({
      iconName: 'library',
      title: 'Nothing to sort yet',
      message: 'Add a few films and they will turn up here.',
      action: navigate ? { label: 'Add titles', onClick: () => navigate('add') } : null,
    });
  }
  if (!unwatched) {
    return emptyState({
      iconName: 'check',
      title: 'You’ve seen everything on your shelf',
      message: 'Anything you add will turn up here to sort.',
    });
  }
  return emptyState({
    iconName: 'check',
    title: 'You’ve been through everything',
    message: `Start again to go back through the ${unwatched} you haven’t seen.`,
    action: {
      label: 'Start again',
      haptic: true,
      onClick: () => {
        actions.resetDiscover();
        queue = [];
        refill();
        root.querySelector('[data-action="watched"]')?.focus({ preventScroll: true });
      },
    },
  });
}

function cardFor(item, interactive) {
  const card = el('article', { class: 'deck-card', 'aria-label': item.title });
  card.appendChild(poster(item, { lazy: false }));

  if (interactive) {
    card.appendChild(el('div', { class: 'deck-stamp stamp-yes', 'data-stamp': 'right', text: 'Seen it' }));
    card.appendChild(el('div', { class: 'deck-stamp stamp-no', 'data-stamp': 'left', text: 'Not yet' }));
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

  info.appendChild(
    el(
      'div',
      { class: 'deck-more' },
      button('More about this', {
        kind: 'quiet',
        iconName: 'info',
        size: 'sm',
        block: true,
        onClick: () => openDetail(item.uid),
      })
    )
  );

  card.appendChild(info);
  return card;
}

/* Gesture lives in ../deck.js so the two decks in this app cannot drift apart.
   See the note there. */

function commit(action) {
  if (busy) return;
  const uid = queue[0];
  const item = uid && store.byUid(uid);
  if (!item) return;
  busy = true;

  /* Stamps the card and promotes the one behind it, so tapping the button
     looks like the swipe it stands in for. */
  playDecision(deckEl, action === 'watched' ? 'right' : 'left');

  /* Everything setWatched touches. In a household it writes watchedBy and
     watchedAt too, and restoring only `watched` left the film marked as seen
     by that person after Undo. */
  const prev = {
    seen: item.seen,
    seenAt: item.seenAt,
    watched: item.watched,
    watchedAt: item.watchedAt,
    watchedBy: item.watchedBy,
  };

  setTimeout(() => {
    store.update(uid, { seen: true, seenAt: Date.now() });
    if (action === 'watched') actions.setWatched(uid, true, { silent: true });

    /* By uid, not "whatever is at the front": an Undo landing inside the
       fling used to unshift a card that this then threw away instead. */
    queue = queue.filter((u) => u !== uid);
    busy = false;
    refill();

    const label = { skip: 'Not yet', watched: 'Seen it' }[action];
    toast(`${label} · ${item.title}`, {
      action: 'Undo',
      duration: 2600,
      onAction: () => {
        returning = action === 'watched' ? 'right' : 'left';
        store.update(uid, prev);
        queue = [uid, ...queue.filter((u) => u !== uid)];
        store.emit('item');
      },
    });
  }, FLING_MS);
}

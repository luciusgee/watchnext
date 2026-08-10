/*
 * Tonight's shortlist.
 *
 * Say what you fancy — a genre, a decade, a mood, how long you have — and swipe
 * through a dozen films from your own shelf until one clicks. Then put it on.
 *
 * The defining property, and the reason this is its own screen rather than a
 * flag on Discover: NOTHING HERE WRITES TO THE LIBRARY. Not the constraints,
 * not a yes, not a no, not the shortlist. This module imports the store
 * read-only and there is no path from a swipe to a save. That is deliberate —
 * a picker that quietly edits your library is a picker you stop trusting, and
 * "it doesn't affect your watchlist, it's just a way to pick a film there and
 * then" was the whole brief.
 *
 * It is also why this exists at all. Every swipe-picker on the market deals
 * from a streaming catalogue, which is how you get "my mood: romantic / your
 * recommendation: Sonic the Hedgehog 3". Dealing from five hundred films
 * somebody chose and paid for sets a quality floor no algorithm has to earn.
 */

import * as store from '../store.js';
import { rank, tasteProfile } from '../recommend.js';
import { el, clear, poster, button, emptyState } from '../ui.js';
import { runtime as fmtRuntime } from '../format.js';
import { attachSwipe, flingOut } from '../deck.js';
import { openDetail } from './detail.js';

let root = null;
let deckEl = null;
let metaEl = null;
let navigate = null;

/* Session state. Reset every time the screen is opened fresh, never persisted —
   what you fancied last Tuesday is not a setting. */
let shortlist = [];   // uids, in dealt order
let position = 0;
let teardown = null;
let busy = false;
let relaxed = 0;      // how many times the constraints have been loosened

const constraints = { genre: null, decade: null, mood: null, minutes: null, ownedOnly: true };

const HOW_MANY = 12;

/*
 * Moods.
 *
 * Six entries in a lookup table, and deliberately not a model call. Jinni
 * raised over $5m building an "Entertainment Genome" to do this properly and
 * ended up selling to pay-TV operators; a taxonomy is not where this app wins,
 * and an API round trip to answer "something easy" would be slower and worse
 * than a filter. Each mood nudges genre, length and rating rather than picking
 * films, so it composes with everything else instead of overriding it.
 */
const MOODS = [
  { id: 'tense', label: 'Tense', genres: ['Horror', 'Thriller', 'Crime', 'Mystery'], minRating: 6 },
  { id: 'easy', label: 'Easy watch', genres: ['Comedy', 'Animation', 'Family', 'Adventure'], maxRuntime: 110 },
  { id: 'big', label: 'Big screen', genres: ['Action', 'Sci-Fi', 'Fantasy', 'Adventure'], preferQuality: true },
  { id: 'thinky', label: 'Something with teeth', genres: ['Drama', 'Mystery', 'War', 'Biography'], minRating: 7 },
  { id: 'comfort', label: 'Comfort', genres: ['Comedy', 'Romance', 'Family', 'Animation'], allowRewatch: true },
  { id: 'weird', label: 'Weird', genres: ['Horror', 'Sci-Fi', 'Fantasy', 'Documentary'], minRating: 5.5 },
];

const DECADES = [
  ['2020', '2020s'], ['2010', '2010s'], ['2000', '2000s'],
  ['1990', '90s'], ['1980', '80s'], ['1970', '70s'], ['pre1970', 'Older'],
];

const LENGTHS = [[90, 'Under 90 min'], [120, 'Under 2 hours'], [null, 'Any length']];

export function initPick({ navigate: nav }) {
  navigate = nav;
  root = document.getElementById('screen-pick');
  deckEl = root.querySelector('[data-region="deck"]');
  metaEl = root.querySelector('[data-region="meta"]');

  root.querySelector('[data-action="constraints"]').addEventListener('click', openConstraints);
  root.querySelector('[data-action="no"]').addEventListener('click', () => decide('left'));
  root.querySelector('[data-action="yes"]').addEventListener('click', () => decide('right'));
}

export function showPick(params = {}) {
  /* Arriving fresh deals a new hand; coming back from the detail overlay does
     not, or you would lose your place every time you looked at something. */
  if (params.resume && shortlist.length) {
    render();
    return;
  }
  if (params.mood) constraints.mood = params.mood;
  deal();
}

/* ── dealing ── */

function matching(items, c) {
  let list = items.filter((i) => !i.watched);
  if (c.ownedOnly) list = list.filter((i) => i.owned);
  if (c.genre) list = list.filter((i) => i.genre === c.genre || (i.genres || []).includes(c.genre));
  if (c.decade) {
    list = list.filter((i) => {
      if (!i.year) return false;
      if (c.decade === 'pre1970') return i.year < 1970;
      const from = parseInt(c.decade, 10);
      return i.year >= from && i.year < from + 10;
    });
  }
  const mood = MOODS.find((m) => m.id === c.mood);
  if (mood) {
    list = list.filter((i) => {
      const genres = [i.genre, ...(i.genres || [])].filter(Boolean);
      const fits = genres.some((g) => mood.genres.includes(g));
      const goodEnough = !mood.minRating || !i.rating || i.rating >= mood.minRating;
      return fits && goodEnough;
    });
  }
  return list;
}

/**
 * Deal a shortlist.
 *
 * The seed is random per session, not per day. Tonight's hero pick is stable on
 * purpose — it should not change every time you glance at it — but a shortlist
 * you asked for is the opposite: ask twice and you want a different dozen.
 */
function deal() {
  const all = store.items();
  const mood = MOODS.find((m) => m.id === constraints.mood);
  const pool = matching(all, constraints);

  const ranked = rank(pool, {
    /* Built from the whole library, not the filtered pool — see rank(). */
    profile: tasteProfile(all),
    seed: `pick-${Math.random().toString(36).slice(2)}`,
    limit: HOW_MANY,
    ownedOnly: false,        // already applied above, against the real field
    allowRewatch: mood?.allowRewatch ?? false,
    maxRuntime: constraints.minutes || mood?.maxRuntime || null,
  });

  shortlist = ranked.map((r) => r.item.uid);
  position = 0;
  render();
}

/** Loosen exactly one constraint, in the order that costs the least. */
function relaxOnce() {
  const order = ['decade', 'mood', 'genre', 'minutes'];
  for (const key of order) {
    if (constraints[key]) {
      constraints[key] = null;
      relaxed += 1;
      return key;
    }
  }
  if (constraints.ownedOnly) {
    constraints.ownedOnly = false;
    relaxed += 1;
    return 'ownedOnly';
  }
  return null;
}

/* ── render ── */

function summary() {
  const bits = [];
  const mood = MOODS.find((m) => m.id === constraints.mood);
  if (mood) bits.push(mood.label.toLowerCase());
  if (constraints.genre) bits.push(constraints.genre.toLowerCase());
  if (constraints.decade) {
    bits.push(DECADES.find(([v]) => v === constraints.decade)?.[1].toLowerCase() || '');
  }
  if (constraints.minutes) bits.push(`under ${constraints.minutes} min`);
  const real = bits.filter(Boolean);
  /* "on your shelf" on its own reads like a fragment, so it only joins the list
     once there is something for it to qualify. */
  if (!real.length) return constraints.ownedOnly ? 'anything on your shelf' : 'anything you have not seen';
  if (constraints.ownedOnly) real.push('on your shelf');
  return real.join(' · ');
}

function render() {
  clear(deckEl);
  if (teardown) {
    teardown();
    teardown = null;
  }

  const controls = root.querySelector('[data-region="controls"]');
  metaEl.textContent = summary();

  const remaining = shortlist.slice(position);

  if (!remaining.length) {
    controls.hidden = true;
    deckEl.appendChild(exhausted());
    return;
  }

  controls.hidden = false;

  const next = remaining[1] && store.byUid(remaining[1]);
  if (next) {
    const back = cardFor(next, false);
    back.style.transform = 'scale(.94) translateY(10px)';
    back.style.opacity = '.55';
    back.setAttribute('aria-hidden', 'true');
    deckEl.appendChild(back);
  }

  const item = store.byUid(remaining[0]);
  if (!item) {
    /* Deleted from another screen while the hand was open. */
    position += 1;
    render();
    return;
  }

  const card = cardFor(item, true);
  deckEl.appendChild(card);
  teardown = attachSwipe(card, {
    blocked: () => busy,
    onRight: () => decide('right'),
    onLeft: () => decide('left'),
  });
}

function exhausted() {
  const canRelax = constraints.genre || constraints.decade || constraints.mood ||
    constraints.minutes || constraints.ownedOnly;

  /* Never a dead end. Running out means the constraints were too tight, and the
     answer to that is to offer the next-widest hand rather than an apology. */
  return emptyState({
    iconName: 'discover',
    title: shortlist.length ? 'That is the lot' : 'Nothing matches that',
    message: shortlist.length
      ? 'You have been through all of them. Widen it a little and there will be more.'
      : 'Nothing on your shelf fits all of that at once.',
    action: {
      label: canRelax ? 'Widen it a bit' : 'Start again',
      onClick: () => {
        if (canRelax && relaxOnce()) {
          deal();
          return;
        }
        relaxed = 0;
        deal();
      },
    },
  });
}

function cardFor(item, interactive) {
  const card = el('article', { class: 'deck-card', 'aria-label': item.title });
  card.appendChild(poster(item, { lazy: false }));

  if (interactive) {
    card.appendChild(el('div', { class: 'deck-stamp stamp-yes', 'data-stamp': 'right', text: 'That one' }));
    card.appendChild(el('div', { class: 'deck-stamp stamp-no', 'data-stamp': 'left', text: 'Not tonight' }));
  }

  const info = el('div', { class: 'deck-info' });
  info.appendChild(el('h2', { class: 'deck-title', text: item.title }));

  const chips = el('div', { class: 'chips' });
  if (item.year) chips.appendChild(el('span', { class: 'chip', text: String(item.year) }));
  if (item.runtime) chips.appendChild(el('span', { class: 'chip', text: fmtRuntime(item.runtime) }));
  if (item.genre) chips.appendChild(el('span', { class: 'chip', text: item.genre }));
  if (item.quality) chips.appendChild(el('span', { class: 'chip', text: item.quality }));
  if (item.rating) chips.appendChild(el('span', { class: 'chip', text: `★ ${item.rating.toFixed(1)}` }));
  info.appendChild(chips);

  card.appendChild(info);
  return card;
}

/* ── decisions ──
   Both of them move the position and nothing else. There is no store call in
   this function on purpose; see the note at the top of the file. */

function decide(direction) {
  if (busy) return;
  const uid = shortlist[position];
  const item = uid && store.byUid(uid);
  if (!item) return;

  busy = true;
  const card = deckEl.lastElementChild;
  if (card && card.classList.contains('deck-card')) flingOut(card, direction);

  setTimeout(() => {
    busy = false;
    if (direction === 'right') {
      /* Yes means put it on: open the film. The hand is left exactly where it
         was, so closing the detail returns you to the same card rather than a
         fresh shuffle. */
      render();
      openDetail(uid);
      return;
    }
    position += 1;
    render();
  }, 220);
}

/* ── the constraint sheet ──
   Hand-rolled rather than openSheet(), which only takes a title, a message and
   a row of buttons. Library's filter sheet does the same thing for the same
   reason; this follows that pattern deliberately so there is one way to build a
   sheet with real content in it, not two. */

function openConstraints() {
  const scrim = el('div', { class: 'scrim is-open' });
  const panel = el('div', {
    class: 'sheet is-open',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': 'What do you fancy?',
    style: 'max-height:84vh;overflow-y:auto',
  });

  const close = () => {
    scrim.remove();
    panel.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);
  scrim.addEventListener('click', close);

  panel.appendChild(el('div', { class: 'sheet-grip' }));
  panel.appendChild(el('div', { class: 'sheet-title', text: 'What do you fancy?' }));

  const facet = (label, options, key) => {
    const box = el('div', { style: 'margin-bottom:20px' });
    box.appendChild(el('div', { class: 'eyebrow', style: 'margin-bottom:10px', text: label }));
    const wrap = el('div', { style: 'display:flex;flex-wrap:wrap;gap:8px' });
    for (const [value, text] of options) {
      const active = constraints[key] === value;
      wrap.appendChild(
        el('button', {
          class: 'pill',
          type: 'button',
          'aria-pressed': String(active),
          text,
          onclick: () => {
            constraints[key] = active ? null : value;
            close();
            openConstraints();
          },
        })
      );
    }
    box.appendChild(wrap);
    return box;
  };

  panel.appendChild(facet('Mood', MOODS.map((m) => [m.id, m.label]), 'mood'));

  const genres = store.genresInUse().slice(0, 12);
  if (genres.length) panel.appendChild(facet('Genre', genres.map((g) => [g, g]), 'genre'));

  panel.appendChild(facet('Decade', DECADES, 'decade'));
  panel.appendChild(facet('How long', LENGTHS, 'minutes'));

  const ownedBox = el('div', { style: 'margin-bottom:20px' });
  ownedBox.appendChild(el('div', { class: 'eyebrow', style: 'margin-bottom:10px', text: 'Where from' }));
  ownedBox.appendChild(
    el('button', {
      class: 'pill',
      type: 'button',
      'aria-pressed': String(constraints.ownedOnly),
      text: 'Only what I own',
      onclick: () => {
        constraints.ownedOnly = !constraints.ownedOnly;
        close();
        openConstraints();
      },
    })
  );
  panel.appendChild(ownedBox);

  /* A live count, because the failure mode of a constraint sheet is stacking
     four filters and finding out afterwards that nothing survives them. */
  const count = matching(store.items(), constraints).length;
  panel.appendChild(
    el('div', {
      style: `font-size:var(--t-sub);color:${count ? 'var(--ash)' : 'var(--ember)'};margin-bottom:14px`,
      text: count
        ? `${count} film${count === 1 ? '' : 's'} to deal from`
        : 'Nothing on your shelf matches all of that',
    })
  );

  const acts = el('div', { class: 'sheet-actions' });
  acts.appendChild(
    button('Deal me some', {
      kind: 'primary',
      block: true,
      onClick: () => {
        close();
        relaxed = 0;
        deal();
      },
    })
  );
  acts.appendChild(button('Close', { kind: 'quiet', block: true, onClick: close }));
  panel.appendChild(acts);

  document.body.appendChild(scrim);
  document.body.appendChild(panel);
  requestAnimationFrame(() => panel.querySelector('button')?.focus());
}

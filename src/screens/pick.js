/*
 * Tonight's shortlist.
 *
 * Say what you fancy — in words, or with chips, or both — and swipe through a
 * dozen films from your own shelf until one clicks. Then put it on.
 *
 * The defining property, and the reason this is its own screen rather than a
 * flag on Discover: NOTHING HERE WRITES TO THE LIBRARY. Not the constraints,
 * not a yes, not a no, not the shortlist, not the model's answer. This module
 * imports the store read-only and there is no path from a swipe to a save. That
 * is deliberate — a picker that quietly edits your library is a picker you stop
 * trusting, and "it doesn't affect your watchlist, it's just a way to pick a
 * film there and then" was the whole brief.
 *
 * It is also why this exists at all. Every swipe-picker on the market deals
 * from a streaming catalogue, which is how you get "my mood: romantic / your
 * recommendation: Sonic the Hedgehog 3". Dealing from five hundred films
 * somebody chose and paid for sets a quality floor no algorithm has to earn.
 *
 * Two ways to fill the deck, and they compose rather than compete:
 *
 *  · The chips — mood, genre, decade, length — are a filter and a local rank.
 *    Instant, works on a train, costs nothing.
 *  · The box — "horror in the vein of Ari Aster", "a heist film that isn't too
 *    long" — narrows by the chips first and then hands what survives to Claude,
 *    which reads it with actual knowledge of cinema rather than genre labels.
 *    That is the part no filter can do: nothing in a row of metadata knows that
 *    Hereditary and The Wicker Man belong in the same hand.
 *
 * If the second one fails for any reason — no key, no signal, a rate limit —
 * it falls back to the first and says why. Standing on a rug in front of the
 * telly is not the moment to be shown an error and nothing else.
 */

import * as store from '../store.js';
import * as ai from '../ai.js';
import { rank, tasteProfile } from '../recommend.js';
import { el, clear, poster, button, emptyState, toast, openPanel } from '../ui.js';
import { icon } from '../icons.js';
import { runtime as fmtRuntime, rating as fmtRating } from '../format.js';
import { attachSwipe, playDecision, FLING_MS } from '../deck.js';
import { openDetail } from './detail.js';

let root = null;
let deckEl = null;
let metaEl = null;
let navigate = null;

/* Session state. Reset every time the screen is opened fresh, never persisted —
   what you fancied last Tuesday is not a setting. */
let shortlist = [];        // uids, in dealt order
let position = 0;
let teardown = null;
let busy = false;
let relaxed = 0;           // how many times the constraints have been loosened
let brief = '';            // the words, when there were any
let note = '';             // Claude's one line about the hand
let reasons = new Map();   // uid → why this one, from Claude
let loading = false;
/* Bumped on every ask. A reply whose token is stale lost a race with a later
   one and is dropped — otherwise asking twice in quick succession can leave you
   looking at the answer to the question you changed your mind about. */
let askToken = 0;

const constraints = { genre: null, decade: null, mood: null, minutes: null, ownedOnly: true, seen: false };

const HOW_MANY = 12;

/*
 * How many titles go to the model.
 *
 * A shelf of five hundred is about eight thousand tokens of input, which is
 * pennies and well inside every context window here — so the cap is not really
 * about cost. It is a ceiling on a library that grows without bound, and it is
 * set high enough that a real collection goes over in full rather than being
 * pre-filtered by a local scorer that has never heard of Ari Aster.
 */
const MAX_FOR_CLAUDE = 400;

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

/* Tappable rather than placeholder text, because the box does something no
   search field does and nobody discovers that from a grey hint they scroll
   past. Naming a film the shelf may not contain is the point: the answer comes
   from the shelf either way. */
const EXAMPLES = [
  'Like Blade Runner',
  'Short and funny',
  'Sunday afternoon',
];

export function initPick({ navigate: nav }) {
  navigate = nav;
  root = document.getElementById('screen-pick');
  deckEl = root.querySelector('[data-region="deck"]');
  metaEl = root.querySelector('[data-region="meta"]');

  root.querySelector('[data-action="constraints"]').addEventListener('click', () => openPickSheet());
  root.querySelector('[data-action="no"]').addEventListener('click', () => decide('left'));
  root.querySelector('[data-action="yes"]').addEventListener('click', () => decide('right'));
}

export function showPick(params = {}) {
  /* Arriving fresh deals a new hand; resuming shows what is already there and
     re-deals nothing. Authoritative rather than conditional on a hand existing:
     the sheet navigates here the moment a request starts, and at that instant
     there is no hand yet — a condition that fell through to deal() would race a
     local shuffle against the answer being fetched. */
  if (params.resume) {
    render();
    return;
  }
  if (params.mood) constraints.mood = params.mood;
  /* Straight to the sheet rather than to a hand nobody asked for. Landing on a
     deck dealt from whatever was set last time is how you end up swiping
     through the answer to a question you asked on Tuesday. */
  if (params.ask) {
    render();
    openPickSheet();
    return;
  }
  deal();
}

/* ── dealing ── */

function matching(items, c) {
  const muted = store.tastePrefs();
  const person = store.viewer();
  /* Unwatched by the person being answered for, not by the household — a film
     his partner has seen and he has not is a candidate for his evening. */
  let list = c.seen ? items.slice() : items.filter((i) => !store.seenBy(i, person));
  /* Applied here as well as in the scorer so the "N films to deal from" count
     in the sheet is the truth. Counting films the deck will then refuse to deal
     is worse than no count. */
  list = list.filter((i) => {
    if (muted.never.includes(i.uid)) return false;
    if (i.genre && muted.genres.includes(i.genre)) return false;
    const title = String(i.title || '').toLowerCase();
    return !muted.franchises.some((f) => f && title.includes(String(f).toLowerCase()));
  });
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
  /* Length lives here too, not only in the scorer, for the same reason as the
     rest: the count in the sheet has to describe the hand you will actually be
     dealt. Unknown runtimes survive, matching rank(). */
  const cap = c.minutes || mood?.maxRuntime || null;
  if (cap) list = list.filter((i) => !i.runtime || i.runtime <= cap);
  return list;
}

/**
 * Deal a shortlist locally.
 *
 * The seed is random per session, not per day. Tonight's hero pick is stable on
 * purpose — it should not change every time you glance at it — but a shortlist
 * you asked for is the opposite: ask twice and you want a different dozen.
 */
function deal() {
  /* Supersedes any ask still in flight, so "Deal me some" during a slow request
     is not quietly undone when the reply arrives. */
  askToken += 1;
  const all = store.items();
  const mood = MOODS.find((m) => m.id === constraints.mood);
  const pool = matching(all, constraints);

  const person = store.viewer();
  const ranked = rank(pool, {
    viewerSeen: person ? new Set(all.filter((i) => store.seenBy(i, person)).map((i) => i.uid)) : null,
    /* Built from the whole library, not the filtered pool — see rank(). */
    profile: tasteProfile(all),
    muted: store.tastePrefs(),
    seed: `pick-${Math.random().toString(36).slice(2)}`,
    limit: HOW_MANY,
    ownedOnly: false,        // already applied above, against the real field
    allowRewatch: constraints.seen || (mood?.allowRewatch ?? false),
    maxRuntime: constraints.minutes || mood?.maxRuntime || null,
  });

  shortlist = ranked.map((r) => r.item.uid);
  position = 0;
  brief = '';
  note = '';
  reasons = new Map();
  loading = false;
  render();
}

/**
 * Deal a shortlist Claude chose.
 *
 * The chips narrow first and the model reads what survives, so "under two
 * hours" is enforced by code rather than asked for politely in a prompt. Every
 * uid that comes back was in the pool that went out; a number outside the range
 * is dropped in ai.js rather than resolved to some other film.
 */
async function dealFromBrief(text) {
  const token = ++askToken;
  const all = store.items();
  let pool = matching(all, constraints);

  if (!pool.length) {
    shortlist = [];
    position = 0;
    brief = text;
    note = '';
    reasons = new Map();
    loading = false;
    render();
    return;
  }

  if (pool.length > MAX_FOR_CLAUDE) {
    const person = store.viewer();
    pool = rank(pool, {
      viewerSeen: person ? new Set(all.filter((i) => store.seenBy(i, person)).map((i) => i.uid)) : null,
      profile: tasteProfile(all),
      muted: store.tastePrefs(),
      limit: MAX_FOR_CLAUDE,
      ownedOnly: false,
      allowRewatch: true,
    }).map((r) => r.item);
  }

  brief = text;
  note = '';
  reasons = new Map();
  shortlist = [];
  position = 0;
  loading = true;
  render();

  try {
    const out = await ai.chooseFromShelf(text, pool, { want: HOW_MANY });
    if (token !== askToken) return; // a later ask has taken over
    loading = false;
    note = out.note;
    reasons = new Map(out.picks.filter((p) => p.why).map((p) => [p.item.uid, p.why]));
    shortlist = out.picks.map((p) => p.item.uid);
    position = 0;
    if (!shortlist.length && !note) {
      note = 'Claude could not find anything on your shelf for that.';
    }
    render();
  } catch (err) {
    if (token !== askToken) return;
    /* Never a dead end. Fall back to the chips, which is the hand the same
       request would have produced before any of this existed, and say plainly
       why it is not the one that was asked for. */
    const why = ai.friendlyError(err);
    toast(why);
    deal();
    /* deal() clears brief and note, so without putting the reason back the
       meta line silently reverted to "anything on your shelf" and the only
       trace of the failure was a toast gone in three seconds. */
    note = `${why} Here is the closest hand the filters can make.`;
    render();
  }
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
  if (!constraints.seen) {
    constraints.seen = true;
    relaxed += 1;
    return 'seen';
  }
  return null;
}

/* ── render ── */

function summary() {
  if (brief) return `“${brief}”`;
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

  clear(metaEl);
  metaEl.appendChild(el('span', { text: summary() }));
  if (note) {
    metaEl.appendChild(
      el('span', {
        style: 'display:block;margin-top:6px;color:var(--silver)',
        text: note,
      })
    );
  }

  if (loading) {
    /* Not `hidden`: display:none takes ~94px out of a place-items:center
       column, so the waiting card sat half a button-row below where the real
       card lands and the deck jumped when the answer arrived. */
    controls.classList.add('is-idle');
    deckEl.appendChild(thinking());
    return;
  }

  const remaining = shortlist.slice(position);

  if (!remaining.length) {
    controls.classList.add('is-idle');
    deckEl.appendChild(exhausted());
    return;
  }

  controls.classList.remove('is-idle');

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

/* A card-shaped wait rather than a spinner in the middle of an empty screen —
   the deck is about to appear here and the placeholder says so. */
function thinking() {
  /* role=status so the change is actually announced — aria-busy on a
     non-live element says nothing to anyone. */
  const card = el('article', {
    class: 'deck-card is-thinking',
    role: 'status',
    'aria-live': 'polite',
  });
  const inner = el('div', {
    style:
      'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;' +
      'justify-content:center;gap:14px;padding:32px;text-align:center',
  });
  inner.appendChild(el('span', { html: icon('sparkle', 28) }).firstChild);
  inner.appendChild(
    el('div', {
      style: 'font-size:var(--t-body);color:var(--silver);line-height:1.5',
      text: 'Reading your shelf…',
    })
  );
  inner.appendChild(
    el('div', {
      class: 'chat-dots',
      /* .chat-dots is built for a left-aligned chat thread. */
      style: 'align-self:center;padding:0',
      /* Decorative: "Reading your shelf…" above it is the announcement, and
         aria-label on a plain div reaches nobody anyway. */
      'aria-hidden': 'true',
    }, [el('i'), el('i'), el('i')])
  );
  card.appendChild(inner);
  return card;
}

function exhausted() {
  const canRelax =
    constraints.genre || constraints.decade || constraints.mood ||
    constraints.minutes || constraints.ownedOnly || !constraints.seen;

  const askedFor = Boolean(brief);
  const emptyHand = !shortlist.length;

  /* Never a dead end. Running out means the ask was too tight, and the answer
     to that is to offer the next-widest hand rather than an apology. */
  return emptyState({
    iconName: askedFor ? 'sparkle' : 'discover',
    title: emptyHand ? 'Nothing matches that' : 'That is the lot',
    message: emptyHand
      ? askedFor
        ? 'Nothing on your shelf fits that and the filters you have on at the same time.'
        : 'Nothing on your shelf fits all of that at once.'
      : askedFor
        ? 'You have been through all twelve. Ask for something else and there will be a new dozen.'
        : 'You have been through all of them. Widen it a little and there will be more.',
    action: {
      label: askedFor ? 'Ask for something else' : canRelax ? 'Widen it a bit' : 'Start again',
      onClick: () => {
        if (askedFor) {
          openPickSheet();
          return;
        }
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

  /* Identical to the Discover deck's chip row, in the same order. The two
     decks share .deck-card and read as the same component, then rendered the
     same five facts in three different styles — a bare ★ glyph against an
     amber icon, borderless chips against bordered tags. */
  const chips = el('div', { class: 'chips' });
  if (item.year) chips.appendChild(el('span', { class: 'chip', text: String(item.year) }));
  if (item.rating) {
    const r = el('span', { class: 'chip chip-rating' });
    r.appendChild(el('span', { html: icon('starFill', 13) }).firstChild);
    r.appendChild(el('span', { text: fmtRating(item.rating) }));
    chips.appendChild(r);
  }
  if (item.runtime) {
    const t = el('span', { class: 'chip' });
    t.appendChild(el('span', { html: icon('clock', 13) }).firstChild);
    t.appendChild(el('span', { text: fmtRuntime(item.runtime) }));
    chips.appendChild(t);
  }
  if (item.genre) chips.appendChild(el('span', { class: 'tag', text: item.genre }));
  if (item.quality) chips.appendChild(el('span', { class: 'tag tag-accent', text: item.quality }));
  info.appendChild(chips);

  /* Why this one, when there is a reason. Text, never markup — this is the one
     string on the card that came out of a model. */
  const why = reasons.get(item.uid);
  if (why) {
    info.appendChild(
      el('p', {
        class: 'deck-why',
        text: why,
      })
    );
  }

  card.appendChild(info);
  return card;
}

/* ── decisions ──
   Both of them move the position and nothing else. There is no store call in
   this function on purpose; see the note at the top of the file. */

function decide(direction) {
  if (busy || loading) return;
  const uid = shortlist[position];
  const item = uid && store.byUid(uid);
  if (!item) return;

  busy = true;
  /* The same decision as a swipe, so it gets the same stamp and the same
     promotion of the card behind — tapping the button used to just fling the
     card with no label at all. */
  playDecision(deckEl, direction);

  setTimeout(() => {
    busy = false;
    if (direction === 'right') {
      /* Yes means put it on: open the film. The hand is left exactly where it
         was, so closing the detail returns you to the same card rather than a
         fresh shuffle — but the overlay has to cover the deck first, or the
         card that was just flung snaps back into view behind detailIn. */
      openDetail(uid);
      setTimeout(render, 260);
      return;
    }
    position += 1;
    render();
  }, FLING_MS);
}

/* ── the sheet ──
   Hand-rolled rather than openSheet(), which only takes a title, a message and
   a row of buttons. Library's filter sheet does the same thing for the same
   reason; this follows that pattern deliberately so there is one way to build a
   sheet with real content in it, not two.

   Exported because the button that matters is on Tonight, next to the pick it
   is offering an alternative to — that is where somebody is standing when they
   decide they want something else, not two taps into a screen they have to
   know exists. */

export function openPickSheet() {
  /* --kb so a tall sheet is not pushed off the top when the keyboard, which
     this sheet summons, takes the bottom of the screen. */
  const { panel, close, show } = openPanel({
    label: 'What do you fancy?',
    className: 'has-pinned',
    style: 'max-height:calc(86vh - var(--kb, 0px));overflow-y:auto',
  });

  /* Toggling a chip refreshes the count and nothing else. This used to close
     and rebuild the whole sheet, which reset its scrollTop — so tapping the
     last pill in the list threw you back to the title every time. */
  let refreshCount = () => {};
  const reopen = () => refreshCount();

  panel.appendChild(el('div', { class: 'sheet-grip' }));
  panel.appendChild(el('div', { class: 'sheet-title', text: 'What do you fancy?' }));

  /* ── the box ── */

  const input = el('textarea', {
    id: 'pick-brief',
    class: 'input',
    rows: '2',
    placeholder: 'Horror in the vein of Ari Aster…',
    'aria-label': 'Describe what you fancy',
    style: 'resize:none;line-height:1.45;min-height:64px',
  });
  panel.appendChild(input);

  /* Lighter than the facet pills below, but the same size: these were 29px
     against their 44px, in the same sheet, and were the hardest thing in the
     app to hit. Weight and colour carry the difference instead. */
  const examples = el('div', {
    style: 'display:flex;flex-wrap:wrap;gap:var(--s2);margin:var(--s3) 0 var(--s4)',
  });
  for (const text of EXAMPLES) {
    examples.appendChild(
      el('button', {
        class: 'pill',
        type: 'button',
        style: 'font-weight:500;color:var(--ash)',
        text,
        onclick: () => {
          input.value = text;
          input.focus();
        },
      })
    );
  }
  panel.appendChild(examples);

  const ask = () => {
    const text = input.value.trim();
    if (!text) {
      toast('Say what you fancy first');
      input.focus();
      return;
    }
    if (!ai.hasKey()) {
      close();
      navigate('settings', { focus: 'ai' });
      return;
    }
    close();
    relaxed = 0;
    /* Started before the navigation, not after: everything in dealFromBrief up
       to its first await runs synchronously, so the deck is already in its
       waiting state by the time the screen is shown. The other order shows an
       empty deck for a frame. */
    dealFromBrief(text);
    goToDeck();
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      ask();
    }
  });

  panel.appendChild(
    button(ai.hasKey() ? 'Ask Claude' : 'Connect a key to ask', {
      kind: 'primary',
      block: true,
      iconName: 'sparkle',
      onClick: ask,
    })
  );
  panel.appendChild(
    el('div', {
      style: 'font-size:var(--t-sub);color:var(--ash);margin:var(--s2) 0 var(--s5);line-height:1.5',
      text: ai.hasKey()
        ? 'Claude reads the titles that get through the filters below and picks from those.'
        : 'An Anthropic key, kept on this device, lets Claude read your shelf and answer in film terms rather than genre labels.',
    })
  );

  /* ── the chips ── */

  panel.appendChild(
    el('div', {
      class: 'eyebrow',
      style: 'margin-bottom:var(--s3);padding-top:var(--s4);border-top:1px solid var(--hairline)',
      text: 'Or narrow it down',
    })
  );

  const facet = (label, options, key) => {
    const box = el('div', { style: 'margin-bottom:var(--s5)' });
    box.appendChild(el('div', { class: 'eyebrow', style: 'margin-bottom:var(--s3)', text: label }));
    const wrap = el('div', { style: 'display:flex;flex-wrap:wrap;gap:var(--s2)' });
    for (const [value, text] of options) {
      wrap.appendChild(
        el('button', {
          class: 'pill',
          type: 'button',
          'aria-pressed': String(constraints[key] === value),
          text,
          onclick: (e) => {
            constraints[key] = constraints[key] === value ? null : value;
            /* One of a set, so clear the row and re-press the one that won. */
            for (const p of wrap.children) p.setAttribute('aria-pressed', 'false');
            e.currentTarget.setAttribute('aria-pressed', String(constraints[key] === value));
            reopen();
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

  const whereBox = el('div', { style: 'margin-bottom:var(--s5)' });
  whereBox.appendChild(
    el('div', { class: 'eyebrow', style: 'margin-bottom:var(--s3)', text: 'Where from' })
  );
  const whereRow = el('div', { style: 'display:flex;flex-wrap:wrap;gap:var(--s2)' });
  const flag = (label, key) =>
    el('button', {
      class: 'pill',
      type: 'button',
      'aria-pressed': String(constraints[key]),
      text: label,
      onclick: (e) => {
        constraints[key] = !constraints[key];
        e.currentTarget.setAttribute('aria-pressed', String(constraints[key]));
        reopen();
      },
    });
  whereRow.appendChild(flag('Only what I own', 'ownedOnly'));
  /* Previously reachable only by choosing the Comfort mood, which nobody could
     have guessed. A rewatch is a normal thing to want on a Sunday. */
  whereRow.appendChild(flag('Include things I’ve seen', 'seen'));
  whereBox.appendChild(whereRow);
  panel.appendChild(whereBox);

  /* A live count, because the failure mode of a constraint sheet is stacking
     four filters and finding out afterwards that nothing survives them. It
     counts for both paths: this is also the set Claude gets to read. */
  /* The count and the deal ride the bottom edge of the sheet. Five facet rows
     down, they used to be below the fold — so the thing that answers "does
     anything survive these filters" was out of sight while you tapped them. */
  const acts = el('div', { class: 'sheet-actions is-pinned' });
  const countEl = el('div', {
    style: 'font-size:var(--t-sub);text-align:center;margin-bottom:var(--s1)',
    'aria-live': 'polite',
  });
  acts.appendChild(countEl);
  const dealBtn = button('Deal me some', {
    kind: 'secondary',
    onClick: () => {
      close();
      relaxed = 0;
      deal();
      goToDeck();
    },
  });
  acts.appendChild(
    el('div', { class: 'btn-pair' }, [button('Close', { kind: 'quiet', onClick: close }), dealBtn])
  );
  panel.appendChild(acts);

  refreshCount = () => {
    const n = matching(store.items(), constraints).length;
    countEl.style.color = n ? 'var(--ash)' : 'var(--ember)';
    countEl.textContent = n
      ? `${n} film${n === 1 ? '' : 's'} to choose from`
      : 'Nothing on your shelf matches all of that';
    /* Offering the deal when the sheet has just said nothing survives the
       filters only takes you to a deck that says it again. */
    dealBtn.disabled = n === 0;
  };
  refreshCount();

  show();
  requestAnimationFrame(() => input.focus({ preventScroll: true }));
}

/* Harmless when the deck is already the screen you are on — showPick resumes
   rather than re-dealing, so this never costs you the hand you just asked
   for. */
function goToDeck() {
  if (navigate) navigate('pick', { resume: true });
}

/*
 * Library.
 *
 * Two changes of substance from the old version: filtering is one control with
 * four independent facets rather than two rows that pretend to be one, and the
 * list renders in chunks so a 500-title library doesn't rebuild 500 DOM
 * subtrees on every keystroke.
 */

import * as store from '../store.js';
import {
  el,
  clear,
  poster,
  posterBadge,
  emptyState,
  openSheet,
  button,
  toast,
  confirmDestructive,
  reveal,
  openPanel,
} from '../ui.js';
import { icon } from '../icons.js';
import { runtime, rating, metaLine } from '../format.js';
import { openDetail } from './detail.js';
import { encodeShelf, canShare, MAX_TITLES } from '../share.js';
import { cardFor } from './tonight.js';

const CHUNK = 40;

let root = null;
let listEl = null;
let navigate = null;
let observer = null;

const state = {
  query: '',
  /* What was typed, for quoting back. `query` is folded for matching, and
     echoing that meant "Blade Runner" came back as "blade runner" directly
     under the field that still said "Blade Runner". */
  queryRaw: '',
  type: 'all', // all | movie | tv
  genre: null,
  quality: null, // 4K | 1080p | owned
  status: null, // watched | unwatched | pile
  /* Multi-select. A Set of uids, empty when not in selection mode — the mode is
     "is anything selected", so there is no separate flag to get out of step. */
  picked: new Set(),
  sort: 'title', // title | year | rating | added | runtime
  view: 'list', // list | grid
  rendered: 0,
  results: [],
  /* Whether the list is currently laid out as a grid. Derived in render() and
     read by appendChunk(), so the container and its children can never
     disagree — they used to, and selecting then switching view packed
     full-width rows into 111px grid cells. */
  asGrid: false,
};

export function initLibrary({ navigate: nav }) {
  navigate = nav;
  root = document.getElementById('screen-library');
  listEl = root.querySelector('[data-region="list"]');
  state.view = store.settings().libraryView || 'list';

  const search = root.querySelector('#library-search');
  let debounce;
  search.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      state.queryRaw = search.value.trim();
      state.query = fold(state.queryRaw);
      render();
    }, 140);
  });

  /* The keyboard's "search" key. Results are already live, so all it has to do
     is put the keyboard away — it did nothing, and the tab bar stayed hidden
     under a keyboard that would not leave. */
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      search.blur();
    }
  });

  root.querySelector('[data-action="filter"]').addEventListener('click', openFilters);
  root.querySelector('[data-action="view"]').addEventListener('click', toggleView);
  root.querySelector('[data-action="sort"]').addEventListener('click', openSort);

  /* Infinite scroll sentinel — cheaper and smoother than rendering everything. */
  const sentinel = root.querySelector('[data-region="sentinel"]');
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting) && state.rendered < state.results.length) {
        appendChunk();
      }
    },
    { root: root.querySelector('.scroll'), rootMargin: '400px' }
  );
  observer.observe(sentinel);

  /* keep: a change to one title — watched from the detail overlay, a bulk
     action — should not throw the list back to the top. */
  store.subscribe((r) => {
    if (r === 'item' && root.classList.contains('is-active')) render({ keep: true });
  });
}

export function showLibrary(params = {}) {
  if (params.filter === 'pile') {
    state.status = 'pile';
    state.query = '';
    state.queryRaw = '';
    root.querySelector('#library-search').value = '';
  }
  if (params.filter === 'owned') state.quality = 'owned';
  /* "Sam added 12 films": the newest first, all of them, from the top. */
  if (params.sort === 'added') {
    state.sort = 'added';
    state.status = null;
    state.quality = null;
    state.genre = null;
    state.type = 'all';
    state.query = '';
    state.queryRaw = '';
    root.querySelector('#library-search').value = '';
  }
  /* Rebuilt to the depth that was showing, so the scroll offset main.js
     restores has rows under it. A 40-row rebuild clamped a return from row
     300 to about row 30. A new filter still starts from the top. */
  render({ keep: !params.filter && !params.sort });
  /* From the top, not where the list was left. */
  return params.sort ? 'fresh' : null;
}

/* ── filtering ── */

/* Accents and ampersands folded, as the iPhone keyboard types without them:
   "amelie" found nothing in a library with Amélie in it, and "fast and furious"
   missed Fast & Furious. */
const fold = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, 'and')
    .toLowerCase();

function compute() {
  let list = store.items();

  if (state.query) {
    const q = state.query;
    list = list.filter(
      (i) =>
        fold(i.title).includes(q) ||
        (i.genre && fold(i.genre).includes(q)) ||
        (i.year && String(i.year).includes(q))
    );
  }
  if (state.type !== 'all') list = list.filter((i) => i.type === state.type);
  /* Any of a title's genres, as the picker matches — Alien is displayed as
     Horror, and the Sci-Fi filter used to leave it out while the picker's
     Sci-Fi put it in. */
  if (state.genre) list = list.filter((i) => i.genre === state.genre || (i.genres || []).includes(state.genre));
  if (state.quality === 'owned') list = list.filter((i) => i.owned);
  else if (state.quality) list = list.filter((i) => i.quality === state.quality);
  if (state.status === 'watched') list = list.filter((i) => i.watched);
  else if (state.status === 'unwatched') list = list.filter((i) => !i.watched);
  else if (state.status === 'pile') list = list.filter((i) => i.owned && !i.watched);

  const cmp = {
    title: (a, b) => a.sortTitle.localeCompare(b.sortTitle),
    year: (a, b) => (b.year || 0) - (a.year || 0),
    rating: (a, b) => (b.rating || 0) - (a.rating || 0),
    added: (a, b) => (b.addedAt || 0) - (a.addedAt || 0),
    runtime: (a, b) => (a.runtime || 9999) - (b.runtime || 9999),
  }[state.sort];

  return [...list].sort(cmp);
}

export function activeFilterCount() {
  let n = 0;
  if (state.type !== 'all') n += 1;
  if (state.genre) n += 1;
  if (state.quality) n += 1;
  if (state.status) n += 1;
  return n;
}

/* ── render ── */

/**
 * Rebuild the list.
 *
 * `keep` holds the rendered depth and the scroll offset across the rebuild.
 * Without it a change deep in the list — a long press at row 280, a title
 * marked watched from the overlay — dropped everything past the first chunk
 * and the browser clamped the scroll by thousands of pixels.
 */
function render({ keep = false } = {}) {
  const scroller = root.querySelector('.scroll');
  const top = keep && scroller ? scroller.scrollTop : 0;
  const depth = keep ? state.rendered : 0;

  state.results = compute();
  state.rendered = 0;
  clear(listEl);
  /* Grid cards come from Tonight and know nothing about selection, so the
     mode is list-only rather than half-working in both. */
  state.asGrid = state.view === 'grid' && !state.picked.size;
  listEl.className = state.asGrid ? 'lib-grid' : 'lib-list';

  updateChrome();
  syncSelectionBar();

  if (!state.results.length) {
    listEl.className = 'lib-list';
    listEl.appendChild(emptyFor());
    return;
  }
  appendChunk();
  while (state.rendered < depth && state.rendered < state.results.length) appendChunk();
  if (keep && scroller) scroller.scrollTop = top;
}

/* Three different situations, which used to share one message: a fresh
   install's library said "Try clearing the filters" with no filters set and no
   button to press. */
function emptyFor() {
  const filters = activeFilterCount();
  if (!store.items().length) {
    return emptyState({
      iconName: 'library',
      title: 'Your library is empty',
      message: 'Add a few films and they will turn up here.',
      action: { label: 'Add titles', onClick: () => navigate('add') },
    });
  }
  if (state.query) {
    return emptyState({
      iconName: 'search',
      title: 'No matches',
      message: `Nothing in your library matches “${state.queryRaw}”${filters ? ' with those filters on' : ''}.`,
      action: { label: filters ? 'Clear search and filters' : 'Clear search', onClick: clearFilters },
    });
  }
  return emptyState({
    iconName: 'search',
    title: 'Nothing matches those filters',
    message: 'Try loosening them a little.',
    action: { label: 'Clear filters', onClick: clearFilters },
  });
}

function appendChunk() {
  const slice = state.results.slice(state.rendered, state.rendered + CHUNK);
  const f = document.createDocumentFragment();
  for (const item of slice) f.appendChild(state.asGrid ? cardFor(item) : rowFor(item));
  listEl.appendChild(f);
  state.rendered += slice.length;
}

function updateChrome() {
  const count = root.querySelector('[data-region="count"]');
  const total = store.items().length;
  count.textContent =
    state.results.length === total
      ? `${total} title${total === 1 ? '' : 's'}`
      : `${state.results.length} of ${total}`;

  const badge = root.querySelector('[data-region="filter-count"]');
  const n = activeFilterCount();
  badge.textContent = n ? String(n) : '';
  badge.style.display = n ? '' : 'none';

  const viewBtn = root.querySelector('[data-action="view"]');
  viewBtn.innerHTML = icon(state.view === 'grid' ? 'rows' : 'grid', 20);
  viewBtn.setAttribute('aria-label', state.view === 'grid' ? 'Show as list' : 'Show as grid');
}

function rowFor(item) {
  const selecting = state.picked.size > 0;
  const chosen = state.picked.has(item.uid);
  const row = el('button', {
    class: 'row' + (chosen ? ' is-picked' : ''),
    type: 'button',
    'data-uid': item.uid,
    'aria-label': `${item.title}${item.year ? `, ${item.year}` : ''}`,
    'aria-pressed': selecting ? String(chosen) : null,
    /* Read live, not captured: selection now updates rows in place rather than
       rebuilding them, so a row built before selection started has to know. */
    onclick: () => (state.picked.size ? toggle(item.uid) : openDetail(item.uid)),
  });
  /* Long-press to start selecting. A checkbox on every row would be clutter for
     the 99% of visits that are "find one film"; a press-and-hold costs nothing
     until you want it, and is what the platform already teaches. */
  attachLongPress(row, () => toggle(item.uid));

  /* Always present, collapsed until selection starts, so the list eases across
     rather than jumping 32px in a frame. */
  row.appendChild(
    el('span', {
      class: 'row-pick' + (selecting ? ' is-on' : ''),
      html: chosen ? icon('check', 14) : '',
      'aria-hidden': 'true',
    })
  );
  row.appendChild(poster(item, { width: 44 }));

  const body = el('div', { class: 'row-body' });
  body.appendChild(el('div', { class: 'row-t', text: item.title }));
  body.appendChild(el('div', { class: 'row-s', text: metaLine(item, { showType: true }) }));
  row.appendChild(body);

  const end = el('div', { class: 'row-end' });
  if (item.rating) {
    const r = el('span', { class: 'chip chip-rating' });
    r.appendChild(el('span', { html: icon('starFill', 12) }).firstChild);
    r.appendChild(el('span', { text: rating(item.rating) }));
    end.appendChild(r);
  }
  if (item.owned) {
    end.appendChild(el('span', { html: icon('drive', 15), 'aria-label': 'In your collection' }).firstChild);
  }
  if (item.watched) {
    end.appendChild(
      el('span', { html: icon('check', 16), style: 'color:var(--sage)', 'aria-label': 'Watched' }).firstChild
    );
  }
  row.appendChild(end);
  return row;
}

/* ── controls ── */

function toggleView() {
  state.view = state.view === 'grid' ? 'list' : 'grid';
  store.updateSettings({ libraryView: state.view });
  render();
}

function clearFilters() {
  state.type = 'all';
  state.genre = null;
  state.quality = null;
  state.status = null;
  state.query = '';
  state.queryRaw = '';
  root.querySelector('#library-search').value = '';
  render();
}

function openSort() {
  openSheet({
    title: 'Sort by',
    actions: [
      ['title', 'Title'],
      ['year', 'Year, newest first'],
      ['rating', 'Rating, highest first'],
      ['runtime', 'Runtime, shortest first'],
      ['added', 'Recently added'],
    ].map(([key, label]) => ({
      /* The app's "this one is on" treatment, as the filter pills use. A
         glued-on "  ✓" and a solid amber fill made the current sort read as
         the button to press. */
      label,
      kind: state.sort === key ? 'on-amber' : 'secondary',
      haptic: true,
      onClick: () => {
        state.sort = key;
        render();
      },
    })),
  });
}

/* A single filter surface with four independent facets — the old version put
   type, genre, quality and status into one pill row that claimed to be genre. */
function openFilters() {
  const { panel, close, show: showPanel } = openPanel({
    label: 'Filter library',
    className: 'has-pinned',
    style: 'max-height:82vh;overflow-y:auto',
  });

  panel.appendChild(el('div', { class: 'sheet-grip' }));
  panel.appendChild(el('div', { class: 'sheet-title', text: 'Filter' }));

  /* Pills update in place and the list behind the scrim updates live. Every
     tap used to close the sheet and build a new one, which reset its scroll to
     the top and moved focus to "Everything" — after every single choice. */
  let refresh = () => {};
  const facet = (label, options, read, write) => {
    const box = el('div', { style: 'margin-bottom:var(--s5)' });
    box.appendChild(el('div', { class: 'eyebrow', style: 'margin-bottom:var(--s3)', text: label }));
    const wrap = el('div', { style: 'display:flex;flex-wrap:wrap;gap:var(--s2)' });
    for (const [value, text] of options) {
      wrap.appendChild(
        el('button', {
          class: 'pill',
          type: 'button',
          'data-haptic': true,
          'data-value': value,
          'aria-pressed': String(read() === value),
          text,
          onclick: () => {
            write(read() === value && value !== 'all' ? null : value);
            for (const p of wrap.children) {
              p.setAttribute('aria-pressed', String(read() === p.dataset.value));
            }
            render();
            refresh();
          },
        })
      );
    }
    box.appendChild(wrap);
    return box;
  };

  panel.appendChild(
    facet(
      'Type',
      [
        ['all', 'Everything'],
        ['movie', 'Films'],
        ['tv', 'Series'],
      ],
      () => state.type,
      (v) => (state.type = v || 'all')
    )
  );

  const genres = store.genresInUse();
  if (genres.length) {
    panel.appendChild(
      facet(
        'Genre',
        genres.map((g) => [g, g]),
        () => state.genre,
        (v) => (state.genre = v)
      )
    );
  }

  panel.appendChild(
    facet(
      'Collection',
      [
        ['owned', 'I own it'],
        ['4K', '4K'],
        ['1080p', '1080p'],
      ],
      () => state.quality,
      (v) => (state.quality = v)
    )
  );

  panel.appendChild(
    facet(
      'Status',
      [
        ['unwatched', 'Not watched'],
        ['watched', 'Watched'],
        ['pile', 'Own it, never watched'],
      ],
      () => state.status,
      (v) => (state.status = v)
    )
  );

  const acts = el('div', { class: 'sheet-actions is-pinned' });
  const show = button('Show results', { kind: 'primary', onClick: close });
  const clearAll = button('Clear all', {
    kind: 'quiet',
    onClick: () => {
      clearFilters();
      close();
    },
  });
  acts.appendChild(el('div', { class: 'btn-pair' }, [clearAll, show]));
  panel.appendChild(acts);

  refresh = () => {
    const n = state.results.length;
    /* The count on the button is the answer to "what will I get". */
    show.lastElementChild.textContent = n
      ? `Show ${n} title${n === 1 ? '' : 's'}`
      : 'Nothing matches that';
    clearAll.hidden = !activeFilterCount();
  };
  refresh();

  showPanel();
  /* The panel, not the first pill: landing focus on a filter value made
     "Everything" look chosen. */
  requestAnimationFrame(() => panel.focus({ preventScroll: true }));
}

/* ── multi-select ──────────────────────────────────────────────────────────
   The operation that matters at five hundred titles. Marking a shelf's worth of
   films as owned, or setting the format on everything that arrived without one,
   is otherwise five hundred trips through the detail screen — which is why it
   does not get done, and why the format data on a big library is patchy. */

function toggle(uid) {
  if (state.picked.has(uid)) state.picked.delete(uid);
  else state.picked.add(uid);
  syncSelection();
}

function clearPicked() {
  state.picked.clear();
  syncSelection();
}

/**
 * Reflect the selection in the rows already on screen.
 *
 * Selection used to rebuild the list, which threw away every row past the
 * first chunk and made the row picking-mode eases in impossible to animate.
 * Only a change of layout — leaving selection while the view is set to grid —
 * still needs a rebuild.
 */
function syncSelection() {
  const asGrid = state.view === 'grid' && !state.picked.size;
  if (asGrid !== state.asGrid) {
    render({ keep: true });
    return;
  }
  const selecting = state.picked.size > 0;
  for (const row of listEl.querySelectorAll('.row[data-uid]')) {
    const chosen = state.picked.has(row.dataset.uid);
    row.classList.toggle('is-picked', chosen);
    if (selecting) row.setAttribute('aria-pressed', String(chosen));
    else row.removeAttribute('aria-pressed');
    const mark = row.querySelector('.row-pick');
    if (mark) {
      mark.classList.toggle('is-on', selecting);
      mark.innerHTML = chosen ? icon('check', 14) : '';
    }
  }
  syncSelectionBar();
}

/* Built once per selection and updated in place, so it can slide in and out
   rather than blinking into existence on every toggle. */
function syncSelectionBar() {
  const n = state.picked.size;
  listEl.classList.toggle('has-select-bar', n > 0);
  let bar = root.querySelector('[data-region="select-bar"]:not(.is-leaving)');
  if (n) {
    if (!bar) {
      bar = selectionBar();
      root.appendChild(bar);
      reveal(bar);
    }
    bar.querySelector('.select-count').textContent = `${n} selected`;
  } else if (bar) {
    bar.classList.add('is-leaving');
    bar.classList.remove('is-open');
    setTimeout(() => bar.remove(), 240);
  }
}

/** Press and hold, without swallowing a scroll or a tap. */
function attachLongPress(node, fn) {
  let timer = null;
  let sink = null;
  let held = false;
  let startY = 0;
  const cancel = () => {
    clearTimeout(timer);
    clearTimeout(sink);
    timer = null;
    node.classList.remove('is-holding');
  };
  node.addEventListener('pointerdown', (e) => {
    startY = e.clientY;
    held = false;
    /* Start sinking only once this is clearly not a tap or the start of a
       scroll, so ordinary scrolling does not make every row twitch. */
    sink = setTimeout(() => node.classList.add('is-holding'), 120);
    timer = setTimeout(() => {
      timer = null;
      node.classList.remove('is-holding');
      held = true;
      /* No tick here: this fires from a timer with the finger still down, and
         an iPhone only plays one for a tap — see haptics.js. The row sinking
         and the selection ring appearing are the confirmation. */
      fn();
    }, 450);
  });
  /* The hold is the whole gesture. Its pointerup still produces a click, and
     now that the row survives selecting, that click would immediately undo
     the selection it just made. Capture phase runs before the row's own
     handler. */
  node.addEventListener(
    'click',
    (e) => {
      if (!held) return;
      held = false;
      e.stopImmediatePropagation();
      e.preventDefault();
    },
    true
  );
  /* A drag is a scroll, not a hold. */
  node.addEventListener('pointermove', (e) => {
    if (timer && Math.abs(e.clientY - startY) > 8) cancel();
  });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) {
    node.addEventListener(ev, cancel);
  }
}

/** The bar that appears while something is selected. */
function selectionBar() {
  const n = state.picked.size;
  const bar = el('div', { class: 'select-bar', 'data-region': 'select-bar' });

  bar.appendChild(
    el('div', { class: 'select-count', 'aria-live': 'polite', text: `${n} selected` })
  );

  const act = (label, iconName, onClick, haptic = false) => {
    const b = el('button', {
      class: 'select-act',
      type: 'button',
      'data-haptic': haptic,
      onclick: onClick,
      'aria-label': label,
    });
    b.appendChild(el('span', { html: icon(iconName, 18) }).firstChild);
    b.appendChild(el('span', { text: label }));
    return b;
  };

  if (canShare()) bar.appendChild(act('Send', 'upload', () => sendShelf()));
  bar.appendChild(act('Owned', 'drive', () => openBulkOwned()));
  bar.appendChild(act('Watched', 'check', () => bulkWatched(), true));
  bar.appendChild(act('Remove', 'trash', () => bulkRemove()));
  bar.appendChild(act('Done', 'close', clearPicked));
  return bar;
}

/** Every bulk action is one undo, not one per title. */
function applyBulk(patchFor, describe) {
  /* Only titles that actually change are counted and restored. Selecting ten
     with seven already watched used to report "10 marked as watched", and Undo
     rewrote seven records that had never been touched. */
  const before = [];
  for (const uid of state.picked) {
    const i = store.byUid(uid);
    if (!i) continue;
    const patch = patchFor(i);
    if (!patch) continue;
    before.push({ uid, prev: { ...i } });
    store.update(uid, patch);
  }
  clearPicked();
  if (!before.length) {
    toast('Nothing to change — they were all like that already');
    return;
  }
  store.saveNow();
  store.emit('item');

  toast(describe(before.length), {
    action: 'Undo',
    duration: 6000,
    onAction: () => {
      for (const { uid, prev } of before) store.update(uid, prev);
      store.saveNow();
      store.emit('item');
    },
  });
}

/**
 * Send the selected films to someone as a link.
 *
 * The whole list travels in the URL fragment, which browsers never transmit —
 * so this shares a shelf with no server, no account and nothing uploaded. The
 * recipient does not need the app; they get a readable page and can add any of
 * it to a library of their own.
 *
 * Capped, and the cap is stated rather than silently applied: a link longer
 * than a messaging app will carry gets truncated in transit, and a list that
 * arrives half-missing is worse than one that was honest about its limit.
 */
async function sendShelf() {
  const picked = [...state.picked].map((uid) => store.byUid(uid)).filter(Boolean);
  if (!picked.length) return;

  if (picked.length > MAX_TITLES) {
    toast(`Links hold about ${MAX_TITLES} titles — sending the first ${MAX_TITLES}.`, { duration: 5000 });
  }

  let url;
  try {
    url = await encodeShelf(picked);
  } catch {
    toast('Could not build that link');
    return;
  }

  const n = Math.min(picked.length, MAX_TITLES);
  const text = `${n} film${n === 1 ? '' : 's'} from my shelf`;
  clearPicked();

  if (navigator.share) {
    try {
      await navigator.share({ title: 'My shelf', text, url });
      return;
    } catch (err) {
      /* Dismissing the share sheet is not a failure and must not fall through
         to a surprise clipboard write. */
      if (err?.name === 'AbortError') return;
    }
  }

  try {
    await navigator.clipboard.writeText(url);
    toast('Link copied — paste it to anyone');
  } catch {
    /* No share sheet and no clipboard: show it, so it can still be copied by
       hand rather than the action simply doing nothing. */
    openSheet({
      title: 'Your shelf link',
      message: url,
      actions: [],
      dismissLabel: 'Done',
    });
  }
}

function openBulkOwned() {
  const n = state.picked.size;
  openSheet({
    title: `Mark ${n} as owned`,
    message: 'And say what you own them in, if you like. This is the fastest way to fill in a format across a shelf.',
    actions: [
      { label: 'Owned — 4K', kind: 'secondary', haptic: true, onClick: () => setOwnedBulk('4K') },
      { label: 'Owned — 1080p', kind: 'secondary', haptic: true, onClick: () => setOwnedBulk('1080p') },
      { label: 'Owned — no format', kind: 'secondary', haptic: true, onClick: () => setOwnedBulk(null) },
      { label: 'Not owned', kind: 'quiet', haptic: true, onClick: () => setOwnedBulk(undefined, false) },
    ],
  });
}

function setOwnedBulk(quality, owned = true) {
  applyBulk(
    () => {
      /* quality === undefined means "leave the format alone" — unticking owned
         should not silently erase what someone recorded about their disc. */
      const patch = { owned };
      if (quality !== undefined) patch.quality = quality;
      return patch;
    },
    (n) => (owned ? `${n} marked as owned` : `${n} no longer marked as owned`)
  );
}

function bulkWatched() {
  /* No watchedAt.
     Marking three hundred discs watched in one go is triage, not three hundred
     viewings — stamping today's date on all of them forges a watch history the
     app then reasons from. The scorer weights recency, and stats.js already
     refuses to claim a year total unless the timestamps span sixty days
     (`datesAreHistory`), which this would have quietly satisfied with a
     weekend's cataloguing. A null date says "watched, at some point", which is
     the truth and is what a bulk mark actually means. Marking one film watched
     from its own screen still records when. */
  applyBulk(
    (i) => (i.watched ? null : { watched: true, watchedAt: null, seen: true, seenAt: i.seenAt || Date.now() }),
    (n) => `${n} marked as watched`
  );
}

function bulkRemove() {
  const n = state.picked.size;
  confirmDestructive({
    title: `Remove ${n} title${n === 1 ? '' : 's'}?`,
    message: 'They go out of your library. You can undo this straight afterwards.',
    confirmLabel: 'Remove',
    onConfirm: () => {
      const uids = [...state.picked];
      const removed = uids.map((uid) => store.byUid(uid)).filter(Boolean).map((i) => ({ ...i }));
      for (const uid of uids) store.remove(uid);
      store.saveNow();
      store.emit('item');
      clearPicked();
      toast(`Removed ${removed.length}`, {
        action: 'Undo',
        duration: 8000,
        onAction: () => {
          for (const item of removed) store.add(item);
          store.saveNow();
          store.emit('item');
        },
      });
    },
  });
}

/* ── automation hooks (see main.js exposeTestHooks) ── */
export function testClearFilters() {
  clearFilters();
}
export function testVisibleUids() {
  return state.results.slice(0, state.rendered).map((i) => i.uid);
}

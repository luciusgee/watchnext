/*
 * Library.
 *
 * Two changes of substance from the old version: filtering is one control with
 * four independent facets rather than two rows that pretend to be one, and the
 * list renders in chunks so a 500-title library doesn't rebuild 500 DOM
 * subtrees on every keystroke.
 */

import * as store from '../store.js';
import { el, clear, poster, posterBadge, emptyState, openSheet, button, toast, confirmDestructive } from '../ui.js';
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
      state.query = search.value.trim().toLowerCase();
      render();
    }, 140);
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

  store.subscribe((r) => {
    if (r === 'item' && root.classList.contains('is-active')) render();
  });
}

export function showLibrary(params = {}) {
  if (params.filter === 'pile') {
    state.status = 'pile';
    state.query = '';
    root.querySelector('#library-search').value = '';
  }
  if (params.filter === 'owned') state.quality = 'owned';
  render();
}

/* ── filtering ── */

function compute() {
  let list = store.items();

  if (state.query) {
    const q = state.query;
    list = list.filter(
      (i) =>
        i.title.toLowerCase().includes(q) ||
        (i.genre && i.genre.toLowerCase().includes(q)) ||
        (i.year && String(i.year).includes(q))
    );
  }
  if (state.type !== 'all') list = list.filter((i) => i.type === state.type);
  if (state.genre) list = list.filter((i) => i.genre === state.genre);
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

function render() {
  state.results = compute();
  state.rendered = 0;
  clear(listEl);
  listEl.className = state.view === 'grid' ? 'lib-grid' : 'lib-list';

  updateChrome();

  const existingBar = root.querySelector('[data-region="select-bar"]');
  existingBar?.remove();
  if (state.picked.size) root.appendChild(selectionBar());

  if (!state.results.length) {
    listEl.appendChild(
      emptyState({
        iconName: 'search',
        title: state.query ? 'No matches' : 'Nothing here',
        message: state.query
          ? `Nothing in your library matches “${state.query}”.`
          : 'Try clearing the filters.',
        action: activeFilterCount() || state.query ? { label: 'Clear filters', onClick: clearFilters } : null,
      })
    );
    return;
  }
  appendChunk();
}

function appendChunk() {
  const slice = state.results.slice(state.rendered, state.rendered + CHUNK);
  const f = document.createDocumentFragment();
  for (const item of slice) {
    /* Grid cards come from Tonight and know nothing about selection, so the
       mode is list-only rather than half-working in both. */
    f.appendChild(state.view === 'grid' && !state.picked.size ? cardFor(item) : rowFor(item));
  }
  listEl.appendChild(f);
  state.rendered += slice.length;
}

function updateChrome() {
  const count = root.querySelector('[data-region="count"]');
  const total = store.items().length;
  count.textContent =
    state.results.length === total
      ? `${total} titles`
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
    'aria-label': `${item.title}${item.year ? `, ${item.year}` : ''}`,
    'aria-pressed': selecting ? String(chosen) : null,
    onclick: () => (selecting ? toggle(item.uid) : openDetail(item.uid)),
  });
  /* Long-press to start selecting. A checkbox on every row would be clutter for
     the 99% of visits that are "find one film"; a press-and-hold costs nothing
     until you want it, and is what the platform already teaches. */
  attachLongPress(row, () => toggle(item.uid));

  if (selecting) {
    row.appendChild(
      el('span', {
        class: 'row-pick',
        html: chosen ? icon('check', 14) : '',
        'aria-hidden': 'true',
      })
    );
  }
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
      label: state.sort === key ? `${label}  ✓` : label,
      kind: state.sort === key ? 'primary' : 'secondary',
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
  const scrim = el('div', { class: 'scrim is-open' });
  const panel = el('div', {
    class: 'sheet is-open',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': 'Filter library',
    style: 'max-height:82vh;overflow-y:auto',
  });

  const close = () => {
    scrim.remove();
    panel.remove();
    document.removeEventListener('keydown', onKey);
    render();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);
  scrim.addEventListener('click', close);

  panel.appendChild(el('div', { class: 'sheet-grip' }));
  panel.appendChild(el('div', { class: 'sheet-title', text: 'Filter' }));

  const facet = (label, options, current, onPick) => {
    const box = el('div', { style: 'margin-bottom:20px' });
    box.appendChild(el('div', { class: 'eyebrow', style: 'margin-bottom:10px', text: label }));
    const wrap = el('div', { style: 'display:flex;flex-wrap:wrap;gap:8px' });
    for (const [value, text] of options) {
      const active = current === value;
      const b = el('button', {
        class: 'pill',
        type: 'button',
        'aria-pressed': String(active),
        text,
        onclick: () => {
          onPick(active && value !== 'all' ? null : value);
          close();
          openFilters();
        },
      });
      wrap.appendChild(b);
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
      state.type,
      (v) => (state.type = v || 'all')
    )
  );

  const genres = store.genresInUse();
  if (genres.length) {
    panel.appendChild(
      facet('Genre', genres.map((g) => [g, g]), state.genre, (v) => (state.genre = v))
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
      state.quality,
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
      state.status,
      (v) => (state.status = v)
    )
  );

  const acts = el('div', { class: 'sheet-actions' });
  acts.appendChild(
    button('Show results', { kind: 'primary', block: true, onClick: close })
  );
  if (activeFilterCount()) {
    acts.appendChild(
      button('Clear all', {
        kind: 'quiet',
        block: true,
        onClick: () => {
          clearFilters();
          close();
        },
      })
    );
  }
  panel.appendChild(acts);

  document.body.appendChild(scrim);
  document.body.appendChild(panel);
  requestAnimationFrame(() => panel.querySelector('button')?.focus());
}

/* ── multi-select ──────────────────────────────────────────────────────────
   The operation that matters at five hundred titles. Marking a shelf's worth of
   films as owned, or setting the format on everything that arrived without one,
   is otherwise five hundred trips through the detail screen — which is why it
   does not get done, and why the format data on a big library is patchy. */

function toggle(uid) {
  if (state.picked.has(uid)) state.picked.delete(uid);
  else state.picked.add(uid);
  render();
}

function clearPicked() {
  state.picked.clear();
  render();
}

/** Press and hold, without swallowing a scroll or a tap. */
function attachLongPress(node, fn) {
  let timer = null;
  let startY = 0;
  const cancel = () => {
    clearTimeout(timer);
    timer = null;
  };
  node.addEventListener('pointerdown', (e) => {
    startY = e.clientY;
    timer = setTimeout(() => {
      timer = null;
      /* Haptic where the platform offers one; silent where it does not. */
      navigator.vibrate?.(12);
      fn();
    }, 450);
  });
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
    el('div', { class: 'select-count', text: `${n} selected` })
  );

  const act = (label, iconName, onClick) => {
    const b = el('button', { class: 'select-act', type: 'button', onclick: onClick, 'aria-label': label });
    b.appendChild(el('span', { html: icon(iconName, 18) }).firstChild);
    b.appendChild(el('span', { text: label }));
    return b;
  };

  if (canShare()) bar.appendChild(act('Send', 'upload', () => sendShelf()));
  bar.appendChild(act('Owned', 'drive', () => openBulkOwned()));
  bar.appendChild(act('Watched', 'check', () => bulkWatched()));
  bar.appendChild(act('Remove', 'trash', () => bulkRemove()));
  bar.appendChild(act('Done', 'close', clearPicked));
  return bar;
}

/** Every bulk action is one undo, not one per title. */
function applyBulk(patchFor, describe) {
  const uids = [...state.picked];
  const before = uids.map((uid) => {
    const i = store.byUid(uid);
    return i ? { uid, prev: { ...i } } : null;
  }).filter(Boolean);

  for (const { uid } of before) {
    const patch = patchFor(store.byUid(uid));
    if (patch) store.update(uid, patch);
  }
  store.saveNow();
  store.emit('item');
  clearPicked();

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
      { label: 'Owned — 4K', kind: 'secondary', onClick: () => setOwnedBulk('4K') },
      { label: 'Owned — 1080p', kind: 'secondary', onClick: () => setOwnedBulk('1080p') },
      { label: 'Owned — no format', kind: 'secondary', onClick: () => setOwnedBulk(null) },
      { label: 'Not owned', kind: 'quiet', onClick: () => setOwnedBulk(undefined, false) },
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

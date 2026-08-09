/*
 * Library.
 *
 * Two changes of substance from the old version: filtering is one control with
 * four independent facets rather than two rows that pretend to be one, and the
 * list renders in chunks so a 500-title library doesn't rebuild 500 DOM
 * subtrees on every keystroke.
 */

import * as store from '../store.js';
import { el, clear, poster, posterBadge, emptyState, openSheet, button } from '../ui.js';
import { icon } from '../icons.js';
import { runtime, rating, metaLine } from '../format.js';
import { openDetail } from './detail.js';
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
  for (const item of slice) f.appendChild(state.view === 'grid' ? cardFor(item) : rowFor(item));
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
  const row = el('button', {
    class: 'row',
    type: 'button',
    'aria-label': `${item.title}${item.year ? `, ${item.year}` : ''}`,
    onclick: () => openDetail(item.uid),
  });
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

/* ── automation hooks (see main.js exposeTestHooks) ── */
export function testClearFilters() {
  clearFilters();
}
export function testVisibleUids() {
  return state.results.slice(0, state.rendered).map((i) => i.uid);
}

/*
 * Bootstrap + router.
 *
 * The tab bar is one component rendered once, not copied into every screen
 * (the old version had six near-identical copies that drifted apart).
 */

import * as store from './store.js';
import { seedLibrary } from './seed.js';
import { icon } from './icons.js';
import { el, toast } from './ui.js';

import { initDetail, closeDetail, isDetailOpen } from './screens/detail.js';
import { initTonight, showTonight } from './screens/tonight.js';
import { initLibrary, showLibrary } from './screens/library.js';
import { initDiscover, showDiscover } from './screens/discover.js';
import { initAsk, showAsk } from './screens/ask.js';
import { initSettings, showSettings } from './screens/settings.js';
import { initAdd, showAdd } from './screens/add.js';

const TABS = [
  { id: 'tonight', label: 'Tonight', icon: 'tonight' },
  { id: 'discover', label: 'Discover', icon: 'discover' },
  { id: 'library', label: 'Library', icon: 'library' },
  { id: 'ask', label: 'Ask', icon: 'ask' },
];

const SHOW = {
  tonight: showTonight,
  discover: showDiscover,
  library: showLibrary,
  ask: showAsk,
  settings: showSettings,
  add: showAdd,
};

let current = 'tonight';

function navigate(id, params = {}) {
  if (!document.getElementById(`screen-${id}`)) return;

  for (const screen of document.querySelectorAll('.screen')) {
    screen.classList.toggle('is-active', screen.id === `screen-${id}`);
  }
  current = id;

  /* The tab bar stays visible on Settings and Add — the old version stranded
     you on Add with only a back arrow. */
  for (const btn of document.querySelectorAll('[data-tab]')) {
    const active = btn.dataset.tab === id;
    btn.setAttribute('aria-current', active ? 'page' : 'false');
  }

  const screen = document.getElementById(`screen-${id}`);
  screen.querySelector('.scroll')?.scrollTo({ top: 0 });

  try {
    SHOW[id]?.(params);
  } catch (err) {
    console.error(`[nav] ${id} failed to render`, err);
    toast('Something went wrong opening that screen');
  }

  if (location.hash !== `#${id}`) history.replaceState(null, '', `#${id}`);
}

function buildTabBar() {
  const bar = el('nav', { class: 'tabbar', 'aria-label': 'Main' });
  for (const t of TABS) {
    const btn = el('button', {
      class: 'tab',
      type: 'button',
      dataset: { tab: t.id },
      'aria-current': t.id === current ? 'page' : 'false',
      onclick: () => navigate(t.id),
    });
    btn.appendChild(el('span', { html: icon(t.icon, 22) }).firstChild);
    btn.appendChild(el('span', { text: t.label }));
    bar.appendChild(btn);
  }
  return bar;
}

function wireChrome() {
  document.querySelectorAll('[data-nav]').forEach((btn) => {
    btn.addEventListener('click', () => navigate(btn.dataset.nav));
  });
  document.querySelectorAll('[data-icon]').forEach((node) => {
    node.innerHTML = icon(node.dataset.icon, parseInt(node.dataset.iconSize || '21', 10));
  });
}

function boot() {
  store.init(seedLibrary);

  document.getElementById('app').appendChild(buildTabBar());
  wireChrome();

  initDetail({ navigate });
  initTonight({ navigate });
  initLibrary({ navigate });
  initDiscover({ navigate });
  initAsk({ navigate });
  initSettings({ navigate });
  initAdd({ navigate });

  /* Android back / browser back closes the overlay before leaving the app. */
  window.addEventListener('popstate', () => {
    if (isDetailOpen()) {
      closeDetail();
      return;
    }
    const id = location.hash.slice(1);
    if (id && id !== current) navigate(id);
  });

  store.subscribe((reason) => {
    if (reason === 'quota-exceeded') {
      toast('Storage is full — export a backup and remove some titles', { duration: 8000 });
    }
  });

  const start = location.hash.slice(1);
  navigate(TABS.some((t) => t.id === start) || SHOW[start] ? start : 'tonight');

  exposeTestHooks();
  document.body.classList.add('is-ready');
}

/**
 * Automation surface for the end-to-end suite. Only attached when running
 * locally or with ?test=1 — it exposes nothing a user could not already do
 * from the console, but there is no reason to ship it on the live page.
 */
function exposeTestHooks() {
  const local =
    ['localhost', '127.0.0.1', ''].includes(location.hostname) ||
    new URLSearchParams(location.search).has('test');
  if (!local) return;

  Promise.all([
    import('./actions.js'),
    import('./screens/library.js'),
    import('./screens/detail.js'),
  ]).then(([actions, library, detail]) => {
    window.__test = {
      items: store.items,
      count: () => store.items().length,
      byUid: store.byUid,
      add: (f) => store.add(f) && store.emit('item'),
      addItem: actions.addItem,
      update: (uid, patch) => {
        store.update(uid, patch);
        store.saveNow();
        store.emit('item');
      },
      remove: (uid) => {
        store.remove(uid);
        store.saveNow();
        store.emit('item');
      },
      setWatched: actions.setWatched,
      resetDiscover: actions.resetDiscover,
      exportPayload: store.exportPayload,
      importPayload: store.importPayload,
      clearFilters: library.testClearFilters,
      visibleUids: library.testVisibleUids,
      currentDetailUid: detail.testCurrentUid,
      seedMany: (n) => {
        for (let i = 0; i < n; i++) {
          store.add({
            title: `The Test Film ${i}`,
            year: 1970 + (i % 55),
            type: i % 9 === 0 ? 'tv' : 'movie',
            genre: ['Horror', 'Drama', 'Sci-Fi', 'Action', 'Comedy'][i % 5],
            rating: 4 + (i % 60) / 10,
            runtime: 80 + (i % 80),
            owned: i % 3 === 0,
          });
        }
        store.saveNow();
        store.emit('item');
      },
    };
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

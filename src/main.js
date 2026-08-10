/*
 * Bootstrap + router.
 *
 * The tab bar is one component rendered once, not copied into every screen
 * (the old version had six near-identical copies that drifted apart).
 */

import * as store from './store.js';
import { requestPersistence } from './durability.js';
import { syncViewport, blockZoom, measureShortfall, applyHomeIndicatorFloor } from './viewport.js';
import { icon } from './icons.js';
import { el, toast } from './ui.js';

import { initDetail, closeDetail, isDetailOpen } from './screens/detail.js';
import { initTonight, showTonight } from './screens/tonight.js';
import { initLibrary, showLibrary } from './screens/library.js';
import { initDiscover, showDiscover } from './screens/discover.js';
import { initAsk, showAsk } from './screens/ask.js';
import { initPick, showPick } from './screens/pick.js';
import { initStats, showStats } from './screens/stats.js';
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
  pick: showPick,
  stats: showStats,
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

async function boot() {
  /* No seed argument: a new install starts empty and the sample is offered from
     the empty state instead. See store.init(). */
  await store.init();

  document.getElementById('app').appendChild(buildTabBar());
  wireChrome();

  initDetail({ navigate });
  initTonight({ navigate });
  initLibrary({ navigate });
  initDiscover({ navigate });
  initAsk({ navigate });
  initPick({ navigate });
  initStats({ navigate });
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
  registerServiceWorker();
  protectStorage();
  clearRetiredKeys();
  applyHomeIndicatorFloor();
  /* Before syncViewport: it decides whether the blank-and-reflow fallback is
     worth running, and it is not when the shortfall is the iOS 26 one. */
  measureShortfall();
  syncViewport();
  blockZoom();
  document.body.classList.add('is-ready');
}

/**
 * Tidy up after a removed feature.
 *
 * The screen fit was briefly a setting, backed by these two keys. It is now
 * fixed at "inside the safe area", so they are inert — but leaving a stale
 * 'wn.fit' lying around is a trap for whoever reuses that name. Removing a key
 * that is not there costs nothing, so this can stay until the last device that
 * saw that build has launched, and then be deleted.
 */
function clearRetiredKeys() {
  try {
    localStorage.removeItem('wn.fit');
    localStorage.removeItem('wn.fit.checked');
  } catch {
    /* nothing to clean up if storage is unavailable */
  }
}

/**
 * Ask the browser not to evict us, and recover if it already has.
 *
 * WebKit deletes script-writable storage after seven days of browser use
 * without a visit, so a user who leaves the app alone for a while can lose a
 * library nobody is going to re-enter by hand. Persistence usually gets granted
 * for installed web apps, which takes the origin out of eviction entirely.
 */
function protectStorage() {
  requestPersistence()
    .then(({ persisted }) => {
      if (!persisted) {
        console.info('[storage] not persisted — the browser may evict this data');
      }
    })
    .catch(() => {});
}

const SW_DISABLED_KEY = 'wn.sw.disabled';

/**
 * Offline support.
 *
 * Registered after the app has rendered so it never delays first paint, and
 * skipped entirely under automation — a worker caching the shell between test
 * runs would make failures depend on which test ran first.
 */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol === 'file:') return;
  if (new URLSearchParams(location.search).has('test')) return;
  if (navigator.webdriver) return;
  /* Set by wn.disableOffline() — a permanent opt-out, so support can rule the
     worker out as a cause without the next reload quietly bringing it back. */
  try {
    if (localStorage.getItem(SW_DISABLED_KEY)) return;
  } catch {
    /* storage unavailable: proceed as normal */
  }

  /* Deliberately NOT gated on the load event. `load` waits for every image on
     the page, so on a slow connection with a screen full of posters it can be
     many seconds away — or never arrive, if the user navigates first. Tying
     registration to it means offline support quietly fails to activate exactly
     for the people who most need it. Idle-with-a-deadline instead: off the
     critical path, but guaranteed to run. */
  const schedule =
    window.requestIdleCallback || ((fn) => setTimeout(fn, 1200));
  schedule(start, { timeout: 3000 });

  async function start() {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js');

      /* When a new version takes over, reload once so the running page is not
         a mix of old modules and new ones. The guard stops a reload loop if
         the worker changes again during that reload. */
      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloading) return;
        reloading = true;
        location.reload();
      });

      /* A worker already waiting means a deploy landed while the app was open.
         Tell it to take over rather than sitting on the old build until every
         tab is closed. */
      if (reg.waiting) reg.waiting.postMessage('skip-waiting');
      reg.addEventListener('updatefound', () => {
        const next = reg.installing;
        if (!next) return;
        next.addEventListener('statechange', () => {
          if (next.state === 'installed' && navigator.serviceWorker.controller) {
            next.postMessage('skip-waiting');
          }
        });
      });
    } catch (err) {
      /* Offline support is a bonus, never a dependency. */
      console.warn('[sw] registration failed', err);
    }
  }
}

/*
 * Escape hatches, for when the worker is the suspect. Both are reachable from
 * the console; neither touches the library.
 *
 *   wn.resetOfflineCache()  purge everything cached and reload onto fresh code.
 *                           Offline support stays on and re-primes itself.
 *   wn.disableOffline()     the same, but the worker stays gone across reloads
 *                           until wn.enableOffline() is called.
 */
async function purgeAndReload() {
  try {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('wn-')).map((k) => caches.delete(k)));
  } catch {
    /* best effort — the reload below is what actually matters */
  }
  const reg = await navigator.serviceWorker?.getRegistration();
  if (reg) {
    try {
      await reg.unregister();
    } catch {
      /* ignore */
    }
  }
  location.reload();
}

window.wn = Object.assign(window.wn || {}, {
  resetOfflineCache: purgeAndReload,
  async disableOffline() {
    try {
      localStorage.setItem(SW_DISABLED_KEY, '1');
    } catch {
      /* nothing else to do */
    }
    await purgeAndReload();
  },
  async enableOffline() {
    try {
      localStorage.removeItem(SW_DISABLED_KEY);
    } catch {
      /* nothing else to do */
    }
    location.reload();
  },
});

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
    import('./seed.js'),
    import('./screens/library.js'),
    import('./screens/detail.js'),
  ]).then(([actions, seed, library, detail]) => {
    window.__test = {
      items: store.items,
      /* The starter set is no longer loaded on first run, so a suite that needs
         a library asks for one. */
      loadSample: () => {
        const n = store.loadSample(seed.seedLibrary);
        store.emit('item');
        return n;
      },
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
      settings: store.settings,
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
  document.addEventListener('DOMContentLoaded', () => {
    boot().catch((e) => console.error('[boot] failed', e));
  });
} else {
  boot().catch((e) => console.error('[boot] failed', e));
}

/*
 * Bootstrap + router.
 *
 * The tab bar is one component rendered once, not copied into every screen
 * (the old version had six near-identical copies that drifted apart).
 */

import * as store from './store.js';
import { seedLibrary } from './seed.js';
import { requestPersistence } from './durability.js';
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

async function boot() {
  await store.init(seedLibrary);

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
  registerServiceWorker();
  protectStorage();
  syncViewport();
  document.body.classList.add('is-ready');
}

/**
 * Offline support.
 *
 * Registered after the app has rendered so it never delays first paint, and
 * skipped entirely under automation — a worker caching the shell between test
 * runs would make failures depend on which test ran first.
 */
/**
 * Keep the shell matched to the *visible* viewport.
 *
 * The shell is position:fixed so it always fills the screen, but a fixed
 * element does not shrink when the on-screen keyboard appears — iOS shrinks
 * the visual viewport and leaves the layout viewport alone, so the composer on
 * the Ask tab and the search field in Library end up hidden behind the
 * keyboard. VisualViewport is the only reliable way to know how much room the
 * keyboard has taken.
 */
function syncViewport() {
  const vv = window.visualViewport;
  if (!vv) return;

  /* The difference between the layout and visual viewports is NOT necessarily
     the keyboard. In Safari it is also the browser's own URL bar, which is
     always there — so measuring the gap unconditionally shrinks the app by the
     height of the address bar and leaves a dead band under the tab bar. Only a
     focused text field can summon a keyboard, so that is the gate. */
  const isEditing = () => {
    const el = document.activeElement;
    if (!el) return false;
    return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
  };

  /* Below this, a shrink is browser chrome rather than a keyboard. No on-screen
     keyboard is under ~150px on any phone. */
  const KEYBOARD_MIN = 150;

  let frame = 0;
  const apply = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      let covered = 0;
      if (isEditing()) {
        const gap = window.innerHeight - vv.height - vv.offsetTop;
        if (gap >= KEYBOARD_MIN) covered = gap;
      }
      document.documentElement.style.setProperty('--kb', `${Math.round(covered)}px`);
    });
  };

  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  /* Focus changes are what actually open and close the keyboard; the viewport
     events alone can fire before activeElement has settled. */
  document.addEventListener('focusin', apply);
  document.addEventListener('focusout', () => setTimeout(apply, 50));
  apply();

  initViewportHeal(isEditing, apply);
}

/**
 * Undo iOS's permanent viewport shrink.
 *
 * In a home-screen web app, the first time the on-screen keyboard opens iOS
 * shrinks the layout viewport by the height of the status bar and then never
 * gives it back — innerHeight, visualViewport.height and 100dvh all drop
 * together (932 → 873 on this phone) and stay there until the app is force
 * quit. Everything downstream is then correct about a wrong number: the shell
 * fills the viewport perfectly, the viewport is simply 59pt shorter than the
 * screen, and the difference shows up as a dead band under the tab bar.
 *
 * Toggling display on a full-height element forces WebKit to re-measure, which
 * restores the real height. It is a blunt instrument — it costs a reflow and
 * blanks the shell for one frame — so it only runs when there is a measured
 * shortfall and no field is focused, and it gives up rather than flickering
 * forever if it turns out not to help on some future iOS.
 */
function initViewportHeal(isEditing, afterHeal) {
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (!standalone) return; // mobile Safari does not have this bug

  const app = document.getElementById('app');
  if (!app) return;

  let tallest = window.innerHeight;

  /* A launch can inherit the shrink from a previous session, so the screen is
     used as a second opinion — but only when the gap is status-bar sized. A
     wildly different number means something we do not understand, and healing
     towards it would be guessing. */
  const plausible = screen.height - window.innerHeight;
  if (plausible > 0 && plausible <= 120) tallest = Math.max(tallest, screen.height);

  let givenUp = false;
  let failures = 0;

  window.addEventListener('resize', () => {
    tallest = Math.max(tallest, window.innerHeight);
  });

  function heal() {
    if (givenUp) return;
    if (isEditing()) return; // the keyboard is genuinely up; the shrink is real
    const before = window.innerHeight;
    if (tallest - before <= 4) return;

    /* Blanking the shell resets every scroll container inside it. */
    const scrollers = [...document.querySelectorAll('.scroll')];
    const tops = scrollers.map((s) => s.scrollTop);

    app.style.display = 'none';
    void app.offsetHeight; // force a synchronous reflow while it is gone
    app.style.display = '';

    scrollers.forEach((s, i) => {
      s.scrollTop = tops[i];
    });

    requestAnimationFrame(() => {
      if (window.innerHeight > before) {
        failures = 0;
        afterHeal();
      } else if (++failures >= 2) {
        /* Two flips with nothing to show for it: stop, rather than blinking the
           whole app at someone on every keyboard dismissal for no benefit. */
        givenUp = true;
        console.info('[viewport] shrink could not be healed — leaving it alone');
      }
    });
  }

  /* Dismissing the keyboard is what leaves the viewport stuck, so that is the
     moment to check. The delay lets iOS finish its own animation first. */
  document.addEventListener('focusout', () => setTimeout(heal, 160));
  /* And returning to the app, which is when a shrink inherited from earlier in
     the session becomes visible again. */
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) setTimeout(heal, 120);
  });
  window.addEventListener('pageshow', () => setTimeout(heal, 120));

  /* Finally, once at startup — this is the case the user actually reported: the
     app opened already short, with no keyboard involved. */
  setTimeout(heal, 400);
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
  document.addEventListener('DOMContentLoaded', () => {
    boot().catch((e) => console.error('[boot] failed', e));
  });
} else {
  boot().catch((e) => console.error('[boot] failed', e));
}

/*
 * Bootstrap + router.
 *
 * The tab bar is one component rendered once, not copied into every screen
 * (the old version had six near-identical copies that drifted apart).
 */

import * as store from './store.js';
import { requestPersistence } from './durability.js';
import { start as startSync } from './sync.js';
import { syncViewport, blockZoom, measureShortfall, applyHomeIndicatorFloor } from './viewport.js';
import { icon } from './icons.js';
import * as haptics from './haptics.js';
import { el, toast } from './ui.js';
import { initSwipeBack, cancelSwipe } from './swipeback.js';

import { initDetail, openDetail, closeDetail, isDetailOpen, detailDepth } from './screens/detail.js';
import { openThread } from './screens/thread.js';
import { paintBadge } from './notify.js';
import { initTonight, showTonight } from './screens/tonight.js';
import { initLibrary, showLibrary } from './screens/library.js';
import { initDiscover, showDiscover } from './screens/discover.js';
import { initFeed, showFeed } from './screens/feed.js';
import { initAsk, showAsk } from './screens/ask.js';
import { initPick, showPick } from './screens/pick.js';
import { initStats, showStats } from './screens/stats.js';
import { initShelf, showShelf } from './screens/shelf.js';
import { isSharedShelf } from './share.js';
import { initSettings, showSettings } from './screens/settings.js';
import { initAdd, showAdd } from './screens/add.js';

const TABS = [
  { id: 'tonight', label: 'Tonight', icon: 'tonight' },
  { id: 'feed', label: 'Feed', icon: 'feed' },
  { id: 'discover', label: 'Discover', icon: 'discover' },
  { id: 'library', label: 'Library', icon: 'library' },
  { id: 'ask', label: 'Ask', icon: 'ask' },
];

const SHOW = {
  tonight: showTonight,
  feed: showFeed,
  discover: showDiscover,
  library: showLibrary,
  ask: showAsk,
  pick: showPick,
  stats: showStats,
  shelf: showShelf,
  settings: showSettings,
  add: showAdd,
};

let current = 'tonight';
let lastTab = 'tonight';

/* Screens you go into rather than across to. They slide in from the right, get
   a Back that returns to wherever you were, and remember nothing of their own
   scroll — every visit starts at the top. */
const PUSHED = new Set(['pick', 'stats', 'settings', 'add']);
const backStack = [];
/* A tab keeps its place. iOS does, and losing your position in a 500-title
   library because you glanced at Tonight is the kind of thing that makes an
   app feel like a web page. */
const scrollMemo = new Map();
/* The feed scrolls its own region (snapping card to card), not a .scroll. */
const scroller = (id) => document.getElementById(`screen-${id}`)?.querySelector('.scroll, .feed-scroll');
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function navigate(id, params = {}, { back = false, swiped = false } = {}) {
  if (!document.getElementById(`screen-${id}`)) return;

  /* Tapping the tab you are already on is the platform's scroll-to-top, not a
     rebuild — re-running the screen flashed it and jumped. */
  if (id === current && !back && !Object.keys(params).length && document.body.classList.contains('is-ready')) {
    scroller(id)?.scrollTo({ top: 0, behavior: reduceMotion() ? 'auto' : 'smooth' });
    return;
  }

  /* Anything else navigating ends a swipe still settling — otherwise its
     deferred Back would land after, and on top of, this. */
  if (!swiped) cancelSwipe();

  const from = current;
  const had = document.activeElement;
  const prev = scroller(from);
  if (prev) scrollMemo.set(from, prev.scrollTop);
  if (!back && id !== from) {
    if (PUSHED.has(id)) {
      if (from !== id) backStack.push(from);
    } else {
      backStack.length = 0; // a tab is a root
    }
  }

  const target = document.getElementById(`screen-${id}`);
  target.classList.remove('is-push', 'is-pop', 'is-fade');
  /* Not after a swipe back: the finger already moved the screens, and a
     slide on top of that played the arrival twice. */
  if (id !== from && document.body.classList.contains('is-ready') && !swiped) {
    if (PUSHED.has(id) && !back) target.classList.add('is-push');
    else if (back || PUSHED.has(from)) target.classList.add('is-pop');
    else target.classList.add('is-fade');
    /* A direction class must not outlive its slide: anything that restarts
       animations later (the viewport heal does) would replay it. */
    target.addEventListener('animationend', () => target.classList.remove('is-push', 'is-pop', 'is-fade'), { once: true });
  }

  for (const screen of document.querySelectorAll('.screen')) {
    screen.classList.toggle('is-active', screen.id === `screen-${id}`);
  }
  current = id;

  /* The tab bar stays visible on Settings and Add — the old version stranded
     you on Add with only a back arrow. On a screen you went into, the tab you
     came from stays lit: with none highlighted, the bar stopped saying where
     you were. */
  if (TABS.some((t) => t.id === id)) lastTab = id;
  for (const btn of document.querySelectorAll('[data-tab]')) {
    const active = btn.dataset.tab === lastTab;
    btn.setAttribute('aria-current', active ? 'page' : 'false');
  }

  try {
    SHOW[id]?.(params);
  } catch (err) {
    console.error(`[nav] ${id} failed to render`, err);
    toast('Something went wrong opening that screen');
  }

  /* After SHOW, which is what builds the content the offset refers to. The
     library renders in pages, so a restored offset can clamp to what is on
     screen — still far better than always starting again at the top. */
  const sc = scroller(id);
  if (sc) sc.scrollTop = !PUSHED.has(id) || back ? scrollMemo.get(id) || 0 : 0;

  /* The control that was focused — a gear, a plus, a Back — has just gone
     display:none with its screen, which dropped keyboard focus on <body> and
     left VoiceOver's cursor on nothing. Land on the new screen's heading
     instead. A tab-bar tap keeps focus on the tab, which is still there. */
  if (had && had !== document.body && !target.contains(had) && !had.closest('.tabbar')) {
    const h = target.querySelector('h1');
    if (h) {
      h.tabIndex = -1;
      h.focus({ preventScroll: true });
    }
  }

  /* Leaving a shared shelf by any route drops its fragment. Only the shelf's
     own button used to, so after tapping a tab a reload — or sharing the page
     — reopened someone else's list. */
  if (from === 'shelf' && id !== 'shelf' && isSharedShelf(location.hash)) {
    history.replaceState(null, '', location.pathname + location.search);
  }

  /* Never overwrite a shared-shelf fragment with a screen name — the fragment
     IS the shelf, and rewriting it loses the list the user just opened. */
  if (id !== 'shelf' && !isSharedShelf(location.hash) && location.hash !== `#${id}`) {
    history.replaceState(null, '', `#${id}`);
  }
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

/** Back from a pushed screen, to wherever it was entered from. */
function goBack({ swiped = false } = {}) {
  const to = backStack.pop() || 'tonight';
  /* Returning to the deck resumes the hand rather than dealing a fresh one —
     "connect a key" from the pick sheet used to cost the whole session. */
  navigate(to, to === 'pick' ? { resume: true } : {}, { back: true, swiped });
}

/* What a swipe from the left edge goes back from: a film's details if they
   are open, otherwise a screen you went into. Tabs are roots — nothing to go
   back to. */
function swipeTarget() {
  if (isDetailOpen()) {
    const detail = document.getElementById('detail');
    /* The close button is fixed, and a transform makes the overlay its
       containing block — scrolled down, it slid away with the content. Pin it
       where it is for the length of the swipe. */
    const pin = () => {
      const b = detail.querySelector('.detail-back');
      if (!b) return;
      const r = b.getBoundingClientRect();
      Object.assign(b.style, { position: 'absolute', top: `${detail.scrollTop + r.top}px`, left: `${r.left}px` });
    };
    const unpin = () => {
      const b = detail.querySelector('.detail-back');
      if (b) Object.assign(b.style, { position: '', top: '', left: '' });
    };
    /* A film opened from another film's "More like this" goes back to that
       film, not to the app — so the app must not show through as if it did.
       Plain ink underneath, and the film before swaps in the usual way. */
    if (detailDepth()) {
      return {
        layer: detail,
        under: document.getElementById('detail-under'),
        onStart: pin,
        onEnd: unpin,
        onBack: () => closeDetail(),
      };
    }
    return { layer: detail, onStart: pin, onEnd: unpin, onBack: () => closeDetail({ swiped: true }) };
  }
  if (!PUSHED.has(current)) return null;
  const to = backStack[backStack.length - 1] || 'tonight';
  return {
    layer: document.getElementById(`screen-${current}`),
    under: document.getElementById(`screen-${to}`),
    reveal: () => {
      const sc = scroller(to);
      if (sc) sc.scrollTop = scrollMemo.get(to) || 0;
    },
    onBack: () => goBack({ swiped: true }),
  };
}

function wireChrome() {
  document.querySelectorAll('[data-nav]').forEach((btn) => {
    btn.addEventListener('click', () => (btn.dataset.nav === 'back' ? goBack() : navigate(btn.dataset.nav)));
  });
  document.querySelectorAll('[data-icon]').forEach((node) => {
    node.innerHTML = icon(node.dataset.icon, parseInt(node.dataset.iconSize || '21', 10));
  });
}

async function boot() {
  /* No seed argument: a new install starts empty and the sample is offered from
     the empty state instead. See store.init(). */
  await store.init();
  haptics.start();

  document.getElementById('app').appendChild(buildTabBar());
  wireChrome();
  initSwipeBack(swipeTarget, [
    ...[...PUSHED].map((id) => document.getElementById(`screen-${id}`)),
    document.getElementById('detail'),
  ]);

  initDetail({ navigate });
  initTonight({ navigate });
  initLibrary({ navigate });
  initDiscover({ navigate });
  initFeed({ navigate });
  initAsk({ navigate });
  initPick({ navigate });
  initStats({ navigate });
  initShelf({ navigate });
  initSettings({ navigate });
  initAdd({ navigate });

  /* Said once, on the load that did it: seven titles quietly leaving a library
     of five hundred looks like data loss unless something says why. */
  const folded = store.takeCollapsed();
  if (folded) {
    toast(`Merged ${folded} duplicate ${folded === 1 ? 'title' : 'titles'} — each film is in your library once now`, {
      duration: 6000,
    });
  }

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

  /* A shared shelf arrives as a fragment, not a screen name, so it is checked
     before the hash is treated as routing — otherwise `#l=1.…` looks like a
     request for a screen called "l=1.…" and silently does nothing. */
  /* A notification opens the app at a film — see openFromLink. */
  const link = /^#(film|thread)=/.test(location.hash) ? location.hash : null;
  if (isSharedShelf(location.hash)) {
    navigate('shelf');
  } else {
    const start = location.hash.slice(1);
    navigate(TABS.some((t) => t.id === start) || SHOW[start] ? start : 'tonight');
  }

  exposeTestHooks();
  registerServiceWorker();
  protectStorage();
  /* After the screens exist: adopting the other phone's changes emits 'item',
     and the handlers for that are wired up in the init calls above. */
  startSync();
  if (link) openFromLink(link);
  /* Tapped while the app was already open: the service worker says where. */
  navigator.serviceWorker?.addEventListener('message', (e) => {
    if (e.data?.type === 'open') openFromLink(new URL(e.data.url, location.href).hash);
  });
  /* Unread comments from the other phone, on the app icon. */
  paintBadge();
  store.subscribe((reason) => {
    if (reason === 'item') paintBadge();
  });
  clearRetiredKeys();
  applyHomeIndicatorFloor();
  /* Before syncViewport: it decides whether the blank-and-reflow fallback is
     worth running, and it is not when the shortfall is the iOS 26 one. */
  measureShortfall();
  syncViewport();
  blockZoom();
}

/**
 * Open a film from a notification: #film=<uid> for a Spotlight, #thread=<uid>
 * for a comment, which opens the comments too. The notification can arrive
 * before this phone's sync has pulled the film in, so if it is not here yet,
 * wait — briefly — for the sync to bring it.
 */
function openFromLink(hash) {
  const m = /^#(film|thread)=([\w-]+)/.exec(hash || '');
  if (!m) return false;
  const [, kind, uid] = m;
  history.replaceState(null, '', `${location.pathname}${location.search}#${current}`);
  const go = () => {
    if (!store.byUid(uid)) return false;
    openDetail(uid);
    if (kind === 'thread') openThread(uid);
    return true;
  };
  if (!go()) {
    const stop = store.subscribe((reason) => {
      if (reason === 'item' && go()) stop();
    });
    setTimeout(stop, 20000);
  }
  return true;
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
      /* Read before registering: on a first install there is no controller,
         and the new worker claiming the page is not an update. */
      const hadController = !!navigator.serviceWorker.controller;
      const reg = await navigator.serviceWorker.register('./sw.js');

      /* When a new version takes over, reload once so the running page is not
         a mix of old modules and new ones — but never on the first install,
         where the page is already the current build (that reloaded the app a
         second or two after its very first launch), and never under the
         user's thumb. The shell is fetched network-first, so the page running
         now is almost always the new code already; the reload waits until the
         app is next put away, where nobody sees it. */
      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloading || !hadController) return;
        const reloadWhenHidden = () => {
          if (document.visibilityState !== 'hidden' || reloading) return;
          reloading = true;
          location.reload();
        };
        document.addEventListener('visibilitychange', reloadWhenHidden);
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
      addPerson: store.addPerson,
      people: store.people,
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

/* is-ready fades the shell in, so it is added however boot ends. A failure in
   any init used to leave #app transparent over black with nothing to say why;
   the CSS has a timed failsafe for a boot that never settles at all. */
const start = () =>
  boot()
    .catch((e) => console.error('[boot] failed', e))
    .finally(() => {
      document.body.classList.add('is-ready');
      /* The launch mark has done its job once it has faded. */
      const mark = document.getElementById('boot');
      mark?.addEventListener('transitionend', () => mark.remove(), { once: true });
      setTimeout(() => mark?.remove(), 1000);
    });

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}

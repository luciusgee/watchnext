/*
 * Service worker.
 *
 * Two jobs: make the app usable with no connection, and make poster art load
 * instantly the second time. Neither should ever come at the cost of trapping
 * someone on a stale build — that is the classic PWA failure, and it is worse
 * than having no service worker at all, because the user has no way out.
 *
 * Strategy per asset class:
 *   app shell (html/js/css)  network-first, fall back to cache
 *   posters (cross-origin)   cache-first, capped, LRU-evicted
 *   everything else          passthrough
 *
 * Network-first on code means a deploy is picked up on the next load with a
 * connection, and the cache only ever serves as an offline fallback. It costs a
 * revalidation request per file on a warm network, which for a handful of small
 * modules is a fair price for never shipping a stale bundle.
 */

const VERSION = 'v1';
const SHELL_CACHE = `wn-shell-${VERSION}`;
const IMAGE_CACHE = `wn-img-${VERSION}`;

/* Cap the poster cache so a 500-title library cannot fill the device. Roughly
   30KB per w500 poster, so 400 entries is ~12MB. */
const MAX_IMAGES = 400;

/* Relative so this works from a GitHub Pages project subpath (/watchnext/)
   exactly as it does from a domain root. */
const SHELL = [
  './',
  './index.html',
  './app.webmanifest',
  './styles/app.css',
  './assets/icon.svg',
  './src/main.js',
  './src/store.js',
  './src/actions.js',
  './src/metadata.js',
  './src/recommend.js',
  './src/format.js',
  './src/icons.js',
  './src/ui.js',
  './src/seed.js',
  './src/build.js',
  './src/durability.js',
  './src/viewport.js',
  './src/deck.js',
  './src/providers/index.js',
  './src/providers/shared.js',
  './src/providers/omdb.js',
  './src/providers/tmdb.js',
  './src/screens/tonight.js',
  './src/screens/discover.js',
  './src/screens/library.js',
  './src/screens/detail.js',
  './src/screens/ask.js',
  './src/screens/settings.js',
  './src/screens/add.js',
  './src/screens/match.js',
  './src/screens/pick.js',
];

/* Every module under src/ belongs above. They are listed by hand rather than
   discovered, because there is no build step to generate the list — and the
   omission is easy to miss, since network-first quietly caches whatever it
   fetches, so the app only breaks for someone who installs it and then goes
   offline before visiting a screen that needs the missing file. */

const IMAGE_HOSTS = ['image.tmdb.org', 'm.media-amazon.com'];

/* ── install ── */

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      /* addAll is atomic — one 404 would fail the whole install and leave the
         previous worker in place. Add individually so a single missing file
         degrades to "that file is not cached" rather than "no offline at all". */
      Promise.all(
        SHELL.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch((err) => {
            console.warn('[sw] could not precache', url, err);
          })
        )
      )
    )
  );
  /* Activate immediately rather than waiting for every tab to close. Safe here
     because the app holds no in-memory state a new worker could desynchronise —
     everything lives in localStorage, read fresh on load. */
  self.skipWaiting();
});

/* ── activate ── */

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith('wn-') && k !== SHELL_CACHE && k !== IMAGE_CACHE)
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

/* ── fetch ── */

function isImage(request, url) {
  /* Prefer what the browser says over a hostname allowlist — allowlists go
     stale the moment a provider is added, and `destination` is exactly the
     signal we want. The host list stays as a fallback for requests made via
     fetch(), which carry an empty destination. */
  if (request.destination === 'image') return true;
  return IMAGE_HOSTS.includes(url.hostname);
}

function isShell(request, url) {
  if (url.origin !== self.location.origin) return false;
  return (
    request.mode === 'navigate' ||
    request.destination === 'script' ||
    request.destination === 'style' ||
    request.destination === 'manifest' ||
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.css') ||
    url.pathname.endsWith('.html')
  );
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  /* Never cache API traffic. Metadata and model responses are the user's own
     quota, and stale answers here would be actively confusing. */
  if (/api\.themoviedb\.org|omdbapi\.com|api\.anthropic\.com/.test(url.hostname)) return;

  if (isImage(request, url)) {
    event.respondWith(cacheFirst(request));
    return;
  }
  if (isShell(request, url)) {
    event.respondWith(networkFirst(request));
  }
});

/** Code and markup: fresh when possible, cached when not. */
async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    /* A navigation with nothing cached for this exact URL still wants the app
       rather than the browser's offline page. */
    if (request.mode === 'navigate') {
      const shell = (await cache.match('./index.html')) || (await cache.match('./'));
      if (shell) return shell;
    }
    return new Response('Offline and not cached.', {
      status: 503,
      headers: { 'content-type': 'text/plain' },
    });
  }
}

/** Posters: immutable once fetched, so serve from cache and fill in behind. */
async function cacheFirst(request) {
  const cache = await caches.open(IMAGE_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    /* Opaque responses (no CORS) still cache and still render; they just cannot
       be inspected. Storing them is what makes offline posters work at all. */
    if (response && (response.ok || response.type === 'opaque')) {
      await cache.put(request, response.clone());
      trimImages(cache);
    }
    return response;
  } catch {
    return new Response('', { status: 504 });
  }
}

/* Rough LRU: Cache Storage preserves insertion order, so dropping from the
   front evicts the oldest additions. Runs opportunistically rather than on
   every write, to keep it off the critical path. */
let trimming = false;
async function trimImages(cache) {
  if (trimming) return;
  trimming = true;
  try {
    const keys = await cache.keys();
    if (keys.length > MAX_IMAGES) {
      const excess = keys.length - MAX_IMAGES;
      for (let i = 0; i < excess; i++) await cache.delete(keys[i]);
    }
  } catch {
    /* eviction is best-effort */
  } finally {
    trimming = false;
  }
}

/* ── messages ──
   The page can ask us to step aside entirely. An escape hatch matters: if a
   worker ever does go wrong, the user needs a way to get back to a plain page
   without clearing site data by hand. */
self.addEventListener('message', (event) => {
  const data = event.data;
  if (data === 'skip-waiting') self.skipWaiting();
  if (data === 'unregister') {
    event.waitUntil(
      (async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter((k) => k.startsWith('wn-')).map((k) => caches.delete(k)));
        await self.registration.unregister();
        /* unregister() only takes effect once no clients are controlled, so
           tell every open tab to reload. Without this the worker keeps serving
           the page it was asked to stop serving. */
        const clients = await self.clients.matchAll({ type: 'window' });
        await Promise.all(
          clients.map((c) => c.navigate(c.url).catch(() => c.postMessage('reload')))
        );
      })()
    );
  }
});

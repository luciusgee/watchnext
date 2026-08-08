# Watch Next

Decide what to watch tonight from the films you already own.

A local-first film and TV library. Everything lives in your browser — no account,
no server, no sync. It knows what is on your drive and what quality you hold it
in, and it uses that to answer one question: *what should I put on right now.*

## Running it

It is a static site with no build step.

```sh
npx http-server -p 8899 -c-1
# then open http://127.0.0.1:8899
```

ES modules need to be served over HTTP — opening `index.html` from the
filesystem will not work.

## Layout

```
index.html          screen skeletons only; no logic
app.webmanifest     PWA metadata
styles/app.css      design tokens + every rule
src/
  main.js           bootstrap and router
  store.js          state, persistence, schema migration
  actions.js        every mutation, so undo and logging live in one place
  metadata.js       OMDb matching engine
  recommend.js      ranking and the "why" behind each suggestion
  seed.js           starter library (see below)
  icons.js          the icon set
  format.js         formatting helpers
  ui.js             shared primitives — poster, toast, sheet, buttons
  screens/          one module per screen
tools/              test suites
```

## Metadata

Titles are matched against OMDb by **searching for candidates and scoring them**
on title similarity, year proximity and type, then only writing when the score
clears a confidence threshold. Anything uncertain goes to a review queue for you
to arbitrate.

This matters because the previous version asked OMDb's `?t=` endpoint for an
exact title, which actually does *fuzzy* matching and always returns something.
Asking it for `1899` with `&type=movie` returns *Making 1899*, a different film
— and the old code wrote that film's poster, plot, genre and runtime over your
entry without checking. It also trusted a hardcoded IMDb id for every seeded
title, and **35% of those ids pointed at the wrong film** (`World War Z` →
*Mars Attacks!*, `Casino` → *Awakenings*, `Scream VI` → *Freaky*).

Every id in `src/seed.js` has since been verified against OMDb. Where an id
could not be confirmed it ships as `null` and is resolved on first run, rather
than shipping a wrong answer.

Enrichment records a `meta` stamp on each item, so re-running a lookup only
touches what is actually missing. Fields you edit yourself are added to
`locked` and are never overwritten.

### Sources

Two are implemented, chosen in Settings → Connections. Adding a third means
writing a module exposing `{ id, label, search, details, byImdbId }` that
returns the neutral `Record` shape from `providers/shared.js`, and listing it in
`providers/index.js` — the matcher never learns which source it is talking to.
`tools/meta-e2e.js` runs the identical scenario suite against every provider.

**TMDB** (default). Better maintained, hosts its own artwork, and the only one
of the two whose terms contemplate a paid app at all. Accepts either the v3 API
key or the v4 read access token — paste whichever your account page shows.
Rate limit is roughly 40 requests/second and enforced **per IP, not per key**,
so 429s are handled with backoff and retry.

**OMDb**. Kept for anyone already set up on it. You need your own free key; the
previous version shipped one shared key for every user, and it has been over its
1000/day limit for a long time, which is why lookups silently stopped working.

Ids inherited from the old build are marked `stale` rather than trusted. They
are re-verified with a single `?i=` lookup — if the returned title and year
agree, that costs one request; only genuine mismatches pay for a full search.
Over a 500-title library that is roughly 600 requests rather than 1000, which
matters because the free tier allows 1000 a day. The sweep is ordered by what
you are most likely to look at (watchlist, owned, missing artwork) so a run cut
short by the daily limit still fixes the visible ones first.

## Recommendations

`recommend.js` scores unwatched — and occasionally re-watchable — titles on
taste affinity from your history, rating, whether you own it, the quality you
own it in, and how long it is relative to the time of day. It returns a short
reason for each pick, because a recommendation you cannot interrogate is noise.
The daily seed keeps the pick stable while you are looking at it.

## Licensing — read before monetising

Researched and verified against the primary sources in August 2026. None of this
is legal advice, and TMDB reserve the right to change their terms unilaterally
(§10.H), so re-check before you ship.

**Neither source permits a commercial app on its free tier.**

*OMDb* is the harder block of the two. Its content is licensed CC BY-NC 4.0, and
§4.2.5 of its terms reads "You may not build a business utilizing the
Contributions, **whether or not for profit**." Its `Poster` field also hotlinks
IMDb's CDN rather than artwork OMDb licenses. Treat OMDb as personal-use only.

*TMDB* requires a commercial subscription — **$149/month** for projects under
$1M revenue (confirmed by TMDB staff on the public forum, 2026-03-31). The
trigger is not a revenue threshold, it is any monetisation at all. TMDB staff
explicitly **reversed** their earlier 2024 position that paid features unrelated
to TMDB data were acceptable: "If your app generates revenue, it is considered
commercial." Ads and IAP both count.

**The AI clause is the one to resolve before building a paid AI feature.**
§1.C of the TMDB terms prohibits: *"Use the TMDB APIs or TMDB Content in
connection with, including for training, a machine learning (ML) or artificial
intelligence (AI) based Application."* This is drafted as an absolute
restriction on the licence, not as a commercial-use trigger, and §2.A separately
names *"interactive query-response system (including large language model (LLM)
… or chatbots)"* as a commercial use. Nothing in the terms states that buying the
commercial subscription lifts §1.C.

That matters here because the Ask tab sends TMDB-derived titles, genres and
runtimes to an LLM as prompt context. It does not train on them, and TMDB staff
told a developer building a RAG film recommender "yup, that's fine" in 2024 —
but that was a non-commercial project and a forum reply is not a licence
amendment. **Get this in writing from TMDB before shipping Ask as a paid
feature.** Apple's Guideline 5.2.2 requires you to produce authorization for
third-party content on request anyway.

Two other obligations are implemented rather than documented-and-forgotten:

- **Caching.** §1.C forbids caching TMDB content for longer than six months.
  `CACHE_TTL_MS` in `metadata.js` expires resolved records at 180 days so they
  fall back into the lookup queue.
- **Attribution.** §3 specifies the wording verbatim and requires it in an
  "About" or "Credits" section — it renders in Settings → About. The terms also
  require TMDB's logo alongside it, taken from their approved set, unmodified in
  colour, aspect ratio or rotation, and less prominent than your own marks.
  **The logo is not yet added** — do that before any public release.

Alternatives worth knowing about if the TMDB terms prove unworkable: TheTVDB is
free under $50k/year revenue then $1,000/year (though their KB and pricing pages
currently contradict each other on whether end-user subscriptions are required);
Trakt staff state on their forum that the API is free for commercial use, but
their site ToS §5 grants only "personal, non-commercial use" — an unresolved
conflict worth an email. Watchmode is $349/month and forbids resale.

## Backups

Export writes the current format. Import accepts **both** the current format and
the v1 `{ version, library, posterCache }` shape the previous build wrote, so
files already on disk keep working. Merge is idempotent — restoring the same
file twice does not duplicate anything.

Exports deliberately exclude API keys. The old export wrote your Anthropic key
into the backup file, which is a problem the moment that file is shared or
synced to cloud storage.

## Tests

```sh
./tools/run-tests.sh
```

Seven suites, 206 assertions:

| suite | covers |
| --- | --- |
| `match.test.mjs` | matcher scoring, offline fixtures for every known wrong-match case |
| `migration.js` | upgrading a v1 `wn_lib2` library without losing history |
| `legacy-scale.js` | the same upgrade at 513 titles, including two rows sharing one bad id |
| `meta-e2e.js` | the enrichment pipeline, run identically against mock OMDb **and** mock TMDB |
| `offline.js` | service worker: offline boot, deploy propagation, cache limits, escape hatches |
| `durability.js` | surviving a storage wipe: the mirror, recovery ordering, never clobbering good data |
| `e2e.js` | full app: navigation, watch state, undo, search, a11y, persistence |

`legacy-scale.js` uses a synthetic fixture shaped like a real library. To run it
against your own export instead:

```sh
REAL_BACKUP=~/watchnext-backup.json node tools/legacy-scale.js
```

The e2e suites drive a real Chromium at an iPhone viewport via Playwright. Every
Tier-0 bug found in the previous build has an explicit regression test, so none
of them can come back quietly.

## Keeping your library

The library is the only thing in this app that cannot be regenerated. Posters
re-fetch and metadata re-resolves, but nobody is re-entering five hundred titles
and which ones they have watched.

`localStorage` alone is not safe. WebKit deletes script-writable storage —
localStorage, IndexedDB and service worker caches alike — after seven days of
Safari **use** without visiting the site. (Days of browser use, not calendar
days, so a quiet fortnight offline does not trip it.) Home-screen web apps are
documented as exempt, but the WebKit issue tracking whether that exemption is
genuinely honoured is still open, so it is not something to bet on.

Three defences, in `src/durability.js`:

1. **Ask for persistent storage.** `navigator.storage.persist()` on boot. Often
   granted for installed web apps, and it takes the origin out of eviction.
2. **Keep a second copy in IndexedDB**, written alongside every save and
   throttled to once every 30 seconds. It does not survive a deliberate purge —
   ITP clears both — but it does survive the far more common cases: a cleared
   localStorage, a quota error, a partial wipe.
3. **Tell the user the truth and make exporting easy.** Settings shows whether
   the browser has actually guaranteed to keep the data, how much space is in
   use, and when you last exported. An export is the only defence that survives
   everything, so that is the one the UI nudges — but only once there is
   something worth losing.

Boot order is load-bearing and tested: localStorage → the legacy `wn_lib2` key →
the IndexedDB mirror → *only then* the starter seed. Seeding before checking the
mirror would hand someone whose storage was evicted a fresh 228-title starter
library and quietly bury the five hundred they actually had. Recovery only ever
fires into an empty store, so it can never overwrite good data with a stale
snapshot.

## Offline

A service worker caches the app shell and poster art, so the library opens with
no connection — which is the point of an app built around what you already own
and can watch on a plane.

The design constraint that shaped it: **never strand anyone on a stale build.**
Code and markup are network-first, so a deploy is picked up on the next load
with a connection and the cache is only ever an offline fallback. Images are
cache-first, capped at 400 entries and evicted oldest-first. API traffic is
never cached — stale metadata or a stale recommendation would be worse than
none.

Registration is scheduled on idle with a deadline rather than on the `load`
event, because `load` waits for every image on the page: on a slow connection
with a screen full of posters, gating on it means offline support fails to
activate for exactly the people who need it most.

Two escape hatches, both from the console and neither touching your library:

```js
wn.resetOfflineCache()  // purge caches, reload onto fresh code, stay offline-capable
wn.disableOffline()     // the same, but the worker stays gone across reloads
wn.enableOffline()      // undo the above
```

## Accessibility

Real semantics throughout (`<button>`, `<main>`, `<nav>`, headings), keyboard
operable, focus trapped in overlays and restored on close, zoom not suppressed,
and every text tone measured to clear WCAG AA on the surface it sits on.

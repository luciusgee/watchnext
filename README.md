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

You need your own free OMDb key (Settings → Connections). The previous version
shipped one shared key for all users; it has been over its daily limit for some
time, which is why lookups silently stopped working.

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

Five suites, 132 assertions:

| suite | covers |
| --- | --- |
| `match.test.mjs` | matcher scoring, offline fixtures for every known wrong-match case |
| `migration.js` | upgrading a v1 `wn_lib2` library without losing history |
| `legacy-scale.js` | the same upgrade at 513 titles, including two rows sharing one bad id |
| `meta-e2e.js` | the enrichment pipeline against a mock OMDb |
| `e2e.js` | full app: navigation, watch state, undo, search, a11y, persistence |

`legacy-scale.js` uses a synthetic fixture shaped like a real library. To run it
against your own export instead:

```sh
REAL_BACKUP=~/watchnext-backup.json node tools/legacy-scale.js
```

The e2e suites drive a real Chromium at an iPhone viewport via Playwright. Every
Tier-0 bug found in the previous build has an explicit regression test, so none
of them can come back quietly.

## Accessibility

Real semantics throughout (`<button>`, `<main>`, `<nav>`, headings), keyboard
operable, focus trapped in overlays and restored on close, zoom not suppressed,
and every text tone measured to clear WCAG AA on the surface it sits on.

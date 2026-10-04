/*
 * The job that reads the Savoy, Corby's listings — a GitHub Action in your
 * private sync repo, put there by the app, like the notification sender.
 *
 * The Savoy's site cannot be read from a phone (no CORS), and GitHub Pages
 * runs nothing, so an Action does it: three times a day it fetches the
 * Savoy's pages, works out the films and their showings, and saves
 * cinema/savoy-corby.json in the repo, which cinema.js reads. The script it
 * runs is src/watchnext-cinema.js in this app, copied into the repo as
 * .github/watchnext-cinema.mjs; writing a new version of it (or the file
 * cinema/refresh) starts a run straight away. Put there once per build of
 * the app and repo: a new build with a changed script updates it.
 *
 * Writing the workflow needs the token's "Workflows: Read and write"
 * permission, which turning on notifications asks for. A token without it
 * is refused, and that is remembered (until the next build, or until
 * notifications get the permission), so it is not asked again on every
 * launch; the film page still links to the Savoy's own listings.
 */

import * as sync from './sync.js';
import { BUILD } from './build.js';
import { refreshListings } from './cinema.js';

const WORKFLOW_PATH = '.github/workflows/watchnext-cinema.yml';
const SCRIPT_PATH = '.github/watchnext-cinema.mjs';

export const WORKFLOW = `# Reads the Savoy, Corby's listings for Watch Next. Written by the app — see src/cinemaSender.js.
# Three times a day, when it is first put here, and whenever the app writes a new
# version of the script (or cinema/refresh), it saves the films and showings to
# cinema/savoy-corby.json.
name: Watch Next cinema listings
on:
  schedule:
    - cron: '23 5,11,16 * * *'
  push:
    paths:
      - '${WORKFLOW_PATH}'
      - '${SCRIPT_PATH}'
      - 'cinema/refresh'
  workflow_dispatch:
permissions:
  contents: write
concurrency:
  group: watchnext-cinema
  cancel-in-progress: false
jobs:
  listings:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - uses: actions/checkout@v4
        with:
          sparse-checkout: .github
      # The workflow is written before the script; its own first run has nothing to run yet.
      - if: hashFiles('${SCRIPT_PATH}') != ''
        run: node ${SCRIPT_PATH}
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
`;

const DONE_KEY = 'wn.cinema.installed';
let installing = null;

/* What this phone last did about the job, for this build and this repo:
   'done', 'refused', or nothing yet. */
const stamp = () => `${BUILD}|${sync.config().repo}`;
function lastTime() {
  try {
    const [what, ...rest] = String(localStorage.getItem(DONE_KEY) || '').split('|');
    return rest.join('|') === stamp() ? what : null;
  } catch {
    return null;
  }
}
function remember(what) {
  try {
    localStorage.setItem(DONE_KEY, `${what}|${stamp()}`);
  } catch {
    /* looked at again next launch */
  }
}

/**
 * Put the listings job in the repo, or bring it up to date. Quiet: an
 * unchanged file is not rewritten, and a token without the Workflows
 * permission just means no listings (the film page says where to look).
 * `force` tries again after a refusal. Resolves to { ok, step?, wrote? }.
 */
export function installCinema({ force = false } = {}) {
  if (installing) return installing;
  installing = (async () => {
    if (!sync.configured()) return { ok: false, step: 'no-sync' };
    const last = lastTime();
    if (last === 'done') return { ok: true, already: true };
    if (last === 'refused' && !force) return { ok: false, step: 'workflow', already: true };
    let script;
    try {
      const res = await fetch(new URL('./watchnext-cinema.js', import.meta.url));
      if (!res.ok) throw new Error(`Could not load the listings script (${res.status})`);
      script = await res.text();
    } catch (err) {
      return { ok: false, step: 'error', error: err?.message };
    }
    try {
      /* The workflow first: if the token may not write it, nothing is left
         behind. Its own commit starts a run that finds no script and does
         nothing; the script's commit, next, starts the real one. */
      const wf = await sync.putRepoFile(WORKFLOW_PATH, WORKFLOW, 'Watch Next: cinema listings workflow');
      const js = await sync.putRepoFile(SCRIPT_PATH, script, 'Watch Next: cinema listings script');
      remember('done');
      const wrote = !!(wf?.changed || js?.changed);
      /* A run has started: its listings are there in a minute or so. */
      if (wrote) for (const ms of [75e3, 180e3]) setTimeout(() => refreshListings({ force: true }).catch(() => {}), ms);
      return { ok: true, wrote };
    } catch (err) {
      const refused = err?.status === 403 || err?.status === 404;
      if (refused) remember('refused');
      return { ok: false, step: refused ? 'workflow' : 'error', error: err?.message };
    }
  })().finally(() => {
    installing = null;
  });
  return installing;
}

/** The job put in place and the latest listings fetched, a moment from now:
    after starting up, and after sync is set up. */
export function cinemaSoon(ms = 3000) {
  setTimeout(() => {
    installCinema().catch(() => {});
    refreshListings().catch(() => {});
  }, ms);
}

/** Ask for fresh listings now: writing cinema/refresh starts a run. */
export async function refreshCinemaNow() {
  if (!sync.configured()) return false;
  await sync.putRepoFile('cinema/refresh', `${new Date().toISOString()}\n`, 'Watch Next: refresh cinema listings');
  return true;
}

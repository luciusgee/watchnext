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
 * the app: a new build with a changed script updates it.
 *
 * Writing the workflow needs the token's "Workflows: Read and write"
 * permission, which notifications already asked for.
 */

import * as sync from './sync.js';
import { BUILD } from './build.js';

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
      - run: node ${SCRIPT_PATH}
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
`;

const DONE_KEY = 'wn.cinema.installed';
let installing = null;

/**
 * Put the listings job in the repo, or bring it up to date. Quiet: an
 * unchanged file is not rewritten, and a token without the Workflows
 * permission just means no listings (the film page says where to look).
 * Resolves to { ok, step? }.
 */
export function installCinema() {
  if (installing) return installing;
  installing = (async () => {
    if (!sync.configured()) return { ok: false, step: 'no-sync' };
    try {
      if (localStorage.getItem(DONE_KEY) === BUILD) return { ok: true, already: true };
    } catch {
      /* look anyway */
    }
    try {
      const res = await fetch(new URL('./watchnext-cinema.js', import.meta.url));
      if (!res.ok) throw new Error(`Could not load the listings script (${res.status})`);
      const script = await res.text();
      /* The script first: the workflow's own commit starts the first run,
         and the script has to be there for it. */
      await sync.putRepoFile(SCRIPT_PATH, script, 'Watch Next: cinema listings script');
      await sync.putRepoFile(WORKFLOW_PATH, WORKFLOW, 'Watch Next: cinema listings workflow');
      try {
        localStorage.setItem(DONE_KEY, BUILD);
      } catch {
        /* looked at again next launch */
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, step: err?.status === 403 || err?.status === 404 ? 'workflow' : 'error', error: err?.message };
    } finally {
      installing = null;
    }
  })();
  return installing;
}

/** Ask for fresh listings now: writing cinema/refresh starts a run. */
export async function refreshCinemaNow() {
  if (!sync.configured()) return false;
  await sync.putRepoFile('cinema/refresh', `${new Date().toISOString()}\n`, 'Watch Next: refresh cinema listings');
  return true;
}

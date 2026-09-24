/*
 * Settings — three zones: Connections, Library data, Danger.
 *
 * The destructive actions are quarantined behind their own sheet rather than
 * sitting as identically-styled rows next to "Export my data", and the
 * metadata tools live here with a visible review queue so a bad match is
 * something the user can see and correct rather than silently absorb.
 */

import * as store from '../store.js';
import * as actions from '../actions.js';
import {
  el,
  clear,
  poster,
  button,
  toast,
  openSheet,
  confirmDestructive,
  emptyState,
  openPanel,
} from '../ui.js';
import { icon } from '../icons.js';
import * as meta from '../metadata.js';
import { getProvider, listProviders } from '../providers/index.js';
import { storageHealth, markBackedUp, requestPersistence } from '../durability.js';
import { BUILD } from '../build.js';
import { healState, safeAreaInsets } from '../viewport.js';
import { openMatchPicker } from './match.js';
import { runtime, relativeTime, plural } from '../format.js';
import { MODELS, currentModel } from '../ai.js';
import * as sync from '../sync.js';
import * as haptics from '../haptics.js';

let root = null;
let bodyEl = null;
let navigate = null;
let sweepController = null;
let syncWatcher = null;
/* A message about sync that has to survive the render() that follows the
   action which produced it. The public-repo warning used to be painted and
   destroyed in the same tick. */
let syncNotice = null;
/* The last storage-health reading, painted synchronously on the next render so
   the block does not empty and refill — and move everything below it — on
   every tap. */
let lastHealth = null;
let renderPending = false;

/* A field in Settings has focus. A background sync emits 'item' every so often,
   and a full re-render then destroyed the field mid-token, dropped the
   keyboard and threw away what had been typed. */
const editing = () =>
  root.contains(document.activeElement) &&
  document.activeElement.matches('input:not([type="checkbox"]):not([type="radio"]), textarea');

export function initSettings({ navigate: nav }) {
  navigate = nav;
  root = document.getElementById('screen-settings');
  bodyEl = root.querySelector('[data-region="body"]');
  store.subscribe((r) => {
    if (r !== 'item' || !root.classList.contains('is-active')) return;
    if (editing()) {
      renderPending = true;
      return;
    }
    render();
  });
  root.addEventListener('focusout', () =>
    setTimeout(() => {
      if (renderPending && !editing()) {
        renderPending = false;
        render();
      }
    })
  );
}

/** Helper copy under a control. One style, where there were four line-heights
    and three top margins across a dozen hand-typed copies. */
function hint(text, extra = '') {
  return el('div', { class: 'group-hint', style: extra, text });
}

/** A status line that is announced when it changes. */
function statusLine(extra = '') {
  return el('div', { class: 'group-hint', role: 'status', style: extra });
}

/**
 * Run a network call from a button without letting it be tapped again.
 *
 * Save, Turn on sync, Sync now and the storage request all await something,
 * and stayed live and unchanged while they did — a second tap sent a second
 * request and raised a second toast.
 */
async function busy(btn, label, work) {
  const t = btn.querySelector('span:last-child');
  const was = t?.textContent;
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  if (t) t.textContent = label;
  try {
    return await work();
  } finally {
    if (btn.isConnected) {
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
      if (t) t.textContent = was;
    }
  }
}

export function showSettings(params = {}) {
  render();
  if (params.focus === 'ai') {
    root.querySelector('#ai-key')?.focus();
  } else if (params.focus === 'review') {
    openReviewQueue();
  } else if (params.focus === 'sweep') {
    /* Sent here from Add with titles waiting for details. Scrolling to the
       control is the difference between "here is the thing you wanted" and
       "here is Settings, find it". */
    const target = root.querySelector('[data-region="sweep"]') || root.querySelector('#screen-settings .group');
    target?.scrollIntoView({ block: 'center' });
  }
}

function render() {
  renderPending = false;
  clear(bodyEl);

  bodyEl.appendChild(groupLabel('Connections'));
  bodyEl.appendChild(connectionsGroup());

  /* Named for what they hold. "Library data" and "Your data" were a pair of
     near-identical headings over unrelated things. */
  bodyEl.appendChild(groupLabel('Posters & details'));
  bodyEl.appendChild(dataGroup());

  bodyEl.appendChild(groupLabel('Sync'));
  bodyEl.appendChild(syncGroup());

  bodyEl.appendChild(groupLabel('Backup'));
  bodyEl.appendChild(backupGroup());
  refreshStorageHealth();

  bodyEl.appendChild(groupLabel('Who watches here'));
  bodyEl.appendChild(peopleGroup());

  bodyEl.appendChild(groupLabel('What to suggest'));
  bodyEl.appendChild(tasteGroup());

  bodyEl.appendChild(groupLabel('This phone'));
  bodyEl.appendChild(deviceGroup());

  bodyEl.appendChild(groupLabel('Recent activity'));
  bodyEl.appendChild(activityGroup());

  bodyEl.appendChild(groupLabel('Reset'));
  bodyEl.appendChild(dangerGroup());

  bodyEl.appendChild(aboutBlock());
}

function groupLabel(text) {
  return el('h2', { class: 'eyebrow group-label', text });
}

function summaryLine(s) {
  const bits = [];
  if (s.done) bits.push(`${s.done} verified`);
  if (s.stale) bits.push(`${s.stale} to re-check`);
  if (s.pending) bits.push(`${s.pending} never looked up`);
  if (s.review) bits.push(`${s.review} need you to choose`);
  if (s.unmatched) bits.push(`${s.unmatched} not found`);
  if (!bits.length) return s.total === 1 ? 'Your one title has verified details.' : `All ${s.total} titles have verified details.`;
  return `${plural(s.total, 'title')} — ` + bits.join(', ') + '.';
}

/* ── connections ── */

function connectionsGroup() {
  const g = el('div', { class: 'group' });
  const s = store.settings();

  /* Metadata source */
  const active = getProvider(s.provider);
  const box = el('div', { class: 'group-pad' });
  box.appendChild(el('h3', { class: 'group-item-t', text: 'Film database', style: 'margin-bottom:var(--s1)' }));
  box.appendChild(
    el('div', {
      class: 'group-item-s',
      style: 'margin-bottom:var(--s3)',
      text: 'Where posters, runtimes and descriptions come from. Use TMDB; OMDb is here for older setups.',
    })
  );

  const seg = el('div', {
    class: 'seg',
    role: 'group',
    'aria-label': 'Film database',
    style: 'margin-bottom:var(--s3)',
  });
  for (const p of listProviders()) {
    seg.appendChild(
      el('button', {
        type: 'button',
        'data-haptic': true,
        'aria-pressed': String(p.id === active.id),
        text: p.label,
        onclick: () => {
          store.updateSettings({ provider: p.id });
          render();
        },
      })
    );
  }
  box.appendChild(seg);

  const keys = s.dataKeys || {};
  /* A form, so the keyboard's Return saves. */
  const keyRow = el('form', { style: 'display:flex;gap:var(--s2)' });
  keyRow.addEventListener('submit', (e) => {
    e.preventDefault();
    saveBtn.click();
  });
  const keyInput = el('input', {
    id: 'data-key',
    class: 'input',
    type: 'password',
    autocomplete: 'off',
    autocapitalize: 'off',
    autocorrect: 'off',
    spellcheck: 'false',
    enterkeyhint: 'done',
    placeholder: active.keyPlaceholder,
    value: keys[active.id] || '',
    'aria-label': active.keyLabel,
  });
  keyRow.appendChild(keyInput);

  /* Saving a key checks it. Storing a string and calling that "Connected" is
     how someone ends up discovering their key never worked part-way through a
     500-title sweep — the state we actually want to show is "this key answered
     a request", not "this box is non-empty". */
  const keyStatus = statusLine();

  const paintStatus = (state, message) => {
    const colour = { ok: 'var(--sage)', bad: 'var(--ember)', busy: 'var(--ash)', idle: 'var(--ash)' }[state];
    keyStatus.style.color = colour;
    keyStatus.textContent = message;
  };

  const saved = (s.keyStatus || {})[active.id];
  if (!keys[active.id]) paintStatus('idle', '');
  else if (saved?.ok === true) paintStatus('ok', 'Connected — this key answered a test request.');
  else if (saved?.ok === false) paintStatus('bad', saved.message || 'This key was rejected.');
  else paintStatus('idle', 'Saved, but not checked yet.');

  const saveBtn = button('Save', {
    kind: 'secondary',
    onClick: () => busy(saveBtn, 'Checking…', async () => {
      const value = keyInput.value.trim();
      store.updateSettings({ dataKeys: { ...(store.settings().dataKeys || {}), [active.id]: value } });

      if (!value) {
        store.updateSettings({ keyStatus: { ...(store.settings().keyStatus || {}), [active.id]: null } });
        toast('Key cleared');
        render();
        return;
      }

      paintStatus('busy', `Checking the key with ${active.label}…`);
      let result;
      try {
        result = await active.verifyKey(value);
      } catch (err) {
        result = { ok: null, message: err?.message || 'Could not check the key.' };
      }

      /* ok === null means we could not tell (offline, provider down). Recording
         that as a failure would be a lie, so it is left unverified. */
      if (result.ok === null) {
        store.updateSettings({ keyStatus: { ...(store.settings().keyStatus || {}), [active.id]: null } });
        paintStatus('idle', result.message);
        return;
      }

      store.updateSettings({
        keyStatus: {
          ...(store.settings().keyStatus || {}),
          [active.id]: { ok: result.ok, message: result.message || '', at: Date.now() },
        },
      });

      if (result.ok) {
        paintStatus('ok', result.message || 'Connected — this key answered a test request.');
        toast('Key saved and working');
        render();
      } else {
        paintStatus('bad', result.message || 'This key was rejected.');
      }
    }),
  });
  keyRow.appendChild(saveBtn);

  box.appendChild(keyRow);
  box.appendChild(hint(active.keyHint));
  box.appendChild(keyStatus);
  g.appendChild(box);

  /* Anthropic */
  const ai = el('div', { class: 'group-pad', style: 'border-top:1px solid var(--hairline)' });
  ai.appendChild(el('h3', { class: 'group-item-t', text: 'Assisted picks', style: 'margin-bottom:var(--s1)' }));
  ai.appendChild(
    el('div', {
      class: 'group-item-s',
      style: 'margin-bottom:var(--s3)',
      text: 'An Anthropic API key powers the Ask tab and the “say what you fancy” box in the picker. Your key is stored on this device only and sent directly to Anthropic — it never passes through anyone else’s server.',
    })
  );
  const aiRow = el('form', { style: 'display:flex;gap:var(--s2)' });
  const aiInput = el('input', {
    id: 'ai-key',
    class: 'input',
    type: 'password',
    autocomplete: 'off',
    autocapitalize: 'off',
    autocorrect: 'off',
    spellcheck: 'false',
    enterkeyhint: 'done',
    placeholder: 'sk-ant-…',
    value: s.aiKey || '',
    'aria-label': 'Anthropic API key',
  });
  aiRow.appendChild(aiInput);
  /* Inline, in the same place and colours as the film key's. This one used to
     say a green "Connected" for any string starting "sk-" — beside a film key
     that is careful never to claim that without a test request — and put its
     errors in a toast. */
  const aiStatus = statusLine();
  const saveAi = () => {
    const v = aiInput.value.trim();
    if (v && !v.startsWith('sk-')) {
      aiStatus.style.color = 'var(--ember)';
      aiStatus.textContent = 'That does not look like an Anthropic key — they start sk-ant-.';
      return;
    }
    store.updateSettings({ aiKey: v });
    toast(v ? 'Key saved' : 'Key cleared');
    render();
  };
  aiRow.addEventListener('submit', (e) => {
    e.preventDefault();
    saveAi();
  });
  aiRow.appendChild(button('Save', { kind: 'secondary', type: 'submit' }));
  ai.appendChild(aiRow);
  ai.appendChild(aiStatus);
  if (s.aiKey) {
    aiStatus.style.color = 'var(--ash)';
    aiStatus.textContent = 'Saved on this phone. It is checked the first time you ask.';
    /* Only once there is a key to spend. Offering a choice of models to
       somebody who cannot call any of them is a decision about nothing.
       The costs are on the pills because it is his bill, not the app's — a
       tier list without prices makes "Best" look free. */
    ai.appendChild(el('div', { class: 'eyebrow', style: 'margin:var(--s5) 0 var(--s3)', text: 'Which Claude' }));
    const chosen = currentModel();
    const row = el('div', { style: 'display:flex;flex-wrap:wrap;gap:var(--s2)' });
    for (const m of MODELS) {
      const active = m.id === chosen.id;
      /* No inline style: .pill[aria-pressed] draws the chosen state, and an
         inline background here overrode its press feedback. */
      row.appendChild(
        el('button', {
          class: 'pill',
          type: 'button',
          'data-haptic': true,
          'aria-pressed': String(active),
          text: m.label,
          onclick: () => {
            store.updateSettings({ aiModel: m.id });
            render();
          },
        })
      );
    }
    ai.appendChild(row);
    ai.appendChild(hint(chosen.note, 'margin-top:var(--s3)'));
  }
  g.appendChild(ai);

  return g;
}

/* ── sync ──
   A private repo as the shared shelf. See sync.js for why it is git and not a
   database, and what that costs. */

function syncGroup() {
  const g = el('div', { class: 'group' });
  const cfg = sync.config();

  const box = el('div', { class: 'group-pad' });
  box.appendChild(el('h3', { class: 'group-item-t', text: 'Share a library', style: 'margin-bottom:var(--s1)' }));
  box.appendChild(
    el('div', {
      class: 'group-item-s',
      style: 'margin-bottom:var(--s3)',
      text:
        'Keep this library in a GitHub repo, so two phones share one shelf and every change is a commit you can roll back to. ' +
        'Films added on either phone appear on the other within about half a minute.',
    })
  );
  /* Said here rather than discovered on github.com. The repo that serves this
     app has to be public for Pages; the one holding a watch history does not. */
  box.appendChild(
    hint(
      'Use a private repo — not the one this app is published from. A public repo means anyone can read what you own and what you have watched.',
      'color:var(--amber);margin:0 0 var(--s4)'
    )
  );

  /* Labelled, because once saved one field shows "luke/watchnext-data" and the
     other a row of dots, and placeholders say nothing then. A form, so Return
     on the keyboard does what the button does. */
  const form = el('form');
  form.appendChild(el('label', { class: 'field-label', for: 'sync-repo', text: 'Repository' }));
  const repo = el('input', {
    id: 'sync-repo',
    class: 'input',
    type: 'text',
    inputmode: 'url',
    autocomplete: 'off',
    /* spellcheck=false does not stop iOS turning "luke/…" into "Luke/…". */
    autocapitalize: 'off',
    autocorrect: 'off',
    spellcheck: 'false',
    enterkeyhint: 'next',
    placeholder: 'yourname/watchnext-data',
    value: cfg.repo,
  });
  form.appendChild(repo);
  form.appendChild(
    el('label', { class: 'field-label', for: 'sync-token', text: 'Access token', style: 'margin-top:var(--s3)' })
  );
  const token = el('input', {
    id: 'sync-token',
    class: 'input',
    type: 'password',
    autocomplete: 'off',
    autocapitalize: 'off',
    autocorrect: 'off',
    spellcheck: 'false',
    enterkeyhint: 'go',
    placeholder: 'github_pat_…',
    value: cfg.token,
  });
  form.appendChild(token);
  form.appendChild(
    hint(
      'A fine-grained token with Contents: read and write, on that one repo only. Both phones use the same one. Lose a phone and you revoke it on github.com.'
    )
  );

  /* One line owns sync's state: what the last action concluded, then what the
     background sync is doing. Two lines used to print "Syncing…" and the same
     error one above the other. */
  const verdict = statusLine('margin-top:var(--s3)');
  const say = (text, colour) => {
    verdict.textContent = text;
    verdict.style.color = colour;
  };
  if (syncNotice) {
    say(syncNotice.text, syncNotice.colour);
    syncNotice = null;
  }

  const row = el('div', { style: 'display:flex;gap:var(--s2);margin-top:var(--s3);flex-wrap:wrap' });
  /* Amber only for the call to action. Once sync is on, an amber "Save" for
     fields nobody had changed was the loudest thing on the screen. */
  const save = button(cfg.enabled ? 'Save' : 'Turn on sync', {
    kind: cfg.enabled ? 'secondary' : 'primary',
    type: 'submit',
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    busy(save, 'Checking…', async () => {
      const tidy = sync.normaliseRepo(repo.value);
      repo.value = tidy;
      store.updateSettings({
        sync: { ...cfg, repo: tidy, token: token.value.trim(), enabled: true },
      });
      const result = await sync.check();
      if (!result.ok) {
        /* Left switched off rather than saved broken: an enabled sync that
           cannot write would sit there reporting errors and quietly not
           backing anything up. Re-rendered, so the group stops offering Sync
           now and a "Last synced" for a sync that is now off. */
        store.updateSettings({ sync: { ...sync.config(), enabled: false } });
        syncNotice = { text: result.message, colour: 'var(--ember)' };
        render();
        return;
      }
      if (result.warning) syncNotice = { text: result.warning, colour: 'var(--amber)' };
      sync.start();
      toast(cfg.enabled ? 'Sync settings saved' : 'Sync on');
      render();
    });
  });
  row.appendChild(save);
  if (cfg.enabled) {
    const now = button('Sync now', {
      kind: 'secondary',
      /* No verdict of its own. syncNow() returns false both for "nothing to
         do" and for "a sync was already running", so "Already up to date"
         was sometimes untrue; the live line reports what actually happens. */
      onClick: () => busy(now, 'Syncing…', () => sync.syncNow({ note: 'Manual sync' })),
    });
    row.appendChild(now);
    row.appendChild(
      button('Turn off', {
        kind: 'quiet',
        onClick: () => {
          store.updateSettings({ sync: { ...sync.config(), enabled: false } });
          toast('Sync off. Your library stays on this phone.');
          render();
        },
      })
    );
  }
  form.appendChild(row);
  box.appendChild(form);
  box.appendChild(verdict);

  if (cfg.enabled) {
    const live = statusLine();
    const paint = (st) => {
      const since = st.lastOk ? ` Last synced ${relativeTime(st.lastOk)}.` : '';
      live.textContent =
        st.phase === 'syncing'
          ? 'Syncing…'
          : st.phase === 'error' || st.phase === 'offline'
            ? `${st.message}${since}`
            : st.lastOk
              ? `Last synced ${relativeTime(st.lastOk)}`
              : 'Waiting for the first sync.';
      live.style.color = st.phase === 'error' ? 'var(--ember)' : 'var(--ash)';
    };
    paint(sync.status());
    /* Unsubscribed when Settings is re-rendered, not left accumulating one
       listener per visit. */
    if (syncWatcher) syncWatcher();
    syncWatcher = sync.watch(paint);
    box.appendChild(live);
  }

  g.appendChild(box);
  return g;
}

/* ── metadata ── */

/* The controls a running sweep reports into. Re-bound on every render, so a
   sweep started before leaving Settings still paints the live bar when you come
   back, rather than writing progress into a detached element. */
let sweepUi = null;
let sweepProgress = null; // { index, total, title }

function dataGroup() {
  const g = el('div', { class: 'group' });
  const summary = meta.enrichmentSummary(store.items());

  /* Named so Add can send someone straight here after a bulk paste — see
     showSettings({ focus: 'sweep' }). */
  const status = el('div', { class: 'group-pad', 'data-region': 'sweep' });

  /* An empty library has nothing to report. It used to say "All 0 titles have
     verified details" above a 0% bar and a button labelled as a status. */
  if (!summary.total) {
    status.appendChild(
      el('div', { class: 'group-item-s', text: 'Posters and details are fetched here once you add titles.' })
    );
    g.appendChild(status);
    return g;
  }

  status.appendChild(el('div', { class: 'group-item-s', style: 'margin-bottom:var(--s3)', text: summaryLine(summary) }));
  if (summary.stale) {
    status.appendChild(
      el('div', {
        class: 'group-item-s',
        style: 'margin-bottom:var(--s3);color:var(--amber)',
        text: 'These came across from the previous version, where roughly a third of titles had another film’s poster and description attached. Re-checking will correct them.',
      })
    );
  }

  const bar = el('div', { class: 'progress-line', style: 'border-radius:2px;margin-bottom:var(--s3)' });
  const fill = el('i', { style: `width:${(summary.done / summary.total) * 100}%` });
  bar.appendChild(fill);
  status.appendChild(bar);

  const progressText = el('div', {
    'data-region': 'sweep-status',
    role: 'status',
    class: 'group-hint',
    style: 'margin:0 0 var(--s3);min-height:18px',
  });
  status.appendChild(progressText);

  const controls = el('div', { style: 'display:flex;gap:var(--s2);flex-wrap:wrap' });
  let checkBtn = null;
  if (summary.todo || sweepController) {
    checkBtn = button(`Check ${plural(summary.todo, 'title')}`, {
      kind: 'primary',
      iconName: 'search',
      onClick: () => (sweepController ? stopSweep() : runSweep({ force: false })),
    });
    controls.appendChild(checkBtn);
  } else if (!summary.review && !summary.unmatched) {
    /* A status, said as one — not a bordered button that toasts "Nothing
       needs looking up" when pressed. */
    progressText.style.color = 'var(--sage)';
    progressText.textContent = 'Everything is up to date.';
  }
  /* "Not found" titles belong in the queue too: they can be searched for by
     hand there. A queue made only of those used to have no button at all. */
  const toFix = summary.review + summary.unmatched;
  if (toFix) {
    controls.appendChild(
      button(`Review ${toFix}`, {
        kind: 'secondary',
        iconName: 'warning',
        onClick: openReviewQueue,
      })
    );
  }
  controls.appendChild(
    button('Re-check everything', {
      kind: 'quiet',
      iconName: 'refresh',
      onClick: () =>
        openSheet({
          title: 'Re-check every title?',
          message: `This looks up all ${plural(summary.total, 'title')} again. It only replaces details you have not edited yourself, but it uses your daily API allowance.`,
          actions: [
            {
              label: 'Re-check everything',
              kind: 'primary',
              /* Restarts rather than toggling: during a sweep this used to hit
                 the stop branch and cancel the run it was meant to replace. */
              onClick: () => runSweep({ force: true }, { restart: true }),
            },
          ],
        }),
    })
  );
  status.appendChild(controls);
  g.appendChild(status);

  sweepUi = { text: progressText, bar: fill, btn: checkBtn, done: summary.done, total: summary.total };
  if (sweepController) paintSweep();
  return g;
}

/** Repaint the live sweep controls from the current progress. */
function paintSweep() {
  const ui = sweepUi;
  if (!ui || !ui.text.isConnected) return;
  if (ui.btn) {
    ui.btn.className = 'btn btn-quiet';
    ui.btn.querySelector('span:last-child').textContent = 'Stop';
  }
  if (!sweepProgress) {
    ui.text.textContent = 'Starting…';
    return;
  }
  const { index, total, title } = sweepProgress;
  ui.text.style.color = 'var(--ash)';
  ui.text.textContent = `Looking up ${title} — ${index + 1} of ${total}`;
  /* The bar used to be set once at render and sit frozen for the whole run. */
  ui.bar.style.width = `${Math.min(100, ((ui.done + index + 1) / ui.total) * 100)}%`;
}

function stopSweep() {
  sweepController?.abort();
}

async function runSweep(opts, { restart = false } = {}) {
  const settings = store.settings();
  const provider = getProvider(settings.provider);
  const key = (settings.dataKeys || {})[provider.id];
  if (!key) {
    toast(`Add a ${provider.label} key first`);
    document.getElementById('data-key')?.focus();
    return;
  }
  if (sweepController) {
    sweepController.abort();
    sweepController = null;
    if (!restart) return;
  }

  const list = store.items()
    .filter((i) => meta.needsEnrichment(i, opts))
    /* Order by how likely you are to see it. A free key allows 1000 lookups a
       day, so a large library may not finish in one go — this makes sure the
       run that does happen fixes the titles you own and have not watched
       first, rather than whatever happens to be alphabetically early. */
    .sort((a, b) => score(b) - score(a));

  function score(i) {
    let n = 0;
    if (i.owned && !i.watched) n += 8;
    if (i.owned) n += 5;
    if (!i.watched) n += 3;
    if (!i.poster) n += 4;          // visibly broken
    if (!i.overview) n += 2;
    if (i.meta?.status === 'stale') n += 1;
    return n;
  }

  if (!list.length) {
    toast('Nothing needs looking up');
    return;
  }

  const budget = new meta.RequestBudget(provider.dailyLimit, provider.id);
  const controller = new AbortController();
  sweepController = controller;
  sweepProgress = null;
  paintSweep();

  const result = await meta.sweep(list, {
    provider,
    key,
    budget,
    signal: controller.signal,
    onProgress: ({ index, total, item }) => {
      sweepProgress = { index, total, title: item.title };
      paintSweep();
    },
    apply: (item, res) => {
      if (res.status === 'matched' && res.chosen) {
        store.update(item.uid, meta.toPatch(item, res.chosen, res.confidence, provider.id));
      } else {
        store.update(item.uid, {
          meta: {
            v: meta.META_VERSION,
            status: res.status,
            at: Date.now(),
            confidence: res.confidence,
            /* Store the neutral Record shape so the review queue does not
               need to know which provider produced it. */
            candidates: (res.candidates || []).slice(0, 6).map((c) => ({
              sourceId: c.sourceId,
              imdbId: c.imdbId,
              title: c.title,
              year: c.year,
              type: c.type,
              poster: c.poster,
            })),
          },
        });
      }
    },
  });

  /* A restart has already replaced this run; its tail must not clear the new
     one's controller or report over it. */
  if (sweepController !== controller) return;
  sweepController = null;
  sweepProgress = null;
  store.saveNow();
  store.emit('item');

  if (result.error?.code === 'auth') {
    /* The provider's own message says what to do about it; the generic
       "rejected" left people requesting a second key they cannot be issued. */
    toast(result.error.message || `That ${provider.label} key was rejected`, { duration: 9000 });
    store.updateSettings({
      keyStatus: {
        ...(store.settings().keyStatus || {}),
        [provider.id]: { ok: false, message: result.error.message || '', at: Date.now() },
      },
    });
    render();
    return;
  }
  if (result.error?.code === 'budget') {
    toast('Daily API limit reached — try again tomorrow');
    render();
    return;
  }
  if (result.error?.code === 'network' || result.error?.code === 'rate') {
    toast(
      result.error.code === 'network'
        ? `Lost the connection after ${plural(result.matched, 'title')} — nothing else was changed. Try again when you’re back online.`
        : `${provider.label} asked us to slow down after ${plural(result.matched, 'title')}. Try again in a minute.`,
      { duration: 6000 }
    );
    render();
    return;
  }

  const bits = [`${result.matched} matched`];
  if (result.review) bits.push(`${result.review} need checking`);
  if (result.unmatched) bits.push(`${result.unmatched} not found`);
  toast(result.stopped ? 'Stopped' : bits.join(' · '));
  render();
}

/**
 * A pill you tap to remove something: the label truncates, the close icon never
 * does. Long titles used to overflow the card with the text ✕ — the one part
 * that said the pill was tappable — clipped off the end.
 */
function removablePill(label, aria, onclick, { muted = false } = {}) {
  const b = el('button', {
    class: `pill pill-removable${muted ? ' is-muted' : ''}`,
    type: 'button',
    'aria-label': aria,
    onclick,
  });
  b.appendChild(el('span', { class: 'pill-t', text: label }));
  b.appendChild(el('span', { html: icon('close', 14), 'aria-hidden': 'true' }).firstChild);
  return b;
}

/* ── household ──
   One shelf, separate watch histories. The question on a sofa is "something I
   have seen and she has not", and a single watched flag cannot answer it.

   Nothing here changes anything until there are two people: with one name, or
   none, the app behaves exactly as it did and the switcher never appears. */

function peopleGroup() {
  const g = el('div', { class: 'group' });
  const box = el('div', { class: 'group-pad' });
  const list = store.people();

  box.appendChild(
    el('div', {
      class: 'group-item-s',
      style: 'margin-bottom:var(--s3)',
      text: list.length
        ? 'Everyone here shares the shelf but keeps their own watch history. Tonight answers for whoever is watching.'
        : 'Watching with someone else? Add both of you and the app will keep separate watch histories on the same shelf. Everything already marked watched becomes the first person’s.',
    })
  );

  if (list.length) {
    const row = el('div', { style: 'display:flex;flex-wrap:wrap;gap:var(--s2);margin-bottom:var(--s4)' });
    for (const p of list) {
      const seen = store.items().filter((i) => store.seenBy(i, p.id)).length;
      row.appendChild(
        removablePill(`${p.name} · ${seen} seen`, `Remove ${p.name}`, () =>
          confirmDestructive({
            title: `Remove ${p.name}?`,
            message: seen
              ? `Their ${plural(seen, 'watch mark')} go with them. Every film stays in your library.`
              : 'Every film stays in your library.',
            confirmLabel: 'Remove',
            onConfirm: () => {
              store.removePerson(p.id);
              store.emit('item');
              render();
            },
          })
        )
      );
    }
    box.appendChild(row);
  }

  const form = el('form', { style: 'display:flex;gap:var(--s2)' });
  const input = el('input', {
    class: 'input',
    type: 'text',
    placeholder: list.length ? 'Another name' : 'Your name',
    'aria-label': 'Add a person',
    autocomplete: 'off',
    autocapitalize: 'words',
    enterkeyhint: 'done',
    maxlength: '24',
  });
  form.appendChild(input);
  form.appendChild(button('Add', { kind: 'secondary', type: 'submit' }));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const person = store.addPerson(input.value);
    if (!person) return;
    store.emit('item');
    toast(
      store.people().length === 1
        ? `${person.name} added — everything marked watched is now theirs`
        : `${person.name} added`
    );
    render();
  });
  box.appendChild(form);

  g.appendChild(box);
  return g;
}

/* ── taste ──
   Anything muted has to be visible and reversible somewhere. A preference you
   cannot find again is indistinguishable from a bug — you stop seeing a film,
   you do not remember telling the app not to show it, and the app looks broken
   rather than obedient. */

function tasteGroup() {
  const g = el('div', { class: 'group' });
  const box = el('div', { class: 'group-pad' });
  const prefs = store.tastePrefs();

  box.appendChild(
    el('div', {
      class: 'group-item-s',
      style: 'margin-bottom:var(--s3)',
      text: 'Mute a genre you never watch, or a franchise you are done with. Nothing is deleted — muted titles stay in your library and still show up in search.',
    })
  );

  /* Genres, drawn from what is actually in the library rather than a fixed
     list — a mute for a genre you do not own is noise. */
  /* Every genre, and always anything muted: a genre muted while it was
     common could fall off a top-14 list, taking the only control that
     unmutes it with it. */
  const genres = [...new Set([...prefs.genres, ...store.genresInUse()])];
  if (genres.length) {
    box.appendChild(el('div', { class: 'eyebrow', style: 'margin:var(--s2) 0', text: 'Genres' }));
    const row = el('div', { style: 'display:flex;flex-wrap:wrap;gap:var(--s2);margin-bottom:var(--s4)' });
    for (const gname of genres) {
      const off = prefs.genres.includes(gname);
      /* Struck through in ember, at the same width. The label used to grow
         " — muted", which widened the pill ~60px and reshuffled the row under
         the finger, and the pressed amber fill mixed with an ember border. */
      row.appendChild(
        el(
          'button',
          {
            class: off ? 'pill is-muted' : 'pill',
            type: 'button',
            'data-haptic': true,
            'aria-pressed': String(off),
            'aria-label': off ? `${gname}, muted` : gname,
            onclick: () => {
            store.setTaste('genres', gname, !off);
            store.saveNow();
            store.emit('item');
            render();
          },
          },
          el('span', { class: 'pill-t', text: gname })
        )
      );
    }
    box.appendChild(row);
  }

  /* Franchises are a substring on the title, which is crude and is the right
     amount of machinery: "Marvel" is not a field, and nobody wants to build a
     franchise database to stop being shown Fast & Furious. */
  box.appendChild(el('div', { class: 'eyebrow', style: 'margin:var(--s2) 0', text: 'Titles containing' }));
  const addRow = el('form', { style: 'display:flex;gap:var(--s2);margin-bottom:var(--s3)' });
  const input = el('input', {
    class: 'input',
    type: 'text',
    placeholder: 'e.g. Fast & Furious',
    'aria-label': 'Mute titles containing',
    autocomplete: 'off',
    autocorrect: 'off',
    enterkeyhint: 'done',
    maxlength: '60',
  });
  addRow.appendChild(input);
  addRow.appendChild(button('Mute', { kind: 'secondary', type: 'submit' }));
  addRow.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = input.value.trim();
    if (!v) return;
    store.setTaste('franchises', v, true);
    store.saveNow();
    store.emit('item');
    render();
  });
  box.appendChild(addRow);

  if (prefs.franchises.length) {
    const row = el('div', { style: 'display:flex;flex-wrap:wrap;gap:var(--s2);margin-bottom:var(--s4)' });
    for (const f of prefs.franchises) {
      row.appendChild(
        removablePill(
          f,
          `Stop muting titles containing ${f}`,
          () => {
            store.setTaste('franchises', f, false);
            store.saveNow();
            store.emit('item');
            render();
          },
          { muted: true }
        )
      );
    }
    box.appendChild(row);
  }

  /* Individually muted films, named — this is the list someone comes looking
     for when a film has quietly stopped appearing. */
  const never = prefs.never.map((uid) => store.byUid(uid)).filter(Boolean);
  if (never.length) {
    box.appendChild(
      el('div', { class: 'eyebrow', style: 'margin:var(--s2) 0', text: `Not suggested (${never.length})` })
    );
    const row = el('div', { style: 'display:flex;flex-wrap:wrap;gap:var(--s2)' });
    for (const item of never) {
      row.appendChild(
        removablePill(
          item.title,
          `Suggest ${item.title} again`,
          () => {
            store.setTaste('never', item.uid, false);
            store.saveNow();
            store.emit('item');
            render();
          },
          { muted: true }
        )
      );
    }
    box.appendChild(row);
  }

  g.appendChild(box);
  return g;
}

/* ── review queue ── */

function openReviewQueue() {
  /* Built on openPanel, so it slides like every other sheet. It used to be
     inserted already open and removed outright — and since every choice
     closed and reopened it, each decision made the whole screen blink. It
     now stays put while the resolved title folds out of the list. */
  const { panel, close, show } = openPanel({
    label: 'Confirm matches',
    className: 'has-pinned',
    style: 'max-height:88vh;overflow-y:auto',
    onClose: () => render(),
  });

  panel.appendChild(el('div', { class: 'sheet-grip' }));
  panel.appendChild(el('div', { class: 'sheet-title', text: 'Confirm matches' }));
  panel.appendChild(
    el('div', {
      class: 'sheet-msg',
      text: 'These titles matched more than one film, or none at all. Pick the right one so the poster and description are correct.',
    })
  );

  const list = el('div');
  panel.appendChild(list);

  const fill = () => {
    clear(list);
    const queue = store.items().filter((i) => i.meta?.status === 'review' || i.meta?.status === 'unmatched');
    if (!queue.length) {
      list.appendChild(
        emptyState({ iconName: 'check', title: 'Nothing to confirm', message: 'Every title matched cleanly.' })
      );
      return;
    }
    for (const item of queue) list.appendChild(reviewCard(item, handlers));
  };
  const handlers = {
    resolved(card) {
      card.style.transition = 'opacity var(--fast) var(--ease)';
      card.style.opacity = '0';
      setTimeout(() => {
        card.remove();
        if (!list.querySelector('[data-review]')) fill();
      }, 160);
    },
    reroute(item) {
      close();
      openMatchPicker(store.byUid(item.uid) || item, { onDone: openReviewQueue });
    },
  };
  fill();

  panel.appendChild(
    el(
      'div',
      { class: 'sheet-actions is-pinned' },
      /* Secondary, as the match picker's Done is: closing is not the call to
         action in either. */
      button('Done', { kind: 'secondary', block: true, onClick: close })
    )
  );
  show();
}

function reviewCard(item, { resolved, reroute }) {
  const card = el('div', {
    'data-review': item.uid,
    style: 'padding:var(--s4) 0;border-bottom:1px solid var(--hairline)',
  });
  card.appendChild(el('div', { style: 'font-weight:620;margin-bottom:2px', text: item.title }));
  card.appendChild(
    el('div', {
      style: 'font-size:var(--t-meta);color:var(--ash);margin-bottom:var(--s3)',
      text: [item.year, item.type === 'tv' ? 'Series' : 'Film'].filter(Boolean).join(' · '),
    })
  );

  const candidates = item.meta?.candidates || [];
  if (!candidates.length) {
    card.appendChild(
      el('div', {
        style: 'font-size:var(--t-sub);color:var(--ash);margin-bottom:var(--s3)',
        text: 'No candidates found for this title.',
      })
    );
  }

  for (const c of candidates) {
    const b = el('div', { style: 'flex:1;min-width:0' });
    const row = el('button', {
      type: 'button',
      class: 'result-row',
      onclick: async () => {
        /* Say which one was chosen while the details come back, and stop a
           second tap landing on a different candidate. */
        for (const r of card.querySelectorAll('button')) r.disabled = true;
        row.style.opacity = '1';
        b.appendChild(el('div', { style: 'font-size:11px;color:var(--amber)', text: 'Saving…' }));

        const settings = store.settings();
        const provider = getProvider(settings.provider);
        const key = (settings.dataKeys || {})[provider.id];
        store.update(item.uid, {
          imdbId: c.imdbId || null,
          meta: {
            v: meta.META_VERSION,
            status: 'matched',
            at: Date.now(),
            confidence: 1,
            source: 'user',
            sourceId: c.sourceId,
          },
        });
        if (key) {
          try {
            const full = await provider.details(c.sourceId, c.type, {
              provider,
              key,
              budget: new meta.RequestBudget(provider.dailyLimit, provider.id),
            });
            if (full) store.update(item.uid, meta.toPatch(store.byUid(item.uid), full, 1, provider.id));
          } catch {
            /* the choice is saved either way; details fill in on the next sweep */
          }
        }
        store.saveNow();
        store.emit('item');
        toast(`${item.title} matched`);
        resolved(card);
      },
    });

    row.appendChild(
      poster({ title: c.title, poster: c.poster && c.poster !== 'N/A' ? c.poster : null }, { width: 38 })
    );
    b.appendChild(el('div', { style: 'font-size:var(--t-body);font-weight:550', text: c.title }));
    b.appendChild(
      el('div', {
        style: 'font-size:var(--t-meta);color:var(--ash)',
        /* Providers call a series "tv"; this checked for "series", so every
           series in the queue was labelled Film. */
        text: [c.year, c.type === 'tv' || c.type === 'series' ? 'Series' : 'Film'].filter(Boolean).join(' · '),
      })
    );
    row.appendChild(b);
    card.appendChild(row);
  }

  /* The candidate list is whatever the stored title happened to return, which
     is not always where the right film is — "Alien" surfaces Alien: Romulus
     long before the 1979 one. This opens the same picker with an editable
     search box. */
  card.appendChild(
    el(
      'div',
      { class: 'btn-pair', style: 'margin-top:var(--s1)' },
      [
        button('Leave it alone', {
          kind: 'quiet',
          size: 'sm',
          onClick: () => {
            store.update(item.uid, {
              meta: { ...(item.meta || {}), v: meta.META_VERSION, status: 'skipped', at: Date.now() },
            });
            store.saveNow();
            store.emit('item');
            resolved(card);
          },
        }),
        button('Search for another', {
          kind: 'secondary',
          size: 'sm',
          iconName: 'search',
          onClick: () => reroute(item),
        }),
      ]
    )
  );
  return card;
}

/* ── backup ── */

/* Filled in asynchronously — the storage APIs are promise-based and this
   should never hold up rendering the rest of Settings. */
/**
 * The storage-health block. Painted from the last reading in the same frame as
 * render(), then refreshed — it used to rebuild empty and fill in later, so on
 * every tap in Settings everything below it jumped up under the finger and
 * dropped back.
 */
async function refreshStorageHealth() {
  const slot = bodyEl.querySelector('[data-region="storage-health"]');
  if (!slot) return;
  if (lastHealth) paintHealth(slot, lastHealth);
  const h = await storageHealth(store.stats());
  lastHealth = h;
  if (slot.isConnected) paintHealth(slot, h);
}

/* A real 228-title library is under 50KB, which toFixed(1) in MB printed as
   "0.0 MB" — "nothing is saved", in the card meant to reassure. */
const size = (n) =>
  n >= 1073741824
    ? `${(n / 1073741824).toFixed(1)} GB`
    : n >= 1048576
      ? `${(n / 1048576).toFixed(1)} MB`
      : `${Math.max(1, Math.round(n / 1024))} KB`;

function paintHealth(slot, h) {
  clear(slot);

  const line = (text, tone) =>
    el('div', {
      class: 'group-hint',
      style: `margin:0;color:var(--${tone || 'ash'})`,
      text,
    });

  if (h.supported && h.persisted) {
    slot.appendChild(line('This device has agreed to keep your library — it will not be cleared automatically.', 'sage'));
  } else if (h.supported) {
    slot.appendChild(
      line(
        'Your browser has not guaranteed to keep this data. Browsers can clear a site’s storage after a long gap without visiting. Adding Watch Next to your home screen usually earns that guarantee — and an export is the only thing that survives everything.',
        'ash'
      )
    );
    const ask = button('Ask to keep my data', {
      kind: 'secondary',
      onClick: () =>
        busy(ask, 'Asking…', async () => {
          const { persisted } = await requestPersistence();
          toast(persisted ? 'Your library is now protected' : 'The browser declined — export a backup instead');
          refreshStorageHealth();
        }),
    });
    slot.appendChild(el('div', { style: 'margin-top:var(--s3)' }, ask));
  }

  /* The browser's quota means nothing to the reader and changes from phone
     to phone; how much room the library takes is the part worth saying. */
  if (h.usage) {
    slot.appendChild(line(`Your library takes up ${size(h.usage)} on this phone.`));
    slot.lastChild.style.marginTop = 'var(--s2)';
  }

  /* Stated either way. "Last export never" is the case that matters most and
     was the one case this said nothing at all about — a silent absence reads as
     "fine" rather than "you have no copy of this anywhere". It was painted in
     the grey kept for decoration whenever the nudge was off. */
  /* With sync on, the repo is the copy outside this phone. Saying "nothing
     outside this device holds your library" beside a working sync was false. */
  const synced = sync.config().enabled && sync.status().phase !== 'error';
  const warn = !synced && (h.nudge || !h.lastBackupAt);
  const last = line(
    synced
      ? 'Synced to your GitHub repo — every change is kept there too.'
      : h.lastBackupAt
        ? `Last export ${relativeTime(h.lastBackupAt)}.${h.nudge ? ' Worth doing another.' : ''}`
        : 'You have never exported a copy. Nothing outside this device holds your library.',
    synced ? 'sage' : warn ? 'amber' : 'ash'
  );
  last.style.marginTop = 'var(--s2)';
  last.style.fontWeight = warn ? '600' : '400';
  slot.appendChild(last);
}

function backupGroup() {
  const g = el('div', { class: 'group' });

  const health = el('div', { class: 'group-pad', 'data-region': 'storage-health' });
  g.appendChild(health);

  g.appendChild(
    settingsRow('upload', 'Export my library', 'A JSON file with everything except your API keys', () => {
      const payload = store.exportPayload();
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = el('a', { href: url, download: `watchnext-${new Date().toISOString().slice(0, 10)}.json` });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      markBackedUp();
      refreshStorageHealth();
      toast('Exported');
    })
  );

  const fileInput = el('input', {
    type: 'file',
    accept: 'application/json,.json',
    style: 'display:none',
  });
  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const payload = JSON.parse(text);
      const incoming = store.readBackup(payload);
      if (!incoming) {
        toast('That file does not look like a Watch Next backup');
        return;
      }
      openSheet({
        title: 'Restore from backup',
        message: `This file has ${plural(incoming.length, 'title')}. Merge keeps what you already have.`,
        actions: [
          {
            label: 'Merge into my library',
            kind: 'primary',
            onClick: () => {
              const r = store.importPayload(payload, 'merge');
              store.emit('item');
              toast(`${r.added} added, ${r.merged} updated`);
            },
          },
          {
            label: 'Replace everything',
            kind: 'danger',
            onClick: () => {
              const r = store.importPayload(payload, 'replace');
              store.emit('item');
              toast(`Restored ${plural(r.added, 'title')}`);
            },
          },
        ],
      });
    } catch (err) {
      toast('That file could not be read');
    } finally {
      fileInput.value = '';
    }
  });
  g.appendChild(fileInput);
  g.appendChild(
    settingsRow('download', 'Restore from a backup', 'Merge or replace your library', () => fileInput.click())
  );

  return g;
}

/* ── activity ── */

function activityGroup() {
  const g = el('div', { class: 'group' });
  const entries = store.activity().slice(0, 12);

  if (!entries.length) {
    g.appendChild(
      el('div', {
        class: 'group-pad',
        style: 'color:var(--ash);font-size:var(--t-sub)',
        text: 'Nothing yet. Marking a film watched shows up here, with a way to undo it.',
      })
    );
    return g;
  }

  const labels = {
    watched: 'Marked watched',
    unwatched: 'Marked unwatched',
    /* Retired verbs. Still mapped so activity logged before the watchlist was
       collapsed into the library renders as words rather than a raw key. */
    saved: 'Added to watchlist',
    unsaved: 'Removed from watchlist',
    owned: 'Added to collection',
    unowned: 'Removed from collection',
  };

  for (const entry of entries) {
    const row = el('div', { class: 'group-item' });
    const body = el('div', { class: 'group-item-body' });
    body.appendChild(el('div', { class: 'group-item-t', text: entry.title }));
    body.appendChild(
      el('div', {
        class: 'group-item-s',
        text: `${labels[entry.kind] || entry.kind} · ${relativeTime(entry.at)}`,
      })
    );
    row.appendChild(body);
    if (entry.prev) {
      const undo = button('Undo', {
        kind: 'quiet',
        size: 'sm',
        onClick: () => {
          store.undoActivity(entry.id);
          store.emit('item');
          toast('Undone');
        },
      });
      /* Twelve buttons called "Undo" are indistinguishable by ear. */
      undo.setAttribute('aria-label', `Undo ${(labels[entry.kind] || entry.kind).toLowerCase()}: ${entry.title}`);
      row.appendChild(undo);
    }
    g.appendChild(row);
  }
  return g;
}

/* ── danger ── */

function dangerGroup() {
  const g = el('div', { class: 'group' });
  g.appendChild(
    settingsRow(
      'warning',
      'Reset…',
      'Clear your watch history or Discover progress',
      () =>
        openSheet({
          title: 'What would you like to reset?',
          message: 'Your library itself is never removed — only the activity you have recorded against it.',
          actions: [
            { label: 'Clear watch history', kind: 'secondary', onClick: confirmReset('watched') },
            { label: 'Reset Discover', kind: 'secondary', onClick: confirmReset('discover') },
            { label: 'Reset everything', kind: 'danger', onClick: confirmReset('all') },
          ],
          dismissLabel: 'Cancel',
        }),
      true
    )
  );
  return g;
}

function confirmReset(kind) {
  /* The confirm says what it does. "Yes, reset" under "Clear watch history?"
     made you work out that it meant clear. */
  const spec = {
    watched: [
      'Clear watch history?',
      'Every title will be marked unwatched, for everyone here. This cannot be undone.',
      actions.clearWatched,
      'Clear history',
    ],
    discover: ['Reset Discover?', 'Everything you have not watched will come back to sort.', actions.resetDiscover, 'Reset Discover'],
    all: [
      'Reset everything?',
      'Watch history and Discover progress will both be cleared, for everyone here. This cannot be undone.',
      actions.resetEverything,
      'Reset everything',
    ],
  }[kind];

  return () =>
    confirmDestructive({
      title: spec[0],
      message: spec[1],
      confirmLabel: spec[3],
      onConfirm: spec[2],
    });
}

/* ── this phone ──
   Per device and never synced: one of you may like the taps and the other not. */

function deviceGroup() {
  const g = el('div', { class: 'group' });
  const on = store.settings().haptics !== false;
  const can = haptics.supported();

  /* The platform's own switch, so on an iPhone it is the iOS switch, and
     toggling it plays the system tick itself. */
  const row = el('label', { class: 'group-item', for: 'haptics-switch' });
  row.appendChild(el('span', { html: icon('sparkle', 20) }).firstChild);
  const body = el('div', { class: 'group-item-body' });
  body.appendChild(el('div', { class: 'group-item-t', text: 'Haptics' }));
  body.appendChild(
    el('div', {
      class: 'group-item-s',
      text: can
        ? 'A light tap when you press the main buttons and pick from the pills.'
        : 'Needs an iPhone on iOS 18 or later.',
    })
  );
  row.appendChild(body);
  const sw = el('input', {
    id: 'haptics-switch',
    class: 'switch',
    type: 'checkbox',
    switch: true,
    checked: on && can,
    disabled: !can,
  });
  sw.addEventListener('change', () => {
    store.updateSettings({ haptics: sw.checked });
    store.saveNow();
    haptics.refresh();
  });
  row.appendChild(sw);
  g.appendChild(row);
  return g;
}

function settingsRow(iconName, title, sub, onClick, danger = false) {
  const row = el('button', {
    class: `group-item${danger ? ' is-danger' : ''}`,
    type: 'button',
    onclick: onClick,
  });
  row.appendChild(el('span', { html: icon(iconName, 20) }).firstChild);
  const body = el('div', { class: 'group-item-body' });
  body.appendChild(el('div', { class: 'group-item-t', text: title }));
  if (sub) body.appendChild(el('div', { class: 'group-item-s', text: sub }));
  row.appendChild(body);
  row.appendChild(el('span', { html: icon('chevronRight', 16) }).firstChild);
  return row;
}

function aboutBlock() {
  const s = store.stats();
  const active = getProvider(store.settings().provider);
  const box = el('div', {
    style:
      'padding:var(--s6) var(--s4) var(--s8);text-align:center;font-size:var(--t-meta);color:var(--ash);line-height:1.6',
  });
  box.appendChild(
    el('div', { text: `Watch Next · ${plural(s.total, 'title')}, ${s.owned} owned` })
  );
  box.appendChild(
    el('div', {
      style: 'margin-top:var(--s1);user-select:text;-webkit-user-select:text',
      text: `Build ${BUILD}`,
    })
  );

  /* Layout diagnostics. Screen-fit bugs are device-specific and invisible from
     a screenshot, so the numbers are here to be read out rather than guessed.
     The decisive pair is `screen` against `viewport`: the shell can only fill
     the viewport it is given, so when those two disagree the space is being
     withheld by iOS before any of this code runs, and no CSS will win it back. */
  const app = document.getElementById('app');
  const bar = document.querySelector('.tabbar');
  const rect = app?.getBoundingClientRect();
  const barRect = bar?.getBoundingClientRect();
  const css = getComputedStyle(document.documentElement);
  const kb = css.getPropertyValue('--kb').trim() || '0px';
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  /* Measured off a real element rather than read as text — see safeAreaInsets()
     in viewport.js. Both read 0 inside the safe area, which is where this app
     stays; a non-zero pair would mean something changed and is worth seeing. */
  const { top: safeTop, bottom: safeBottom } = safeAreaInsets();

  const lost = screen.height - window.innerHeight;
  const heal = healState();

  const bits = [
    `screen ${screen.width}x${screen.height}`,
    `viewport ${window.innerWidth}x${window.innerHeight}`,
    rect ? `shell ${Math.round(rect.width)}x${Math.round(rect.height)}` : null,
    rect ? `shell y ${Math.round(rect.top)}→${Math.round(rect.bottom)}` : null,
    barRect ? `gap below bar ${Math.round(window.innerHeight - barRect.bottom)}px` : null,
    window.visualViewport ? `visual ${Math.round(window.visualViewport.height)}` : null,
    `kb ${kb}`,
    `safe ${safeTop}/${safeBottom}`,
    `dpr ${window.devicePixelRatio}`,
    standalone ? 'home screen' : 'in browser',
    /* Whether the tab bar is padding itself off the home indicator, and whether
       the re-measure ran and achieved anything. Without these the only way to
       tell a heal that never fired from one that fired and failed is to guess,
       which is how this bug stayed open for three rounds. */
    `bar floor ${heal.floor}`,
    heal.shortfall ? `iOS keeps ${heal.shortfall}pt` : null,
    heal.attempts ? `heal ${heal.recovered}/${heal.attempts}${heal.gaveUp ? ' (stopped)' : ''}` : null,
    /* Two different questions. Does the shell fill the viewport it was given
       (our job), and does that viewport match the screen (not our job)? */
    rect && Math.round(rect.height) >= window.innerHeight ? 'fills viewport' : '⚠ shell short',
    lost > 1 ? `⚠ ${lost}pt off screen` : 'fills screen',
  ].filter(Boolean);

  /* Selectable, unlike the rest of the chrome — these numbers exist to be sent
     to someone, and a screenshot of them cannot be pasted into a search or a
     bug report. The button is the fast path; the selection is the fallback for
     when the clipboard API is unavailable or refused. */
  const report = [`Watch Next build ${BUILD}`, bits.join(' · '), navigator.userAgent].join('\n');

  const diag = el('div', {
    style:
      'margin-top:var(--s2);font-size:var(--t-micro);color:var(--ash);line-height:1.6;' +
      'user-select:text;-webkit-user-select:text',
    text: bits.join(' · '),
  });

  /* Folded away. The line always ends "⚠ 59pt off screen" on iOS 26 — a
     documented platform shortfall, not a fault — and as the last thing on the
     screen it read as a bug report on a phone being handed to someone else. It
     is one tap away for the day it is needed. */
  const more = el('details', { class: 'about-diag' });
  more.appendChild(el('summary', { text: 'Diagnostics' }));
  more.appendChild(diag);

  const copyBtn = el('button', {
    type: 'button',
    class: 'about-link',
    text: 'Copy build info',
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(report);
        toast('Build info copied');
      } catch {
        /* Clipboard blocked — select it instead so a long-press can copy. */
        const range = document.createRange();
        range.selectNodeContents(diag);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        toast('Selected — long-press to copy');
      }
    },
  });
  more.appendChild(copyBtn);
  box.appendChild(more);

  /* Attribution is a condition of use for both sources, so it is rendered
     rather than buried in a readme. */
  if (active.attribution) {
    const a = el('a', {
      href: active.attribution.url,
      target: '_blank',
      rel: 'noopener noreferrer',
      class: 'about-link',
      text: active.attribution.text,
    });
    box.appendChild(el('div', {}, a));
  }
  return box;
}

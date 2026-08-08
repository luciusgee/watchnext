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
import { el, clear, poster, button, toast, openSheet, confirmDestructive, emptyState } from '../ui.js';
import { icon } from '../icons.js';
import * as meta from '../metadata.js';
import { runtime } from '../format.js';

let root = null;
let bodyEl = null;
let navigate = null;
let sweepController = null;

export function initSettings({ navigate: nav }) {
  navigate = nav;
  root = document.getElementById('screen-settings');
  bodyEl = root.querySelector('[data-region="body"]');
  store.subscribe((r) => {
    if (r === 'item' && root.classList.contains('is-active')) render();
  });
}

export function showSettings(params = {}) {
  render();
  if (params.focus === 'ai') {
    root.querySelector('#ai-key')?.focus();
  } else if (params.focus === 'review') {
    openReviewQueue();
  }
}

function render() {
  clear(bodyEl);

  bodyEl.appendChild(groupLabel('Connections'));
  bodyEl.appendChild(connectionsGroup());

  bodyEl.appendChild(groupLabel('Library data'));
  bodyEl.appendChild(dataGroup());

  bodyEl.appendChild(groupLabel('Backup'));
  bodyEl.appendChild(backupGroup());

  bodyEl.appendChild(groupLabel('Recent activity'));
  bodyEl.appendChild(activityGroup());

  bodyEl.appendChild(groupLabel('Danger zone'));
  bodyEl.appendChild(dangerGroup());

  bodyEl.appendChild(aboutBlock());
}

function groupLabel(text) {
  return el('h2', { class: 'eyebrow group-label', text });
}

/* ── connections ── */

function connectionsGroup() {
  const g = el('div', { class: 'group' });
  const s = store.settings();

  /* OMDb */
  const omdb = el('div', { class: 'group-pad' });
  omdb.appendChild(
    el('div', { class: 'group-item-t', text: 'Film database key', style: 'margin-bottom:4px' })
  );
  omdb.appendChild(
    el('div', {
      class: 'group-item-s',
      style: 'margin-bottom:12px',
      text: 'Watch Next looks up posters, runtimes and descriptions from OMDb. A free key takes a minute to get at omdbapi.com and is yours alone — the shared key the old version used is long past its daily limit.',
    })
  );
  const omdbRow = el('div', { style: 'display:flex;gap:8px' });
  const omdbInput = el('input', {
    id: 'omdb-key',
    class: 'input',
    type: 'password',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: 'OMDb API key',
    value: s.omdbKey || '',
    'aria-label': 'OMDb API key',
  });
  omdbRow.appendChild(omdbInput);
  omdbRow.appendChild(
    button('Save', {
      kind: 'secondary',
      onClick: () => {
        store.updateSettings({ omdbKey: omdbInput.value.trim() });
        toast(omdbInput.value.trim() ? 'Key saved' : 'Key cleared');
        render();
      },
    })
  );
  omdb.appendChild(omdbRow);
  if (s.omdbKey) {
    omdb.appendChild(
      el('div', {
        style: 'font-size:12px;color:var(--sage);margin-top:8px',
        text: 'Connected',
      })
    );
  }
  g.appendChild(omdb);

  /* Anthropic */
  const ai = el('div', { class: 'group-pad', style: 'border-top:1px solid var(--hairline)' });
  ai.appendChild(el('div', { class: 'group-item-t', text: 'Assisted picks', style: 'margin-bottom:4px' }));
  ai.appendChild(
    el('div', {
      class: 'group-item-s',
      style: 'margin-bottom:12px',
      text: 'An Anthropic API key powers the Ask tab. Your key is stored on this device only and sent directly to Anthropic — it never passes through anyone else’s server.',
    })
  );
  const aiRow = el('div', { style: 'display:flex;gap:8px' });
  const aiInput = el('input', {
    id: 'ai-key',
    class: 'input',
    type: 'password',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: 'sk-ant-…',
    value: s.aiKey || '',
    'aria-label': 'Anthropic API key',
  });
  aiRow.appendChild(aiInput);
  aiRow.appendChild(
    button('Save', {
      kind: 'secondary',
      onClick: () => {
        const v = aiInput.value.trim();
        if (v && !v.startsWith('sk-')) {
          toast('That does not look like an Anthropic key');
          return;
        }
        store.updateSettings({ aiKey: v });
        toast(v ? 'Key saved' : 'Key cleared');
        render();
      },
    })
  );
  ai.appendChild(aiRow);
  if (s.aiKey) {
    ai.appendChild(el('div', { style: 'font-size:12px;color:var(--sage);margin-top:8px', text: 'Connected' }));
  }
  g.appendChild(ai);

  return g;
}

/* ── metadata ── */

function dataGroup() {
  const g = el('div', { class: 'group' });
  const summary = meta.enrichmentSummary(store.items());

  const status = el('div', { class: 'group-pad' });
  status.appendChild(
    el('div', {
      class: 'group-item-s',
      style: 'margin-bottom:12px',
      text: `${summary.done} of ${summary.total} titles have verified details. ${summary.pending} still to look up${
        summary.review ? `, ${summary.review} need you to choose` : ''
      }${summary.unmatched ? `, ${summary.unmatched} could not be found` : ''}.`,
    })
  );

  const bar = el('div', { class: 'progress-line', style: 'border-radius:2px;margin-bottom:14px' });
  bar.appendChild(
    el('i', { style: `width:${summary.total ? (summary.done / summary.total) * 100 : 0}%` })
  );
  status.appendChild(bar);

  const progressText = el('div', {
    'data-region': 'sweep-status',
    style: 'font-size:12px;color:var(--ash);margin-bottom:12px;min-height:16px',
  });
  status.appendChild(progressText);

  const controls = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' });
  controls.appendChild(
    button(summary.pending ? `Look up ${summary.pending} missing` : 'Everything is up to date', {
      kind: summary.pending ? 'primary' : 'quiet',
      iconName: 'search',
      size: 'sm',
      onClick: () => runSweep({ force: false }, progressText),
    })
  );
  if (summary.review) {
    controls.appendChild(
      button(`Review ${summary.review}`, {
        kind: 'secondary',
        iconName: 'warning',
        size: 'sm',
        onClick: openReviewQueue,
      })
    );
  }
  controls.appendChild(
    button('Re-check everything', {
      kind: 'quiet',
      iconName: 'refresh',
      size: 'sm',
      onClick: () =>
        openSheet({
          title: 'Re-check every title?',
          message:
            'This looks up all ' +
            summary.total +
            ' titles again. It only replaces details you have not edited yourself, but it uses your daily API allowance.',
          actions: [
            {
              label: 'Re-check everything',
              kind: 'primary',
              onClick: () => runSweep({ force: true }, progressText),
            },
          ],
        }),
    })
  );
  status.appendChild(controls);
  g.appendChild(status);
  return g;
}

async function runSweep(opts, statusEl) {
  const key = store.settings().omdbKey;
  if (!key) {
    toast('Add an OMDb key first');
    document.getElementById('omdb-key')?.focus();
    return;
  }
  if (sweepController) {
    sweepController.abort();
    sweepController = null;
    return;
  }

  const list = store.items().filter((i) => meta.needsEnrichment(i, opts));
  if (!list.length) {
    toast('Nothing needs looking up');
    return;
  }

  const budget = new meta.RequestBudget();
  sweepController = new AbortController();

  const result = await meta.sweep(list, {
    key,
    budget,
    signal: sweepController.signal,
    onProgress: ({ index, total, item }) => {
      statusEl.textContent = `Looking up ${item.title} — ${index + 1} of ${total}`;
    },
    apply: (item, res) => {
      if (res.status === 'matched' && res.chosen) {
        store.update(item.uid, meta.toPatch(item, res.chosen, res.confidence));
      } else {
        store.update(item.uid, {
          meta: {
            v: meta.META_VERSION,
            status: res.status,
            at: Date.now(),
            confidence: res.confidence,
            candidates: (res.candidates || []).slice(0, 6).map((c) => ({
              imdbId: c.imdbID,
              title: c.Title,
              year: c.Year,
              type: c.Type,
              poster: c.Poster && c.Poster !== 'N/A' ? c.Poster : null,
            })),
          },
        });
      }
    },
  });

  sweepController = null;
  store.saveNow();
  store.emit('item');

  if (result.error?.code === 'auth') {
    statusEl.textContent = '';
    toast('That OMDb key was rejected');
    return;
  }
  if (result.error?.code === 'budget') {
    statusEl.textContent = '';
    toast('Daily API limit reached — try again tomorrow');
    return;
  }

  statusEl.textContent = '';
  const bits = [`${result.matched} matched`];
  if (result.review) bits.push(`${result.review} need checking`);
  if (result.unmatched) bits.push(`${result.unmatched} not found`);
  toast(result.stopped ? 'Stopped' : bits.join(' · '));
}

/* ── review queue ── */

function openReviewQueue() {
  const queue = store.items().filter((i) => i.meta?.status === 'review' || i.meta?.status === 'unmatched');

  const scrim = el('div', { class: 'scrim is-open' });
  const panel = el('div', {
    class: 'sheet is-open',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': 'Confirm matches',
    style: 'max-height:88vh;overflow-y:auto',
  });

  const close = () => {
    scrim.remove();
    panel.remove();
    document.removeEventListener('keydown', onKey);
    render();
  };
  const onKey = (e) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onKey);
  scrim.addEventListener('click', close);

  panel.appendChild(el('div', { class: 'sheet-grip' }));
  panel.appendChild(el('div', { class: 'sheet-title', text: 'Confirm matches' }));
  panel.appendChild(
    el('div', {
      class: 'sheet-msg',
      text: 'These titles matched more than one film, or none at all. Pick the right one so the poster and description are correct.',
    })
  );

  const list = el('div');
  if (!queue.length) {
    list.appendChild(
      emptyState({ iconName: 'check', title: 'Nothing to confirm', message: 'Every title matched cleanly.' })
    );
  }
  for (const item of queue) list.appendChild(reviewCard(item, close));
  panel.appendChild(list);

  panel.appendChild(
    el('div', { class: 'sheet-actions' }, button('Done', { kind: 'primary', block: true, onClick: close }))
  );

  document.body.appendChild(scrim);
  document.body.appendChild(panel);
  requestAnimationFrame(() => panel.querySelector('button')?.focus());
}

function reviewCard(item, closeAll) {
  const card = el('div', {
    style: 'padding:14px 0;border-bottom:1px solid var(--hairline)',
  });
  card.appendChild(el('div', { style: 'font-weight:620;margin-bottom:2px', text: item.title }));
  card.appendChild(
    el('div', {
      style: 'font-size:12px;color:var(--ash);margin-bottom:12px',
      text: [item.year, item.type === 'tv' ? 'Series' : 'Film'].filter(Boolean).join(' · '),
    })
  );

  const candidates = item.meta?.candidates || [];
  if (!candidates.length) {
    card.appendChild(
      el('div', { style: 'font-size:13px;color:var(--ash)', text: 'No candidates found for this title.' })
    );
  }

  for (const c of candidates) {
    const row = el('button', {
      type: 'button',
      style:
        'display:flex;gap:10px;align-items:center;width:100%;padding:8px;border-radius:10px;border:1px solid var(--hairline);margin-bottom:8px;text-align:left',
      onclick: async () => {
        const key = store.settings().omdbKey;
        store.update(item.uid, {
          imdbId: c.imdbId,
          meta: { v: meta.META_VERSION, status: 'matched', at: Date.now(), confidence: 1, source: 'user' },
        });
        if (key) {
          try {
            const full = await fetch(
              `https://www.omdbapi.com/?i=${encodeURIComponent(c.imdbId)}&plot=short&apikey=${encodeURIComponent(key)}`
            ).then((r) => r.json());
            if (full?.Response === 'True') {
              store.update(item.uid, meta.toPatch(store.byUid(item.uid), full, 1));
            }
          } catch {
            /* the id is saved either way; details fill in on the next sweep */
          }
        }
        store.emit('item');
        toast(`${item.title} matched`);
        closeAll();
        openReviewQueue();
      },
    });

    row.appendChild(
      poster({ title: c.title, poster: c.poster && c.poster !== 'N/A' ? c.poster : null }, { width: 38 })
    );
    const b = el('div', { style: 'flex:1;min-width:0' });
    b.appendChild(el('div', { style: 'font-size:14px;font-weight:550', text: c.title }));
    b.appendChild(
      el('div', {
        style: 'font-size:12px;color:var(--ash)',
        text: [c.year, c.type === 'series' ? 'Series' : 'Film'].filter(Boolean).join(' · '),
      })
    );
    row.appendChild(b);
    card.appendChild(row);
  }

  const skip = el('button', {
    type: 'button',
    class: 'btn btn-quiet btn-sm',
    text: 'None of these — leave it alone',
    style: 'width:100%',
    onclick: () => {
      store.update(item.uid, {
        meta: { ...(item.meta || {}), v: meta.META_VERSION, status: 'skipped', at: Date.now() },
      });
      store.emit('item');
      closeAll();
      openReviewQueue();
    },
  });
  card.appendChild(skip);
  return card;
}

/* ── backup ── */

function backupGroup() {
  const g = el('div', { class: 'group' });

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
      openSheet({
        title: 'Restore from backup',
        message: `This file has ${Array.isArray(payload.items) ? payload.items.length : 0} titles. Merge keeps what you already have.`,
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
              toast(`Restored ${r.added} titles`);
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
      el('div', { class: 'group-pad', style: 'color:var(--ash);font-size:13px', text: 'Nothing yet.' })
    );
    return g;
  }

  const labels = {
    watched: 'Marked watched',
    unwatched: 'Marked unwatched',
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
        text: `${labels[entry.kind] || entry.kind} · ${relative(entry.at)}`,
      })
    );
    row.appendChild(body);
    if (entry.prev) {
      row.appendChild(
        button('Undo', {
          kind: 'quiet',
          size: 'sm',
          onClick: () => {
            store.undoActivity(entry.id);
            store.emit('item');
            toast('Undone');
          },
        })
      );
    }
    g.appendChild(row);
  }
  return g;
}

function relative(ts) {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.round(hrs / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/* ── danger ── */

function dangerGroup() {
  const g = el('div', { class: 'group' });
  g.appendChild(
    settingsRow(
      'warning',
      'Reset…',
      'Clear your watchlist, watch history or Discover progress',
      () =>
        openSheet({
          title: 'What would you like to reset?',
          message: 'Your library itself is never removed — only the activity you have recorded against it.',
          actions: [
            { label: 'Clear watchlist', kind: 'secondary', onClick: confirmReset('watchlist') },
            { label: 'Clear watch history', kind: 'secondary', onClick: confirmReset('watched') },
            { label: 'Reset Discover', kind: 'secondary', onClick: confirmReset('discover') },
            { label: 'Reset everything', kind: 'danger', onClick: confirmReset('all') },
          ],
        }),
      true
    )
  );
  return g;
}

function confirmReset(kind) {
  const spec = {
    watchlist: ['Clear your watchlist?', 'Every title on your watchlist will be removed from it.', actions.clearWatchlist],
    watched: ['Clear watch history?', 'Every title will be marked unwatched. This cannot be undone.', actions.clearWatched],
    discover: ['Reset Discover?', 'Every title will appear in Discover again.', actions.resetDiscover],
    all: ['Reset everything?', 'Watchlist, watch history and Discover progress will all be cleared. This cannot be undone.', actions.resetEverything],
  }[kind];

  return () =>
    confirmDestructive({
      title: spec[0],
      message: spec[1],
      confirmLabel: 'Yes, reset',
      onConfirm: spec[2],
    });
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
  return el('div', {
    style: 'padding:24px 16px 40px;text-align:center;font-size:12px;color:var(--faint);line-height:1.7',
    text: `Watch Next · ${s.total} titles, ${s.owned} in your collection\nFilm data from OMDb`,
  });
}

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
import { getProvider, listProviders } from '../providers/index.js';
import { storageHealth, markBackedUp, requestPersistence } from '../durability.js';
import { BUILD } from '../build.js';
import { healState, safeAreaInsets } from '../viewport.js';
import { openMatchPicker } from './match.js';
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

  bodyEl.appendChild(groupLabel('Your data'));
  bodyEl.appendChild(backupGroup());
  refreshStorageHealth();

  bodyEl.appendChild(groupLabel('Recent activity'));
  bodyEl.appendChild(activityGroup());

  bodyEl.appendChild(groupLabel('Danger zone'));
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
  if (!bits.length) return `All ${s.total} titles have verified details.`;
  return `${s.total} titles — ` + bits.join(', ') + '.';
}

/* ── connections ── */

function connectionsGroup() {
  const g = el('div', { class: 'group' });
  const s = store.settings();

  /* Metadata source */
  const active = getProvider(s.provider);
  const box = el('div', { class: 'group-pad' });
  box.appendChild(el('div', { class: 'group-item-t', text: 'Film database', style: 'margin-bottom:4px' }));
  box.appendChild(
    el('div', {
      class: 'group-item-s',
      style: 'margin-bottom:12px',
      text: 'Where posters, runtimes and descriptions come from. TMDB is the better maintained of the two and the only one whose terms allow a paid app; OMDb is kept for anyone already using it.',
    })
  );

  const seg = el('div', { class: 'seg', style: 'margin-bottom:14px' });
  for (const p of listProviders()) {
    seg.appendChild(
      el('button', {
        type: 'button',
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
  const keyRow = el('div', { style: 'display:flex;gap:8px' });
  const keyInput = el('input', {
    id: 'data-key',
    class: 'input',
    type: 'password',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: active.keyPlaceholder,
    value: keys[active.id] || '',
    'aria-label': active.keyLabel,
  });
  keyRow.appendChild(keyInput);

  /* Saving a key checks it. Storing a string and calling that "Connected" is
     how someone ends up discovering their key never worked part-way through a
     500-title sweep — the state we actually want to show is "this key answered
     a request", not "this box is non-empty". */
  const keyStatus = el('div', { style: 'font-size:12px;margin-top:8px;line-height:1.5' });

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
    onClick: async () => {
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
    },
  });
  keyRow.appendChild(saveBtn);

  box.appendChild(keyRow);
  box.appendChild(
    el('div', { style: 'font-size:12px;color:var(--ash);margin-top:8px;line-height:1.5', text: active.keyHint })
  );
  box.appendChild(keyStatus);
  g.appendChild(box);

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
  status.appendChild(el('div', { class: 'group-item-s', style: 'margin-bottom:12px', text: summaryLine(summary) }));
  if (summary.stale) {
    status.appendChild(
      el('div', {
        class: 'group-item-s',
        style: 'margin-bottom:12px;color:var(--amber)',
        text: 'These came across from the previous version, where roughly a third of titles had another film’s poster and description attached. Re-checking will correct them.',
      })
    );
  }

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
    button(summary.todo ? `Check ${summary.todo} titles` : 'Everything is up to date', {
      kind: summary.todo ? 'primary' : 'quiet',
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
    return;
  }

  const list = store.items()
    .filter((i) => meta.needsEnrichment(i, opts))
    /* Order by how likely you are to see it. A free key allows 1000 lookups a
       day, so a large library may not finish in one go — this makes sure the
       run that does happen fixes the titles on your watchlist and shelves
       first, rather than whatever happens to be alphabetically early. */
    .sort((a, b) => score(b) - score(a));

  function score(i) {
    let n = 0;
    if (i.saved) n += 8;
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
  sweepController = new AbortController();

  const result = await meta.sweep(list, {
    provider,
    key,
    budget,
    signal: sweepController.signal,
    onProgress: ({ index, total, item }) => {
      statusEl.textContent = `Looking up ${item.title} — ${index + 1} of ${total}`;
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

  sweepController = null;
  store.saveNow();
  store.emit('item');

  if (result.error?.code === 'auth') {
    statusEl.textContent = '';
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

  /* The candidate list is whatever the stored title happened to return, which
     is not always where the right film is — "Alien" surfaces Alien: Romulus
     long before the 1979 one. This opens the same picker with an editable
     search box. */
  card.appendChild(
    el('button', {
      type: 'button',
      class: 'btn btn-quiet btn-sm',
      text: 'Search for a different film',
      style: 'width:100%;margin-bottom:8px',
      onclick: () => {
        closeAll();
        openMatchPicker(store.byUid(item.uid) || item, { onDone: openReviewQueue });
      },
    })
  );

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

/* Filled in asynchronously — the storage APIs are promise-based and this
   should never hold up rendering the rest of Settings. */
async function refreshStorageHealth() {
  const slot = bodyEl.querySelector('[data-region="storage-health"]');
  if (!slot) return;
  const h = await storageHealth(store.stats());
  clear(slot);

  const line = (text, tone) =>
    el('div', {
      style: `font-size:12px;line-height:1.55;color:var(--${tone || 'ash'})`,
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
      size: 'sm',
      onClick: async () => {
        const { persisted } = await requestPersistence();
        toast(persisted ? 'Your library is now protected' : 'The browser declined — export a backup instead');
        refreshStorageHealth();
      },
    });
    slot.appendChild(el('div', { style: 'margin-top:10px' }, ask));
  }

  if (h.usage) {
    const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
    slot.appendChild(
      el('div', {
        style: 'font-size:12px;color:var(--faint);margin-top:8px',
        text: h.quota ? `Using ${mb(h.usage)} of about ${mb(h.quota)} available.` : `Using ${mb(h.usage)}.`,
      })
    );
  }

  if (h.lastBackupAt) {
    slot.appendChild(
      el('div', {
        style: 'font-size:12px;color:var(--faint);margin-top:4px',
        text: `Last export ${relative(h.lastBackupAt)}.`,
      })
    );
  }
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
        message: `This file has ${incoming.length} titles. Merge keeps what you already have.`,
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
  const active = getProvider(store.settings().provider);
  const box = el('div', {
    style: 'padding:24px 16px 40px;text-align:center;font-size:12px;color:var(--faint);line-height:1.7',
  });
  box.appendChild(el('div', { text: `Watch Next · ${s.total} titles, ${s.owned} in your collection` }));
  box.appendChild(
    el('div', {
      style: 'margin-top:6px;user-select:text;-webkit-user-select:text',
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
     in viewport.js. Both insets non-zero is the signal that the web view really
     does span the whole screen, which is what makes the boost safe to apply. */
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
    /* Did the re-measure run, and did it achieve anything? Without this the
       only way to tell a heal that never fired from one that fired and failed
       is to guess, which is how this bug stayed open for three rounds. */
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
      'margin-top:10px;font-size:11px;color:var(--faint);line-height:1.6;' +
      'user-select:text;-webkit-user-select:text',
    text: bits.join(' · '),
  });
  box.appendChild(diag);

  const copyBtn = el('button', {
    type: 'button',
    class: 'link-btn',
    style:
      'margin-top:10px;font-size:12px;color:var(--ash);background:none;border:0;' +
      'padding:8px 12px;text-decoration:underline;cursor:pointer',
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
  box.appendChild(copyBtn);

  /* Attribution is a condition of use for both sources, so it is rendered
     rather than buried in a readme. */
  if (active.attribution) {
    const a = el('a', {
      href: active.attribution.url,
      target: '_blank',
      rel: 'noopener noreferrer',
      style: 'display:block;margin-top:10px;color:var(--ash);text-decoration:none',
      text: active.attribution.text,
    });
    box.appendChild(a);
  }
  return box;
}

/*
 * "Wrong film?" — re-attach a title to a different record.
 *
 * The review queue only ever offered a choice for titles the matcher was
 * unsure about. Once something was accepted — whether by the matcher or by the
 * user — it left the queue and there was no way back, so a wrong pick was
 * permanent. That is the worst possible place to have no undo: the matcher is
 * most confident exactly when two films share a name, which is when a human is
 * most likely to tap the wrong one.
 *
 * Searching again by the stored title is not enough on its own, either. The
 * stored title for the 1979 film is just "Alien", and that is precisely the
 * query that returns Alien: Romulus first. So the search box is editable and
 * pre-filled with the title AND year — the user can see what is being searched
 * and correct it.
 */

import * as store from '../store.js';
import * as meta from '../metadata.js';
import { getProvider } from '../providers/index.js';
import { el, clear, poster, button, toast, openPanel } from '../ui.js';
import { metaLine } from '../format.js';

/** "Alien 1979" / "Alien (1979)" → { title: 'Alien', year: 1979 } */
function parseQuery(text) {
  const trimmed = text.trim();
  const m = trimmed.match(/^(.*?)[\s(]+((?:19|20)\d{2})\)?$/);
  if (m && m[1].trim()) return { title: m[1].trim(), year: parseInt(m[2], 10) };
  return { title: trimmed, year: null };
}

function describe(c) {
  return [c.year, c.type === 'series' || c.type === 'tv' ? 'Series' : 'Film'].filter(Boolean).join(' · ');
}

/**
 * @param {object} item      the library item being re-matched
 * @param {object} [opts]
 * @param {Function} [opts.onDone]  called after the item changes
 */
export function openMatchPicker(item, { onDone } = {}) {
  const settings = store.settings();
  const provider = getProvider(settings.provider);
  const key = (settings.dataKeys || {})[provider.id];

  let controller = null;
  /* It used to be inserted already open and removed outright, so it cut in
     over the detail overlay with a full scrim and vanished in one frame. */
  const { panel, close, show: showPanel } = openPanel({
    label: item.type === 'tv' ? 'Choose the right series' : 'Choose the right film',
    className: 'has-pinned',
    /* --kb: it opens with its search field focused. */
    style: 'max-height:calc(88vh - var(--kb, 0px));overflow-y:auto',
    onClose: () => controller?.abort(),
  });

  panel.appendChild(el('div', { class: 'sheet-grip' }));
  panel.appendChild(
    el('div', { class: 'sheet-title', text: item.type === 'tv' ? 'Choose the right series' : 'Choose the right film' })
  );

  /* What is attached right now, so there is something to compare against —
     otherwise you are picking from a list with no idea what you are replacing. */
  const current = el('div', {
    style:
      'display:flex;gap:10px;align-items:center;padding:var(--s3);margin-bottom:var(--s4);' +
      'border-radius:var(--r-md);background:var(--raised)',
  });
  current.appendChild(poster(item, { width: 42 }));
  const curBody = el('div', { style: 'flex:1;min-width:0' });
  curBody.appendChild(el('div', { class: 'eyebrow', text: 'Currently showing' }));
  curBody.appendChild(
    el('div', { style: 'font-size:var(--t-body);font-weight:550;margin-top:2px', text: item.title })
  );
  curBody.appendChild(
    el('div', {
      style: 'font-size:var(--t-meta);color:var(--ash)',
      /* What a person can judge a match by — not a database id, or the
         developer string "no IMDb id". */
      text: metaLine(item, { showType: true }) || 'No details yet',
    })
  );
  current.appendChild(curBody);
  panel.appendChild(current);

  /* search */
  const form = el('form', { style: 'display:flex;gap:var(--s2);margin-bottom:var(--s4)' });
  const input = el('input', {
    class: 'input',
    type: 'search',
    id: 'match-search',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-label': 'Search for the right film',
    value: [item.title, item.year].filter(Boolean).join(' '),
  });
  form.appendChild(input);
  form.appendChild(button('Search', { kind: 'secondary', type: 'submit' }));
  panel.appendChild(form);

  const results = el('div', { style: 'transition:opacity var(--fast) var(--ease)' });
  panel.appendChild(results);

  /* A search in flight dims the rows that are there rather than clearing them.
     The sheet is bottom-anchored, so collapsing ten rows to one line of
     "Searching…" dropped its top edge — and the field you had just typed in —
     about 500px, then shot it back up when results came. */
  const setBusy = (on) => {
    results.style.opacity = on ? '0.4' : '';
    results.style.pointerEvents = on ? 'none' : '';
    results.setAttribute('aria-busy', String(on));
  };
  const say = (text, tone = 'var(--ash)') => {
    setBusy(false);
    clear(results);
    results.appendChild(
      el('div', {
        role: 'status',
        style: `font-size:var(--t-sub);color:${tone};padding:var(--s3) 0;line-height:1.5`,
        text,
      })
    );
  };
  const skeleton = () => {
    clear(results);
    for (let i = 0; i < 3; i++) {
      results.appendChild(
        el('div', { class: 'skeleton', style: 'height:62px;border-radius:var(--r-md);margin-bottom:var(--s2)' })
      );
    }
  };

  async function apply(c) {
    /* Saved first and separately from the details fetch: the choice is the part
       that must not be lost if the network drops half way through. */
    store.update(item.uid, {
      imdbId: c.imdbId || null,
      meta: {
        v: meta.META_VERSION,
        status: 'matched',
        /* Dated when the details arrive — see the review queue. */
        at: null,
        confidence: 1,
        source: 'user',
        sourceId: c.sourceId,
      },
    });

    let filled = false;
    if (key) {
      try {
        const full = await meta.recordFor(c, {
          provider,
          key,
          budget: new meta.RequestBudget(provider.dailyLimit, provider.id),
        });
        if (full) {
          /* Confidence 1: this is a deliberate human choice, so it should
             overwrite whatever the matcher guessed. */
          const patch = meta.toPatch(store.byUid(item.uid), full, 1, provider.id, { chosen: true });
          /* toPatch stamps the provider as the source. Put the human back —
             otherwise the app forgets a person chose this, and the next sweep
             after the cache expires is free to pick the wrong film all over
             again with nothing recording that it was already corrected. */
          patch.meta = { ...patch.meta, source: 'user', chosenAt: Date.now() };
          store.update(item.uid, patch);
          filled = true;
        }
      } catch (err) {
        toast(err?.code === 'budget' ? 'Choice saved — details fill in tomorrow' : 'Choice saved — details will fill in later');
      }
    }

    store.saveNow();
    store.emit('item');
    if (filled) toast(`Now showing ${store.byUid(item.uid)?.title || c.title}`);
    close();
    onDone?.();
  }

  function show(list) {
    setBusy(false);
    clear(results);
    if (!list.length) {
      say('Nothing found. Try the title on its own, or a different spelling.');
      return;
    }
    for (const c of list) {
      const isCurrent = c.sourceId && c.sourceId === item.meta?.sourceId;
      const row = el('button', {
        type: 'button',
        class: isCurrent ? 'result-row is-dupe' : 'result-row',
        onclick: () => {
          /* Saving and the details fetch can take a moment on a phone; say so
             on the row that was chosen and stop a second tap. */
          for (const r of results.querySelectorAll('.result-row')) r.disabled = true;
          row.style.opacity = '1';
          b.appendChild(el('div', { style: 'font-size:11px;color:var(--amber)', text: 'Saving…' }));
          apply(c);
        },
      });
      row.appendChild(
        poster({ title: c.title, poster: c.poster && c.poster !== 'N/A' ? c.poster : null }, { width: 38 })
      );
      const b = el('div', { style: 'flex:1;min-width:0' });
      b.appendChild(el('div', { style: 'font-size:var(--t-body);font-weight:550', text: c.title }));
      b.appendChild(el('div', { style: 'font-size:var(--t-meta);color:var(--ash)', text: describe(c) }));
      if (isCurrent) b.appendChild(el('div', { style: 'font-size:11px;color:var(--amber)', text: 'Currently attached' }));
      row.appendChild(b);
      results.appendChild(row);
    }
  }

  async function search() {
    if (!key) {
      say(`Add a ${provider.label} key in Settings first — searching needs one.`, 'var(--ember)');
      return;
    }
    controller?.abort();
    controller = new AbortController();
    const q = parseQuery(input.value);
    if (!q.title) {
      say('Type something to search for.');
      return;
    }
    if (results.querySelector('.result-row')) setBusy(true);
    else skeleton();
    try {
      const ctx = {
        key,
        budget: new meta.RequestBudget(provider.dailyLimit, provider.id),
        signal: controller.signal,
      };
      let found = (await provider.search({ title: q.title, year: q.year, type: item.type }, ctx)) || [];
      /* The picker pre-fills "Alien 1979" precisely so the right remake can be
         found, and then used a search that takes no year: Dune (2021) came
         back above Dune (1984). The general search stays, so a title stored
         with the wrong type can still be fixed; a typed year adds the precise
         results in front, and near-year matches sort first. */
      if (q.year && provider.searchPrecise) {
        const precise = (await provider.searchPrecise({ title: q.title, year: q.year, type: item.type }, ctx)) || [];
        const seen = new Set(found.map((c) => c.sourceId));
        found = [...precise.filter((c) => !seen.has(c.sourceId)), ...found];
      }
      const near = (c) => (q.year && c.year && Math.abs(c.year - q.year) <= 1 ? 0 : 1);
      show([...found].sort((a, b) => near(a) - near(b)).slice(0, 10));
    } catch (err) {
      if (err?.name === 'AbortError') return;
      say(
        err?.code === 'network' ? 'No connection — try again when you’re back online.' : 'That search didn’t work — try again in a moment.',
        'var(--ember)'
      );
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    search();
  });

  /* Whatever the last sweep turned up, shown immediately so the common case
     needs no request at all. */
  const stored = item.meta?.candidates || [];
  if (stored.length) show(stored);
  else say('Search to see what else this could be.');

  panel.appendChild(
    el(
      'div',
      { class: 'sheet-actions is-pinned' },
      button('Done', { kind: 'secondary', block: true, onClick: close })
    )
  );

  showPanel();
  requestAnimationFrame(() => input.focus({ preventScroll: true }));
}

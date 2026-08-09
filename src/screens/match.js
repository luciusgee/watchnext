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
import { el, clear, poster, button, toast } from '../ui.js';

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

  const scrim = el('div', { class: 'scrim is-open' });
  const panel = el('div', {
    class: 'sheet is-open',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': 'Choose the right film',
    style: 'max-height:88vh;overflow-y:auto',
  });

  let controller = null;
  const close = () => {
    controller?.abort();
    scrim.remove();
    panel.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onKey);
  scrim.addEventListener('click', close);

  panel.appendChild(el('div', { class: 'sheet-grip' }));
  panel.appendChild(el('div', { class: 'sheet-title', text: 'Choose the right film' }));

  /* What is attached right now, so there is something to compare against —
     otherwise you are picking from a list with no idea what you are replacing. */
  const current = el('div', {
    style:
      'display:flex;gap:10px;align-items:center;padding:10px;margin-bottom:14px;' +
      'border-radius:10px;background:var(--raised)',
  });
  current.appendChild(poster(item, { width: 42 }));
  const curBody = el('div', { style: 'flex:1;min-width:0' });
  curBody.appendChild(el('div', { class: 'eyebrow', text: 'Currently showing' }));
  curBody.appendChild(
    el('div', { style: 'font-size:14px;font-weight:550;margin-top:2px', text: item.title })
  );
  curBody.appendChild(
    el('div', {
      style: 'font-size:12px;color:var(--ash)',
      text: [item.year, item.imdbId || 'no IMDb id'].filter(Boolean).join(' · '),
    })
  );
  current.appendChild(curBody);
  panel.appendChild(current);

  /* search */
  const form = el('form', { style: 'display:flex;gap:8px;margin-bottom:14px' });
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
  const searchBtn = button('Search', { kind: 'secondary' });
  searchBtn.type = 'submit';
  form.appendChild(searchBtn);
  panel.appendChild(form);

  const results = el('div');
  panel.appendChild(results);

  const say = (text, tone = 'var(--ash)') => {
    clear(results);
    results.appendChild(
      el('div', { style: `font-size:13px;color:${tone};padding:12px 0;line-height:1.5`, text })
    );
  };

  async function apply(c) {
    /* Saved first and separately from the details fetch: the choice is the part
       that must not be lost if the network drops half way through. */
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

    let filled = false;
    if (key) {
      try {
        const full = await provider.details(c.sourceId, c.type, {
          provider,
          key,
          budget: new meta.RequestBudget(provider.dailyLimit, provider.id),
        });
        if (full) {
          /* Confidence 1: this is a deliberate human choice, so it should
             overwrite whatever the matcher guessed. */
          const patch = meta.toPatch(store.byUid(item.uid), full, 1, provider.id);
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
    clear(results);
    if (!list.length) {
      say('Nothing found. Try the title on its own, or a different spelling.');
      return;
    }
    for (const c of list) {
      const isCurrent = c.sourceId && c.sourceId === item.meta?.sourceId;
      const row = el('button', {
        type: 'button',
        style:
          'display:flex;gap:10px;align-items:center;width:100%;padding:8px;border-radius:10px;' +
          `border:1px solid ${isCurrent ? 'var(--amber-line)' : 'var(--hairline)'};margin-bottom:8px;text-align:left`,
        onclick: () => apply(c),
      });
      row.appendChild(
        poster({ title: c.title, poster: c.poster && c.poster !== 'N/A' ? c.poster : null }, { width: 38 })
      );
      const b = el('div', { style: 'flex:1;min-width:0' });
      b.appendChild(el('div', { style: 'font-size:14px;font-weight:550', text: c.title }));
      b.appendChild(el('div', { style: 'font-size:12px;color:var(--ash)', text: describe(c) }));
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
    say('Searching…');
    const q = parseQuery(input.value);
    if (!q.title) {
      say('Type something to search for.');
      return;
    }
    try {
      const found = await provider.search(
        { title: q.title, year: q.year, type: item.type },
        {
          key,
          budget: new meta.RequestBudget(provider.dailyLimit, provider.id),
          signal: controller.signal,
        }
      );
      show((found || []).slice(0, 10));
    } catch (err) {
      if (err?.name === 'AbortError') return;
      say(err?.message || 'That search failed.', 'var(--ember)');
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
      { class: 'sheet-actions' },
      button('Done', { kind: 'primary', block: true, onClick: close })
    )
  );

  document.body.appendChild(scrim);
  document.body.appendChild(panel);
  requestAnimationFrame(() => input.focus());
}

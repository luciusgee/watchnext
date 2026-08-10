/*
 * Add titles — search, a pasted list, or one by hand.
 *
 * Search is the default and does the whole job in one step: you find the film,
 * tap it, and it lands complete with its poster, year, runtime and genre. What
 * it replaces was the app's worst moment — you typed a title blind, got a grey
 * placeholder card, and then had to find a chore in Settings called "look up
 * details" to make it look like anything. That is where a new library stops
 * being worth building at about title fifteen.
 *
 * The other two modes stay, and matter: pasting a list is how 500 titles get in
 * at all, and typing by hand is the only route that works with no key and no
 * signal. Anything typed by hand is treated as authoritative and locked, so a
 * later sweep fills gaps without overwriting it.
 */

import * as store from '../store.js';
import * as actions from '../actions.js';
import * as meta from '../metadata.js';
import { getProvider } from '../providers/index.js';
import { el, clear, button, toast, poster } from '../ui.js';
import { icon } from '../icons.js';
import { openDetail } from './detail.js';

let root = null;
let bodyEl = null;
let navigate = null;
let mode = 'search';

export function initAdd({ navigate: nav }) {
  navigate = nav;
  root = document.getElementById('screen-add');
  bodyEl = root.querySelector('[data-region="body"]');
}

export function showAdd() {
  render();
}

function render() {
  clear(bodyEl);

  const seg = el('div', { class: 'seg', style: 'margin:16px' });
  for (const [key, label] of [['search', 'Search'], ['list', 'Paste a list'], ['single', 'By hand']]) {
    seg.appendChild(
      el('button', {
        type: 'button',
        'aria-pressed': String(mode === key),
        text: label,
        onclick: () => {
          mode = key;
          render();
        },
      })
    );
  }
  bodyEl.appendChild(seg);

  bodyEl.appendChild(mode === 'search' ? searchForm() : mode === 'list' ? listForm() : singleForm());
}

/* ── search ──────────────────────────────────────────────────────────────
   One step: find it, tap it, it is in — with everything already filled in.
   Nothing is written until a result is tapped, so browsing costs nothing. */

function searchForm() {
  const wrap = el('div', { style: 'padding:0 16px 32px' });
  const provider = getProvider(store.settings().provider);
  const key = (store.settings().dataKeys || {})[provider.id];

  const form = el('form', { style: 'display:flex;gap:8px;margin-bottom:6px' });
  const input = el('input', {
    class: 'input',
    type: 'search',
    id: 'add-search',
    placeholder: 'The Thing 1982',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-label': 'Search for a film or series',
  });
  form.appendChild(input);
  const go = button('Search', { kind: 'secondary' });
  go.type = 'submit';
  form.appendChild(go);
  wrap.appendChild(form);

  /* Type sits with the search box, not on the results: it changes what is
     searched for, and TV and film share plenty of titles. */
  let type = 'movie';
  const typeSeg = el('div', { class: 'seg', style: 'margin:10px 0 6px' });
  for (const [k, text] of [['movie', 'Films'], ['tv', 'Series']]) {
    typeSeg.appendChild(
      el('button', {
        type: 'button',
        'aria-pressed': String(type === k),
        text,
        onclick: (e) => {
          type = k;
          [...typeSeg.children].forEach((c) => c.setAttribute('aria-pressed', String(c === e.currentTarget)));
          if (input.value.trim()) run();
        },
      })
    );
  }
  wrap.appendChild(typeSeg);

  let owned = true;
  const ownedRow = el('label', {
    style: 'display:flex;align-items:center;gap:10px;margin:10px 0 14px;cursor:pointer',
  });
  const ownedBox = el('input', {
    type: 'checkbox',
    checked: true,
    style: 'width:20px;height:20px;accent-color:var(--amber)',
  });
  ownedBox.addEventListener('change', () => {
    owned = ownedBox.checked;
  });
  ownedRow.appendChild(ownedBox);
  ownedRow.appendChild(el('span', { style: 'font-size:14px', text: 'I own what I add' }));
  wrap.appendChild(ownedRow);

  const status = el('div', { style: 'font-size:13px;color:var(--ash);margin-bottom:10px;line-height:1.5' });
  const results = el('div');
  wrap.appendChild(status);
  wrap.appendChild(results);

  const say = (text, colour = 'var(--ash)') => {
    clear(results);
    status.style.color = colour;
    status.textContent = text;
  };

  if (!key) {
    say(`Searching needs a ${provider.label} key. Add one in Settings, or use "By hand" — that works with no key at all.`);
    wrap.appendChild(
      el('div', { style: 'margin-top:12px' },
        button('Open Settings', { kind: 'secondary', size: 'sm', onClick: () => navigate('settings') }))
    );
    return wrap;
  }

  say('Search for anything — it arrives with its poster and details already filled in.');

  let controller = null;
  let timer = null;

  async function run() {
    const raw = input.value.trim();
    if (!raw) {
      say('Type something to search for.');
      return;
    }
    /* A trailing year is a disambiguator, not part of the title — the same
       parse the match picker uses. */
    const m = raw.match(/^(.*?)[\s,(]+((?:19|20)\d{2})\)?$/);
    const title = (m ? m[1] : raw).trim();
    const year = m ? parseInt(m[2], 10) : null;

    controller?.abort();
    controller = new AbortController();
    say('Searching…');
    try {
      const found = await provider.search(
        { title, year, type },
        {
          key,
          budget: new meta.RequestBudget(provider.dailyLimit, provider.id),
          signal: controller.signal,
        }
      );
      show((found || []).slice(0, 12));
    } catch (err) {
      if (err?.name === 'AbortError') return;
      say(err?.message || 'That search failed.', 'var(--ember)');
    }
  }

  function show(list) {
    clear(results);
    status.textContent = list.length ? 'Tap one to add it.' : '';
    if (!list.length) {
      say('Nothing found. Try the title on its own, or a different spelling.');
      return;
    }
    for (const c of list) {
      const existing =
        (c.imdbId && store.items().find((i) => i.imdbId === c.imdbId)) ||
        store.findDuplicate(c.title, c.year, c.type);
      const row = el('button', {
        type: 'button',
        style:
          'display:flex;gap:10px;align-items:center;width:100%;padding:8px;border-radius:10px;' +
          `border:1px solid ${existing ? 'var(--amber-line)' : 'var(--hairline)'};margin-bottom:8px;text-align:left`,
        onclick: () => (existing ? openDetail(existing.uid) : add(c, row)),
      });
      row.appendChild(
        poster({ title: c.title, poster: c.poster && c.poster !== 'N/A' ? c.poster : null }, { width: 38 })
      );
      const b = el('div', { style: 'flex:1;min-width:0' });
      b.appendChild(el('div', { style: 'font-size:14px;font-weight:550', text: c.title }));
      b.appendChild(
        el('div', {
          style: 'font-size:12px;color:var(--ash)',
          text: [c.year, c.type === 'tv' ? 'Series' : 'Film'].filter(Boolean).join(' · '),
        })
      );
      if (existing) {
        b.appendChild(el('div', { style: 'font-size:11px;color:var(--amber)', text: 'Already in your library — tap to open' }));
      }
      row.appendChild(b);
      results.appendChild(row);
    }
  }

  /**
   * Add a searched result.
   *
   * The record is saved before the details request, and the details request is
   * allowed to fail. A film in the library with a poster and a year beats a
   * spinner that ends in an error toast and nothing added — the sweep will
   * finish the job later either way.
   */
  async function add(candidate, row) {
    row.disabled = true;
    row.style.opacity = '0.5';

    const { item, duplicate } = actions.addItem({
      title: candidate.title,
      year: candidate.year,
      type: candidate.type,
      poster: candidate.poster && candidate.poster !== 'N/A' ? candidate.poster : null,
      imdbId: candidate.imdbId || null,
      owned,
      /* The user picked this specific record off a list of alternatives, so it
         is a human decision and outranks anything a later sweep infers. */
      locked: ['title', 'year'],
      meta: {
        v: meta.META_VERSION,
        status: 'confirmed',
        at: Date.now(),
        confidence: 1,
        source: 'user',
        sourceId: candidate.sourceId || null,
      },
    });

    if (duplicate) {
      row.disabled = false;
      row.style.opacity = '';
      toast(`${item.title} is already in your library`, { action: 'Open', onAction: () => openDetail(item.uid) });
      return;
    }

    toast(`Added ${item.title}`, { action: 'Open', onAction: () => openDetail(item.uid) });

    try {
      const full = await provider.details(candidate.sourceId, candidate.type, {
        key,
        budget: new meta.RequestBudget(provider.dailyLimit, provider.id),
      });
      if (full && store.byUid(item.uid)) {
        const patch = meta.toPatch(store.byUid(item.uid), full, 1, provider.id);
        /* toPatch stamps the provider as the source; the human chose it. */
        patch.meta = { ...patch.meta, source: 'user' };
        store.update(item.uid, patch);
        store.saveNow();
        store.emit('item');
      }
    } catch {
      /* Already added and already useful. The sweep finishes it later. */
    }

    /* Re-run so the row it came from now reads "already in your library" —
       cheap, and it stops the same film being tapped twice. */
    run();
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    clearTimeout(timer);
    run();
  });
  /* Debounced as you type, so the common case needs no second tap. */
  input.addEventListener('input', () => {
    clearTimeout(timer);
    if (input.value.trim().length < 3) return;
    timer = setTimeout(run, 450);
  });

  requestAnimationFrame(() => input.focus());
  return wrap;
}

function listForm() {
  const wrap = el('div', { style: 'padding:0 16px 32px' });

  const label = el('label', { class: 'field-label', for: 'bulk-input', text: 'One title per line' });
  wrap.appendChild(label);

  const ta = el('textarea', {
    id: 'bulk-input',
    class: 'textarea',
    placeholder: 'The Thing (1982)\nHereditary\nSicario, 2015',
    spellcheck: 'false',
  });
  wrap.appendChild(ta);

  wrap.appendChild(
    el('div', {
      style: 'font-size:12px;color:var(--ash);margin:8px 0 16px;line-height:1.5',
      text: 'A year in brackets helps pick the right film when several share a name. Details are looked up afterwards.',
    })
  );

  const typeSeg = el('div', { class: 'seg', style: 'margin-bottom:16px' });
  let type = 'movie';
  for (const [key, text] of [['movie', 'Films'], ['tv', 'Series']]) {
    typeSeg.appendChild(
      el('button', {
        type: 'button',
        'aria-pressed': String(type === key),
        text,
        onclick: (e) => {
          type = key;
          [...typeSeg.children].forEach((c) => c.setAttribute('aria-pressed', String(c === e.currentTarget)));
        },
      })
    );
  }
  wrap.appendChild(typeSeg);

  const ownedRow = el('label', {
    style: 'display:flex;align-items:center;gap:10px;margin-bottom:20px;cursor:pointer',
  });
  const ownedBox = el('input', { type: 'checkbox', checked: true, style: 'width:20px;height:20px;accent-color:var(--amber)' });
  ownedRow.appendChild(ownedBox);
  ownedRow.appendChild(el('span', { style: 'font-size:14px', text: 'I own these' }));
  wrap.appendChild(ownedRow);

  const result = el('div', { style: 'margin-top:16px' });

  wrap.appendChild(
    button('Add to library', {
      kind: 'primary',
      block: true,
      iconName: 'plus',
      onClick: () => {
        const lines = ta.value.split('\n');
        const report = actions.addMany(lines, type);
        if (ownedBox.checked) {
          report.added.forEach((i) => store.update(i.uid, { owned: true }));
          store.saveNow();
        }
        clear(result);
        if (!report.added.length && !report.duplicates.length) {
          toast('Nothing to add');
          return;
        }
        ta.value = '';
        result.appendChild(summary(report));
        toast(`${report.added.length} added`);
      },
    })
  );
  wrap.appendChild(result);
  return wrap;
}

function summary(report) {
  const box = el('div', {
    style: 'background:var(--surface);border:1px solid var(--hairline);border-radius:10px;padding:14px',
  });
  box.appendChild(
    el('div', {
      style: 'font-weight:600;margin-bottom:8px',
      text: `${report.added.length} added`,
    })
  );
  if (report.duplicates.length) {
    box.appendChild(
      el('div', {
        style: 'font-size:13px;color:var(--ash);margin-bottom:6px',
        text: `Already in your library: ${report.duplicates.slice(0, 6).join(', ')}${
          report.duplicates.length > 6 ? ` and ${report.duplicates.length - 6} more` : ''
        }`,
      })
    );
  }
  if (report.invalid.length) {
    box.appendChild(
      el('div', {
        style: 'font-size:13px;color:var(--ash)',
        text: `Skipped ${report.invalid.length} line${report.invalid.length === 1 ? '' : 's'} we could not read`,
      })
    );
  }
  box.appendChild(
    el(
      'div',
      { style: 'margin-top:12px' },
      button('Look up details now', {
        kind: 'secondary',
        size: 'sm',
        iconName: 'search',
        /* Settings is where the sweep lives, and sending someone there to hunt
           for it is how the old flow lost people. Land them on it. */
        onClick: () => navigate('settings', { focus: 'sweep' }),
      })
    )
  );
  return box;
}

function singleForm() {
  const form = el('form', { style: 'padding:0 16px 32px' });

  const field = (id, label, props = {}) => {
    const w = el('div', { class: 'field' });
    w.appendChild(el('label', { class: 'field-label', for: id, text: label }));
    const input = el('input', { id, class: 'input', ...props });
    w.appendChild(input);
    form.appendChild(w);
    return input;
  };

  const title = field('add-title', 'Title', { type: 'text', required: true, placeholder: 'The Thing' });
  const year = field('add-year', 'Year', { type: 'number', placeholder: '1982', min: '1870', max: '2100' });

  const typeWrap = el('div', { class: 'field' });
  typeWrap.appendChild(el('label', { class: 'field-label', for: 'add-type', text: 'Type' }));
  const type = el('select', { id: 'add-type', class: 'select' });
  type.appendChild(el('option', { value: 'movie', text: 'Film' }));
  type.appendChild(el('option', { value: 'tv', text: 'Series' }));
  typeWrap.appendChild(type);
  form.appendChild(typeWrap);

  const qWrap = el('div', { class: 'field' });
  qWrap.appendChild(el('label', { class: 'field-label', for: 'add-quality', text: 'I own it in' }));
  const quality = el('select', { id: 'add-quality', class: 'select' });
  quality.appendChild(el('option', { value: '', text: 'I don’t own it' }));
  for (const q of ['4K', '1080p', '720p']) quality.appendChild(el('option', { value: q, text: q }));
  qWrap.appendChild(quality);
  form.appendChild(qWrap);

  form.appendChild(button('Add to library', { kind: 'primary', block: true, iconName: 'plus' }));

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const t = title.value.trim();
    if (!t) {
      title.focus();
      return;
    }
    const locked = ['title'];
    if (year.value) locked.push('year');
    if (quality.value) locked.push('quality');

    const { item, duplicate } = actions.addItem({
      title: t,
      year: year.value ? parseInt(year.value, 10) : null,
      type: type.value,
      quality: quality.value || null,
      owned: !!quality.value,
      locked,
    });

    if (duplicate) {
      toast(`${item.title} is already in your library`, { action: 'Open', onAction: () => openDetail(item.uid) });
      return;
    }
    toast(`Added ${item.title}`, { action: 'Open', onAction: () => openDetail(item.uid) });
    form.reset();
    title.focus();
  });

  return form;
}

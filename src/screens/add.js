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
import { el, clear, button, toast, poster, checkRow } from '../ui.js';
import { cleanTitleLine } from '../format.js';
import { icon } from '../icons.js';
import { openDetail } from './detail.js';

let root = null;
let bodyEl = null;
let navigate = null;
let mode = 'search';
/* Only focus the search box when someone chose Search. Focusing it on arrival
   set body.is-typing before any keyboard existed, and the tab bar vanished the
   moment the screen opened. */
let focusSearch = false;

export function initAdd({ navigate: nav }) {
  navigate = nav;
  root = document.getElementById('screen-add');
  bodyEl = root.querySelector('[data-region="body"]');
}

export function showAdd() {
  focusSearch = false;
  render();
}

function render() {
  clear(bodyEl);

  const seg = el('div', {
    class: 'seg',
    role: 'group',
    'aria-label': 'How to add titles',
    style: 'margin:var(--s4)',
  });
  for (const [key, label] of [['search', 'Search'], ['list', 'Paste a list'], ['single', 'By hand']]) {
    seg.appendChild(
      el('button', {
        type: 'button',
        'aria-pressed': String(mode === key),
        text: label,
        onclick: () => {
          mode = key;
          focusSearch = key === 'search';
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

/*
 * Ordering the results.
 *
 * Providers answer a franchise search with whatever their own relevance
 * ranking thinks, one page deep, and the app used to show the first twelve of
 * that untouched. For a franchise that is not enough: search "Resident Evil"
 * and a dozen slots fill with sequels and animated spin-offs, while the film
 * actually called "Resident Evil" that came out last week never appears —
 * despite being the best possible match for what was typed.
 *
 * So: an exact title match outranks a title that merely starts with what you
 * typed, which outranks everything else, and a year you typed outranks all of
 * it. Provider order is kept inside each band, so a franchise still reads in
 * the order it always did — the only thing that moves is the thing you asked
 * for, upwards.
 */
const RESULT_LIMIT = 20;

function plainTitle(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function rank(found, { title, year, type }) {
  /* The Films/Series toggle changed what was asked for and then nothing
     filtered on the answer, so picking "Films" still listed series. Neither
     provider will narrow on type — the stored type is the least reliable field
     the app holds and constraining the *matcher* on it is what produced the
     1899 failure — but a tab somebody just tapped is not a stored guess. It is
     filtered here, in the screen that asked, and nowhere near the matcher. */
  const want = type === 'tv' ? 'tv' : 'movie';
  const typed = found.filter((c) => c.type === want);
  /* Unless that empties the list. A provider mis-typing the one film you are
     looking for should not leave you staring at "nothing found" — but the
     screen says so rather than quietly listing the other kind. */
  const pool = typed.length ? typed : found;
  const relaxed = !typed.length && found.length > 0;

  const asked = plainTitle(title);
  const band = (c) => {
    const t = plainTitle(c.title);
    const byTitle = t === asked ? 0 : t.startsWith(asked) ? 2 : 4;
    if (!year) return byTitle;
    return byTitle + (c.year === year ? 0 : 1);
  };

  const rows = pool
    .map((c, i) => ({ c, i, b: band(c) }))
    .sort((a, b) => a.b - b.b || a.i - b.i)
    .map((x) => x.c)
    .slice(0, RESULT_LIMIT);
  rows.relaxed = relaxed;
  return rows;
}

function searchForm() {
  const wrap = el('div', { style: 'padding:0 16px 32px' });
  const provider = getProvider(store.settings().provider);
  const key = (store.settings().dataKeys || {})[provider.id];

  const form = el('form', { style: 'display:flex;gap:var(--s2)' });
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
  const go = button('Search', { kind: 'secondary', type: 'submit' });
  form.appendChild(go);
  wrap.appendChild(form);
  /* Attached here, before the no-key early return below. It used to be wired
     only after that return, so on a fresh install a tap on Search fired a
     native GET submit and cold-rebooted the app back to Tonight. */
  form.addEventListener('submit', (e) => e.preventDefault());

  /* Type sits with the search box, not on the results: it changes what is
     searched for, and TV and film share plenty of titles. */
  let type = 'movie';
  const typeSeg = el('div', {
    class: 'seg',
    role: 'group',
    'aria-label': 'Search films or series',
    style: 'margin:var(--s3) 0',
  });
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
  const ownedRow = checkRow('I own these', true, (on) => {
    owned = on;
  });
  ownedRow.style.marginBottom = 'var(--s2)';
  wrap.appendChild(ownedRow);

  const status = el('div', {
    role: 'status',
    'aria-live': 'polite',
    style: 'font-size:var(--t-sub);color:var(--ash);margin-bottom:var(--s3);line-height:1.5',
  });
  const results = el('div', { style: 'transition:opacity var(--fast) var(--ease)' });
  wrap.appendChild(status);
  wrap.appendChild(results);

  const settle = () => {
    results.style.opacity = '';
    results.style.pointerEvents = '';
  };
  const say = (text, colour = 'var(--ash)') => {
    settle();
    clear(results);
    status.style.color = colour;
    status.textContent = text;
  };

  if (!key) {
    /* Nothing here can work without a key, so nothing should look as if it
       will. */
    input.disabled = true;
    go.disabled = true;
    ownedRow.disabled = true;
    [...typeSeg.children].forEach((b) => (b.disabled = true));
    say(`Searching needs a ${provider.label} key. Add one in Settings, or use “By hand” — that works with no key at all.`);
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
    /* Fade the list that is there rather than blanking it: clearing on every
       debounced keystroke flashed the whole list away and back while typing. */
    status.style.color = 'var(--ash)';
    status.textContent = 'Searching…';
    if (results.childElementCount) results.style.opacity = '0.45';
    results.style.pointerEvents = 'none';
    try {
      /* searchPrecise is the interactive search: it trusts the type off the
         toggle, uses a typed year, and may spend an extra request to do it.
         search() stays exactly as the matcher needs it. */
      const ask = provider.searchPrecise ? provider.searchPrecise.bind(provider) : provider.search.bind(provider);
      const found = await ask(
        { title, year, type, precise: true },
        {
          key,
          budget: new meta.RequestBudget(provider.dailyLimit, provider.id),
          signal: controller.signal,
        }
      );
      show(rank(found || [], { title, year, type }));
    } catch (err) {
      if (err?.name === 'AbortError') return;
      say(err?.message || 'That search failed.', 'var(--ember)');
    }
  }

  function show(list) {
    settle();
    clear(results);
    status.textContent = list.length
      ? list.relaxed
        ? `Nothing matched under ${type === 'tv' ? 'Series' : 'Films'} — showing the rest. Tap one to add it.`
        : 'Tap one to add it.'
      : '';
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
        class: existing ? 'result-row is-dupe' : 'result-row',
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
      if (existing) b.appendChild(dupeNote());
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
    /* Say why the row went grey — the details request after the write can take
       a few seconds on a phone. */
    const pending = el('div', { style: 'font-size:11px;color:var(--amber)', text: 'Adding…' });
    row.lastElementChild.appendChild(pending);

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
      pending.remove();
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

    /* Mark this row as already in the library, in place. This used to re-run
       the whole search — a real API request, the list blanking and rebuilding,
       the scroll collapsing — and read the box live, so an edit made while
       details loaded replaced the results with a different query's. */
    pending.remove();
    row.classList.add('is-dupe');
    row.style.opacity = '';
    row.disabled = false;
    row.onclick = () => openDetail(item.uid);
    row.lastElementChild.appendChild(dupeNote());
  }

  form.addEventListener('submit', () => {
    clearTimeout(timer);
    run();
  });
  /* Debounced as you type, so the common case needs no second tap. */
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const n = input.value.trim().length;
    /* An emptied box goes back to the intro, not a list of results for a query
       that is no longer there under "Tap one to add it." */
    if (!n) {
      controller?.abort();
      say('Search for anything — it arrives with its poster and details already filled in.');
      return;
    }
    if (n < 3) return;
    timer = setTimeout(run, 450);
  });

  if (focusSearch) requestAnimationFrame(() => input.focus());
  return wrap;
}

function dupeNote() {
  return el('div', {
    style: 'font-size:11px;color:var(--amber)',
    text: 'Already in your library — tap to open',
  });
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

  const typeSeg = el('div', {
    class: 'seg',
    role: 'group',
    'aria-label': 'Add these as films or series',
    style: 'margin:var(--s3) 0',
  });
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

  let owned = true;
  const ownedRow = checkRow('I own these', true, (on) => {
    owned = on;
  });
  ownedRow.style.marginBottom = 'var(--s4)';
  wrap.appendChild(ownedRow);

  /* No margin of its own: an empty container with a permanent 16px left the
     paste form ending 16px lower than the other two modes. */
  const result = el('div');

  const addBtn = button('Add to library', {
    kind: 'primary',
    block: true,
    iconName: 'plus',
    onClick: () => {
      const lines = ta.value.split('\n');
      const report = actions.addMany(lines, type);
      if (owned) {
        report.added.forEach((i) => store.update(i.uid, { owned: true }));
        store.saveNow();
      }
      clear(result);
      if (!report.added.length && !report.duplicates.length) {
        /* Forty unreadable lines deserve more than "Nothing to add". */
        const bad = report.invalid.length;
        toast(bad ? `Could not read ${bad} line${bad === 1 ? '' : 's'} — one title per line` : 'Nothing to add');
        return;
      }
      ta.value = '';
      addBtn.disabled = true;
      const card = summary(report);
      result.appendChild(card);
      /* The report card says what happened; the toast only needs to confirm
         it, and never reads "0 added". */
      const n = report.added.length;
      toast(n ? `${n} title${n === 1 ? '' : 's'} added` : 'Already in your library — nothing new added');
      /* Below a 150px textarea and a full-width button, the report started
         off-screen on a small phone. */
      requestAnimationFrame(() => card.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
    },
  });
  /* Live only when there is something to add, as the Ask composer does. */
  addBtn.disabled = true;
  ta.addEventListener('input', () => (addBtn.disabled = !ta.value.trim()));
  wrap.appendChild(addBtn);
  wrap.appendChild(result);
  return wrap;
}

function summary(report) {
  const box = el('div', {
    class: 'report-in',
    style:
      'margin-top:var(--s4);background:var(--surface);border:1px solid var(--hairline);' +
      'border-radius:var(--r-md);padding:var(--s4)',
  });
  box.appendChild(
    el('div', {
      style: 'font-weight:600;margin-bottom:var(--s2)',
      text: report.added.length ? `${report.added.length} added` : 'Nothing new added',
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
  /* novalidate: the handler checks the title itself, and iOS's native bubble
     is light-on-white over a dark app. */
  const form = el('form', { novalidate: true, style: 'padding:0 16px 32px' });

  const field = (id, label, props = {}) => {
    const w = el('div', { class: 'field' });
    w.appendChild(el('label', { class: 'field-label', for: id, text: label }));
    const input = el('input', { id, class: 'input', ...props });
    w.appendChild(input);
    form.appendChild(w);
    return input;
  };

  /* Autocorrect off: "Nosferatu", "Oldboy" and every non-English title are
     what it mangles, and this is the mode with no provider to fix it later. */
  const title = field('add-title', 'Title', {
    type: 'text',
    required: true,
    placeholder: 'The Thing',
    autocomplete: 'off',
    autocorrect: 'off',
    autocapitalize: 'words',
    spellcheck: 'false',
    enterkeyhint: 'done',
  });
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

  /* type=submit. button() defaults to type=button, so dropped into a form it
     did nothing — this whole mode was inert, and Enter could not submit it
     either with two fields and no submit button. */
  form.appendChild(button('Add to library', { kind: 'primary', block: true, iconName: 'plus', type: 'submit' }));

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    /* Checked against the cleaned title, which is what addItem stores: "•"
       passes a trim() and used to save an untitled record. */
    const t = cleanTitleLine(title.value);
    if (!t) {
      title.style.borderColor = 'var(--ember)';
      title.addEventListener('input', () => (title.style.borderColor = ''), { once: true });
      title.focus();
      toast('Give it a title first');
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

/*
 * Add titles — single or pasted list.
 *
 * Anything typed here is treated as authoritative and locked, so the metadata
 * sweep fills in gaps without overwriting what the user told us.
 */

import * as store from '../store.js';
import * as actions from '../actions.js';
import { el, clear, button, toast } from '../ui.js';
import { icon } from '../icons.js';
import { openDetail } from './detail.js';

let root = null;
let bodyEl = null;
let navigate = null;
let mode = 'list';

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
  for (const [key, label] of [['list', 'Paste a list'], ['single', 'One at a time']]) {
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

  bodyEl.appendChild(mode === 'list' ? listForm() : singleForm());
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
        onClick: () => navigate('settings'),
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

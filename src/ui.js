/*
 * Shared UI primitives.
 *
 * Everything here builds DOM nodes rather than concatenating innerHTML from
 * data. Film titles and API-supplied plot text are attacker-influenced in the
 * general case (an OMDb record, an imported backup, a model response), and the
 * previous version interpolated them into innerHTML in a dozen places.
 */

import { icon } from './icons.js';
import { initials, fallbackColors, escapeHtml } from './format.js';

/* ── element helper ── */

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v; // only ever called with our own markup
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style') node.setAttribute('style', v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function frag(children) {
  const f = document.createDocumentFragment();
  for (const c of [].concat(children)) if (c) f.appendChild(c);
  return f;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/* ── poster ──
   A designed fallback rather than a placeholder emoji: the film's initials
   ghosted behind its title, on a hue derived from the title so the same film
   always looks the same. */

export function poster(item, { width = null, badge = null, lazy = true } = {}) {
  const wrap = el('div', { class: 'poster' });
  if (width) wrap.style.width = typeof width === 'number' ? `${width}px` : width;

  if (item.poster) {
    const img = el('img', {
      src: item.poster,
      alt: '',
      loading: lazy ? 'lazy' : 'eager',
      decoding: 'async',
    });
    /* If the CDN 404s or the URL rotted, fall back rather than showing a
       broken-image glyph. */
    img.addEventListener('error', () => {
      img.remove();
      wrap.appendChild(fallbackTile(item));
    });
    wrap.appendChild(img);
  } else {
    wrap.appendChild(fallbackTile(item));
  }

  if (badge) wrap.appendChild(badge);
  return wrap;
}

function fallbackTile(item) {
  const { a, b } = fallbackColors(item.title);
  const tile = el('div', {
    class: 'poster-fb',
    style: `--fb-a:${a};--fb-b:${b}`,
    'data-initials': initials(item.title),
  });
  tile.appendChild(el('div', { class: 'poster-fb-t', text: item.title }));
  return tile;
}

export function posterBadge(kind) {
  return el('div', { class: 'poster-badge', html: icon(kind === 'watched' ? 'check' : 'check', 13) });
}

/* ── toast ──
   One live region, reused. Supports an optional undo action. */

let toastNode = null;
let toastTimer = null;

function ensureToast() {
  if (toastNode) return toastNode;
  toastNode = el('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
  document.body.appendChild(toastNode);
  return toastNode;
}

export function toast(message, { action = null, onAction = null, duration = 3200 } = {}) {
  const node = ensureToast();
  clearTimeout(toastTimer);
  clear(node);

  node.appendChild(el('span', { text: message }));
  if (action && onAction) {
    node.appendChild(
      el('button', {
        class: 'toast-action',
        type: 'button',
        text: action,
        onclick: () => {
          hideToast();
          onAction();
        },
      })
    );
  }
  node.classList.add('is-open');
  toastTimer = setTimeout(hideToast, duration);
}

export function hideToast() {
  clearTimeout(toastTimer);
  if (toastNode) toastNode.classList.remove('is-open');
}

/* ── bottom sheet / confirm ──
   Focus is trapped while open and restored on close; Escape dismisses. */

let sheetEls = null;
let lastFocus = null;

function ensureSheet() {
  if (sheetEls) return sheetEls;
  const scrim = el('div', { class: 'scrim' });
  const sheet = el('div', {
    class: 'sheet',
    role: 'dialog',
    'aria-modal': 'true',
    tabindex: '-1',
  });
  document.body.appendChild(scrim);
  document.body.appendChild(sheet);
  scrim.addEventListener('click', closeSheet);
  sheetEls = { scrim, sheet };
  return sheetEls;
}

function onSheetKey(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeSheet();
    return;
  }
  if (e.key !== 'Tab' || !sheetEls) return;
  const focusable = sheetEls.sheet.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  );
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

/**
 * openSheet({ title, message, actions: [{label, kind, onClick}] })
 * kind: 'primary' | 'danger' | 'secondary' | 'quiet'
 */
export function openSheet({ title, message, actions = [], dismissLabel = 'Cancel' }) {
  const { scrim, sheet } = ensureSheet();
  lastFocus = document.activeElement;
  clear(sheet);

  sheet.appendChild(el('div', { class: 'sheet-grip' }));
  if (title) {
    const id = 'sheet-title';
    sheet.appendChild(el('div', { class: 'sheet-title', id, text: title }));
    sheet.setAttribute('aria-labelledby', id);
  }
  if (message) sheet.appendChild(el('div', { class: 'sheet-msg', text: message }));

  const box = el('div', { class: 'sheet-actions' });
  for (const a of actions) {
    box.appendChild(
      el('button', {
        class: `btn btn-block btn-${a.kind || 'secondary'}`,
        type: 'button',
        text: a.label,
        onclick: () => {
          closeSheet();
          a.onClick?.();
        },
      })
    );
  }
  box.appendChild(
    el('button', {
      class: 'btn btn-block btn-quiet',
      type: 'button',
      text: dismissLabel,
      onclick: closeSheet,
    })
  );
  sheet.appendChild(box);

  scrim.classList.add('is-open');
  sheet.classList.add('is-open');
  document.addEventListener('keydown', onSheetKey);
  requestAnimationFrame(() => {
    const first = sheet.querySelector('button');
    (first || sheet).focus();
  });
}

export function closeSheet() {
  if (!sheetEls) return;
  sheetEls.scrim.classList.remove('is-open');
  sheetEls.sheet.classList.remove('is-open');
  document.removeEventListener('keydown', onSheetKey);
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  lastFocus = null;
}

/** Convenience: destructive confirmation. */
export function confirmDestructive({ title, message, confirmLabel, onConfirm }) {
  openSheet({
    title,
    message,
    actions: [{ label: confirmLabel, kind: 'danger', onClick: onConfirm }],
  });
}

/* ── chips & tags ── */

export function chip(text, iconName = null, cls = '') {
  const node = el('span', { class: `chip${cls ? ' ' + cls : ''}` });
  if (iconName) node.appendChild(el('span', { html: icon(iconName, 13) }).firstChild);
  node.appendChild(el('span', { text }));
  return node;
}

export function tag(text, cls = '') {
  return el('span', { class: `tag${cls ? ' ' + cls : ''}`, text });
}

/* ── empty state ── */

export function emptyState({ iconName = 'film', title, message, action = null }) {
  const box = el('div', { class: 'empty' });
  box.appendChild(el('div', { html: icon(iconName, 30) }).firstChild);
  if (title) box.appendChild(el('div', { class: 'empty-title', text: title }));
  if (message) box.appendChild(el('div', { text: message }));
  if (action) {
    box.appendChild(
      el(
        'div',
        { style: 'margin-top:20px;display:flex;justify-content:center' },
        el('button', {
          class: 'btn btn-secondary',
          type: 'button',
          text: action.label,
          onclick: action.onClick,
        })
      )
    );
  }
  return box;
}

/* ── icon button ── */

export function iconButton(name, label, onClick, { size = 21, cls = '' } = {}) {
  return el('button', {
    class: `iconbtn${cls ? ' ' + cls : ''}`,
    type: 'button',
    'aria-label': label,
    title: label,
    html: icon(name, size),
    onclick: onClick,
  });
}

/** Button with a leading icon. */
export function button(label, { kind = 'secondary', iconName = null, onClick, block = false, size = null } = {}) {
  const b = el('button', {
    class: `btn btn-${kind}${block ? ' btn-block' : ''}${size === 'sm' ? ' btn-sm' : ''}`,
    type: 'button',
    onclick: onClick,
  });
  if (iconName) b.appendChild(el('span', { html: icon(iconName, size === 'sm' ? 15 : 17) }).firstChild);
  b.appendChild(el('span', { text: label }));
  return b;
}

export { escapeHtml };

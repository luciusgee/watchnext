/*
 * Somebody else's shelf.
 *
 * What a recipient sees when they tap a shared link. They may well not have the
 * app — this is the page a stranger lands on, so it has to be readable on its
 * own and it has to be obvious what the app is for by looking at it. That makes
 * this screen the closest thing the project has to a store listing.
 *
 * Read-only, and nothing is merged automatically. A list that silently writes
 * into your library is the complaint every app with shared lists eventually
 * collects; adding is one tap, per title, always deliberate.
 */

import * as store from '../store.js';
import { decodeShelf } from '../share.js';
import { el, clear, button, toast, poster, emptyState } from '../ui.js';
import { plural } from '../format.js';
import * as haptics from '../haptics.js';
import { addItem } from '../actions.js';

let root = null;
let bodyEl = null;
let navigate = null;
let shelf = null;

export function initShelf({ navigate: nav }) {
  navigate = nav;
  root = document.getElementById('screen-shelf');
  bodyEl = root.querySelector('[data-region="body"]');
}

export async function showShelf() {
  clear(bodyEl);
  bodyEl.appendChild(
    el('div', { class: 'big-figure', role: 'status' }, [
      el('div', { class: 'skeleton', style: 'width:72px;height:56px;margin:0 auto;border-radius:var(--r-md)' }),
      el('div', { class: 'big-figure-l', text: 'Opening their shelf…' }),
    ])
  );

  try {
    shelf = await decodeShelf();
  } catch {
    shelf = null;
  }

  clear(bodyEl);

  if (!shelf) {
    /* A link that claims to be a shelf and is not. Saying so is better than an
       empty page, which reads as "their shelf is empty" or "the app is broken". */
    bodyEl.appendChild(
      emptyState({
        iconName: 'warning',
        title: 'That link could not be read',
        message: 'It may have been cut short — some apps truncate long links. Ask for it to be sent again.',
        action: { label: 'Go to my library', onClick: leave },
      })
    );
    return;
  }

  render();
}

function leave() {
  history.replaceState(null, '', location.pathname + location.search);
  navigate('tonight');
}

/*
 * Built once and updated in place. Every per-row Add used to rebuild the whole
 * page: the header changed height as counts crossed thresholds, the list moved
 * under the thumb, and the tapped button — destroyed — took focus with it.
 */
let summaryEl = null;
let addAllBtn = null;

/* The same test the app uses for duplicates: title and year together. By
   title alone, their Dune (1984) showed "In your library" beside your Dune
   (2021), and could not be added. */
const inMine = (film) => !!store.findDuplicate(film.title, film.year, film.type);

function render() {
  clear(bodyEl);

  const mine = store.items();

  /* One heading, so someone navigating by headings reaches the page's subject
     rather than only the wordmark. */
  bodyEl.appendChild(
    el('h2', { class: 'big-figure', style: 'font-weight:400' }, [
      el('span', { class: 'big-figure-n', style: 'display:block', text: String(shelf.length) }),
      el('span', {
        class: 'big-figure-l',
        style: 'display:block',
        text: shelf.length === 1 ? 'film on their shelf' : 'films on their shelf',
      }),
    ])
  );

  /* The set operation, computed entirely on this device. This is the thing
     people mean when they ask for a shared list — what have they got that I
     have not — and it needs no shared state at all. */
  summaryEl = el('div', {
    role: 'status',
    style: 'padding:var(--s2) var(--s4) 0;text-align:center;font-size:var(--t-sub);color:var(--ash)',
  });
  bodyEl.appendChild(summaryEl);

  /* The primary action at full size: on the page that works as this app's
     store listing it was the smaller of the two buttons. */
  addAllBtn = button('Add all', { kind: 'primary', iconName: 'plus', onClick: () => addAll(missing()) });
  bodyEl.appendChild(el('div', { style: 'padding:var(--s4) var(--s4) 0;display:flex;justify-content:center' }, addAllBtn));

  const list = el('div', { class: 'lib-list', style: 'margin-top:var(--s5)' });
  for (const film of shelf) list.appendChild(rowFor(film));
  bodyEl.appendChild(list);
  refreshSummary();

  bodyEl.appendChild(
    el('div', {
      style: 'padding:var(--s6) var(--s4) var(--s2);text-align:center;font-size:var(--t-meta);color:var(--ash);line-height:1.6',
      text: 'This list came from the link, not from a server — nothing was uploaded and nobody has an account. Watch Next keeps your own films on your own phone.',
    })
  );
  bodyEl.appendChild(
    el('div', { style: 'padding:var(--s2) var(--s4) var(--s8);display:flex;justify-content:center' },
      button(mine.length ? 'Back to my library' : 'Start my own library', {
        kind: 'secondary',
        onClick: leave,
      }))
  );
}

const missing = () => shelf.filter((f) => !inMine(f));

/* One voice — it is talking to you — and the same sentence whatever the
   counts, so nothing is inserted above the list as they change. */
function refreshSummary() {
  const n = missing().length;
  const both = shelf.length - n;
  summaryEl.textContent = !n
    ? 'You already have all of these.'
    : !both
      ? `None of these are in your library yet.`
      : `${n} you don’t have · ${both} you both have`;
  addAllBtn.lastElementChild.textContent = n > 1 ? `Add all ${n}` : 'Add all';
  /* Disabled rather than removed, so the list below never jumps. */
  addAllBtn.disabled = n < 2;
}

function inLibrary() {
  return el('span', { style: 'font-size:var(--t-meta);color:var(--ash)', text: 'In your library' });
}

function rowFor(film) {
  const already = inMine(film);
  const row = el('div', { class: 'row', style: 'cursor:default' });

  row.appendChild(poster({ title: film.title, poster: null }, { width: 44 }));

  const body = el('div', { class: 'row-body' });
  body.appendChild(el('div', { class: 'row-t', text: film.title }));
  body.appendChild(
    el('div', {
      class: 'row-s',
      text: [film.year, film.quality, film.watched ? 'they have seen it' : null].filter(Boolean).join(' · '),
    })
  );
  row.appendChild(body);

  const end = el('div', { class: 'row-end' });
  /* "Got it" read as "understood" as much as "you own this". */
  if (already) {
    end.appendChild(inLibrary());
  } else {
    const add = button('Add', {
      kind: 'secondary',
      size: 'sm',
      /* Named for its film: a column of identical "Add" buttons told a
         VoiceOver user nothing about which one they were on. */
      onClick: () => {
        const { item, duplicate } = addItem({
          title: film.title,
          year: film.year,
          type: film.type,
          locked: ['title'],
        });
        store.saveNow();
        if (!duplicate) haptics.success();
        toast(duplicate ? `${item.title} is already in your library` : `Added ${item.title}`);
        const note = inLibrary();
        note.setAttribute('tabindex', '-1');
        add.replaceWith(note);
        note.focus({ preventScroll: true });
        refreshSummary();
      },
    });
    add.setAttribute('aria-label', `Add ${film.title}`);
    end.appendChild(add);
  }
  row.appendChild(end);
  return row;
}

function addAll(films) {
  let added = 0;
  for (const film of films) {
    const { duplicate } = addItem({
      title: film.title,
      year: film.year,
      type: film.type,
      locked: ['title'],
    });
    if (!duplicate) added += 1;
  }
  store.saveNow();
  store.emit('item');
  if (added) haptics.success();
  toast(added ? `Added ${plural(added, 'title')}. Look up their details from Settings.` : 'Nothing new to add');
  render();
}

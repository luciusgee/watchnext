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
import { el, clear, button, toast, poster } from '../ui.js';
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
  bodyEl.appendChild(el('div', { style: 'padding:32px 16px;text-align:center;color:var(--ash)', text: 'Opening…' }));

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
      el('div', {
        style: 'padding:32px 16px;text-align:center;color:var(--ash);line-height:1.6',
        text: 'That link could not be read. It may have been cut short — long links get truncated by some apps.',
      })
    );
    bodyEl.appendChild(
      el('div', { style: 'padding:0 16px;display:flex;justify-content:center' },
        button('Go to my library', { kind: 'secondary', onClick: leave }))
    );
    return;
  }

  render();
}

function leave() {
  history.replaceState(null, '', location.pathname + location.search);
  navigate('tonight');
}

function render() {
  clear(bodyEl);

  const mine = store.items();
  const owned = shelf.filter((f) => f.quality || f.watched === false).length;

  bodyEl.appendChild(
    el('div', { style: 'padding:24px 16px 4px;text-align:center' },
      el('div', {
        style: 'font-size:44px;font-weight:650;color:var(--amber);line-height:1',
        text: String(shelf.length),
      }))
  );
  bodyEl.appendChild(
    el('div', {
      style: 'padding:8px 16px 0;text-align:center;font-size:14px;color:var(--silver)',
      text: shelf.length === 1 ? 'film on their shelf' : 'films on their shelf',
    })
  );

  /* The set operation, computed entirely on this device. This is the thing
     people mean when they ask for a shared list — what have they got that I
     have not — and it needs no shared state at all. */
  const have = new Set(mine.map((i) => store.normaliseTitle(i.title)));
  const newToYou = shelf.filter((f) => !have.has(store.normaliseTitle(f.title)));
  if (mine.length) {
    bodyEl.appendChild(
      el('div', {
        style: 'padding:10px 16px 0;text-align:center;font-size:13px;color:var(--ash)',
        text: newToYou.length
          ? `${newToYou.length} you have not got. ${shelf.length - newToYou.length} you both have.`
          : 'You already have all of these.',
      })
    );
  }

  if (newToYou.length > 1) {
    bodyEl.appendChild(
      el('div', { style: 'padding:16px 16px 0;display:flex;justify-content:center' },
        button(`Add the ${newToYou.length} I am missing`, {
          kind: 'primary',
          size: 'sm',
          onClick: () => addAll(newToYou),
        }))
    );
  }

  const list = el('div', { class: 'lib-list', style: 'margin-top:20px' });
  for (const film of shelf) {
    list.appendChild(rowFor(film, have));
  }
  bodyEl.appendChild(list);

  bodyEl.appendChild(
    el('div', {
      style: 'padding:24px 16px 8px;text-align:center;font-size:12px;color:var(--faint);line-height:1.6',
      text: 'This list came from the link, not from a server — nothing was uploaded and nobody has an account. Watch Next keeps your own films on your own phone.',
    })
  );
  bodyEl.appendChild(
    el('div', { style: 'padding:8px 16px 40px;display:flex;justify-content:center' },
      button(mine.length ? 'Back to my library' : 'Start my own library', {
        kind: 'secondary',
        onClick: leave,
      }))
  );
}

function rowFor(film, have) {
  const already = have.has(store.normaliseTitle(film.title));
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
  if (already) {
    end.appendChild(el('span', { style: 'font-size:12px;color:var(--ash)', text: 'Got it' }));
  } else {
    end.appendChild(
      button('Add', {
        kind: 'secondary',
        size: 'sm',
        onClick: () => {
          const { item, duplicate } = addItem({
            title: film.title,
            year: film.year,
            type: film.type,
            locked: ['title'],
          });
          store.saveNow();
          toast(duplicate ? `${item.title} is already in your library` : `Added ${item.title}`);
          render();
        },
      })
    );
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
  toast(added ? `Added ${added} titles. Look up their details from Settings.` : 'Nothing new to add');
  render();
}

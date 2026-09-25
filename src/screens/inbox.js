/*
 * Notifications, in the app: the bell at the top of Tonight and Ask.
 *
 * Everything the other phone has done that this one should know about — a
 * comment, a film put in Spotlight — newest first. Tap one and it takes you
 * there (the thread for a comment, the film for a Spotlight) and counts as
 * read; clear them one at a time or all at once. The number on the bell is
 * the number on the app icon, and reading or clearing takes both down.
 *
 * The list itself is worked out in store.js (inbox()), from the same shared
 * comments and Spotlights the rest of the app shows.
 */

import * as store from '../store.js';
import { el, clear, poster, openPanel } from '../ui.js';
import { icon } from '../icons.js';
import { relativeTime } from '../format.js';
import { openDetail } from './detail.js';
import { openThread } from './thread.js';

let openNow = null;

export function initInbox() {
  for (const b of document.querySelectorAll('[data-action="inbox"]')) {
    b.appendChild(el('span', { class: 'bell-count', 'aria-hidden': 'true', hidden: '' }));
    b.addEventListener('click', () => openInbox());
  }
  paintBells();
}

/** The count on every bell. */
export function paintBells() {
  const n = store.inboxUnread();
  for (const b of document.querySelectorAll('[data-action="inbox"]')) {
    const count = b.querySelector('.bell-count');
    if (count) {
      count.textContent = n > 9 ? '9+' : String(n);
      count.hidden = !n;
    }
    b.setAttribute('aria-label', n ? `Notifications, ${n} new` : 'Notifications');
  }
}

/* Delivered notifications for what has been read go from Notification
   Centre too. Best effort: not every iOS version lets a page see them. */
async function dismissDelivered(tags) {
  try {
    const reg = await navigator.serviceWorker?.ready;
    const shown = (await reg?.getNotifications?.()) || [];
    for (const n of shown) if (!tags || tags.includes(n.tag)) n.close();
  } catch {
    /* a nicety */
  }
}

const tagFor = (e) => (e.kind === 'comment' ? `thread-${e.uid}` : `spot-${e.uid}`);

export function openInbox() {
  if (openNow && !openNow.closing()) return;
  const { panel, close, show, isClosing } = openPanel({
    label: 'Notifications',
    className: 'inbox-sheet',
    onClose: () => {
      unsubscribe();
      openNow = null;
    },
  });
  openNow = { closing: isClosing };

  panel.appendChild(el('div', { class: 'sheet-grip' }));
  const head = el('div', { class: 'inbox-head' });
  head.appendChild(el('h2', { class: 'sheet-title', text: 'Notifications' }));
  const clearAll = el('button', {
    class: 'inbox-clear-all',
    type: 'button',
    text: 'Clear all',
    onclick: () => {
      const gone = store.clearAllInbox();
      if (gone) {
        dismissDelivered(null);
        store.emit('inbox');
      }
    },
  });
  head.appendChild(clearAll);
  panel.appendChild(head);

  const list = el('div', { class: 'inbox-list', role: 'list' });
  panel.appendChild(list);

  const paint = () => {
    const entries = store.inbox();
    clear(list);
    clearAll.hidden = !entries.length;
    if (!entries.length) {
      list.appendChild(
        el('div', {
          class: 'inbox-empty',
          html: `${icon('bell', 28)}<p>Nothing new.</p><p class="inbox-empty-sub">When the other phone comments on a film or puts one in Spotlight, it shows up here.</p>`,
        })
      );
      return;
    }
    for (const e of entries) list.appendChild(row(e));
  };

  const row = (e) => {
    const item = el('div', { class: `inbox-item${e.read ? '' : ' is-unread'}`, role: 'listitem' });
    const who = e.by || 'They';
    const go = el('button', {
      class: 'inbox-go',
      type: 'button',
      'aria-label': `${e.read ? '' : 'New. '}${e.kind === 'comment' ? `${who} commented on ${e.title}: ${e.text}` : `${who} put ${e.title} in Spotlight`}. ${relativeTime(e.at)}`,
      onclick: () => {
        store.readInbox(e.id);
        dismissDelivered([tagFor(e)]);
        store.emit('inbox');
        close();
        /* After the sheet has started to go, so the film slides in over the
           screen rather than under a closing sheet. */
        setTimeout(() => {
          if (!store.byUid(e.uid)) return;
          openDetail(e.uid);
          if (e.kind === 'comment') openThread(e.uid);
        }, 60);
      },
    });
    go.appendChild(poster(e.item, { width: 44 }));
    const text = el('div', { class: 'inbox-text' });
    const line = el('div', { class: 'inbox-line' });
    line.appendChild(el('b', { text: who }));
    line.appendChild(document.createTextNode(e.kind === 'comment' ? ' commented on ' : ' put '));
    line.appendChild(el('b', { text: e.title }));
    if (e.kind === 'spotlight') line.appendChild(document.createTextNode(' in Spotlight'));
    text.appendChild(line);
    if (e.kind === 'comment') text.appendChild(el('div', { class: 'inbox-quote', text: e.text }));
    text.appendChild(el('div', { class: 'inbox-when', text: relativeTime(e.at) }));
    go.appendChild(text);
    item.appendChild(go);
    item.appendChild(
      el('button', {
        class: 'inbox-clear',
        type: 'button',
        'aria-label': 'Clear',
        html: icon('close', 16),
        onclick: () => {
          store.clearInbox(e.id);
          dismissDelivered([tagFor(e)]);
          store.emit('inbox');
        },
      })
    );
    return item;
  };

  const unsubscribe = store.subscribe((reason) => {
    if ((reason === 'item' || reason === 'inbox') && panel.isConnected) paint();
  });

  paint();
  show();
}

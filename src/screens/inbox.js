/*
 * Notifications, in the app: the bell at the top of Tonight and Ask.
 *
 * The other phone's comments and superlikes, newest first. Tap one and it
 * takes you there (the thread for a comment, the film for a superlike) and
 * counts as read; clear them one at a time or all at once. The number on the
 * bell is the number on the app icon, and reading or clearing takes both
 * down.
 *
 * The list itself is worked out in store.js (inbox()), from the same shared
 * comments and superlikes the rest of the app shows.
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
    for (const n of shown) if (tags.includes(n.tag)) n.close();
  } catch {
    /* a nicety */
  }
}

const tagFor = (e) => (e.kind === 'superlike' ? `super-${e.uid}` : `thread-${e.uid}`);

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
      const all = store.inbox();
      if (store.clearAllInbox()) {
        dismissDelivered([...new Set(all.map(tagFor))]);
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
          html: `${icon('bell', 28)}<p>Nothing new.</p><p class="inbox-empty-sub">When the other phone comments on a film or superlikes one, it shows up here.</p>`,
        })
      );
      return;
    }
    /* The newest sixty drawn; the count and Clear all cover the rest. */
    for (const e of entries.slice(0, store.INBOX_MAX)) list.appendChild(row(e));
    if (entries.length > store.INBOX_MAX) {
      list.appendChild(el('div', { class: 'inbox-more', text: `And ${entries.length - store.INBOX_MAX} older` }));
    }
  };

  const row = (e) => {
    const item = el('div', { class: `inbox-item${e.read ? '' : ' is-unread'} is-${e.kind}`, role: 'listitem' });
    const who = e.by || 'They';
    const verb = e.kind === 'superlike' ? ' superliked ' : ' commented on ';
    const go = el('button', {
      class: 'inbox-go',
      type: 'button',
      'aria-label': `${e.read ? '' : 'New. '}${who}${verb}${e.title}${e.text ? `: ${e.text}` : ''}. ${relativeTime(e.at)}`,
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
    const art = el('div', { class: 'inbox-art' });
    art.appendChild(poster(e.item, { width: 44 }));
    if (e.kind === 'superlike') art.appendChild(el('span', { class: 'inbox-mark', html: icon('flameFill', 14) }));
    go.appendChild(art);
    const text = el('div', { class: 'inbox-text' });
    const line = el('div', { class: 'inbox-line' });
    line.appendChild(el('b', { text: who }));
    line.appendChild(document.createTextNode(verb));
    line.appendChild(el('b', { text: e.title }));
    text.appendChild(line);
    if (e.text) text.appendChild(el('div', { class: 'inbox-quote', text: e.text }));
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
          /* Notification Centre's copy goes too — unless something still
             unread shares it (one film's comments replace each other there
             under one tag). */
          if (!store.inbox().some((x) => !x.read && tagFor(x) === tagFor(e))) dismissDelivered([tagFor(e)]);
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

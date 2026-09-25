/*
 * A film's comments.
 *
 * The two of you deciding what to watch, in writing: "what do you think of
 * this for Saturday?", "looks like that thing we watched last week". Shared
 * through the same private repo as the library, so the other phone has it
 * within half a minute — and, with notifications on, is told.
 *
 * Deliberately small: a thread per film, your name on what you write, and
 * the one thing you can do to a comment is take back your own.
 */

import * as store from '../store.js';
import { el, clear, poster, toast, openPanel } from '../ui.js';
import { icon } from '../icons.js';
import { relativeTime } from '../format.js';

/**
 * Open the comments for a film in the library.
 * @param {string} uid
 * @param {{ onClose?: () => void }} [opts]
 */
export function openThread(uid, { onClose = null } = {}) {
  const item = store.byUid(uid);
  if (!item) return;

  const { panel, close, show } = openPanel({
    label: `Comments on ${item.title}`,
    className: 'thread-sheet',
    onClose: () => {
      unsubscribe();
      onClose?.();
    },
  });

  panel.appendChild(el('div', { class: 'sheet-grip' }));
  const head = el('div', { class: 'thread-head' });
  head.appendChild(poster(item, { width: 40 }));
  const headText = el('div', { style: 'flex:1;min-width:0' });
  headText.appendChild(el('div', { class: 'sheet-title', style: 'margin:0;text-align:left', text: item.title }));
  headText.appendChild(
    el('div', {
      class: 'thread-sub',
      text: item.spotlight ? 'In Spotlight — what you are both deciding from' : 'Comments',
    })
  );
  head.appendChild(headText);
  panel.appendChild(head);

  const list = el('div', { class: 'thread-list', role: 'log', 'aria-live': 'polite' });
  panel.appendChild(list);

  const paint = () => {
    const current = store.byUid(uid) || item;
    const notes = store.notesFor(current);
    const mine = store.me().device;
    clear(list);
    if (!notes.length) {
      list.appendChild(
        el('div', {
          class: 'thread-empty',
          text: 'Nothing yet. Say what you think — it goes to the other phone and puts this film in Spotlight.',
        })
      );
    }
    for (const n of notes) {
      const own = n.device === mine;
      const row = el('div', { class: `note${own ? ' is-own' : ''}` });
      const bubble = el('div', { class: 'note-bubble selectable', text: n.text });
      row.appendChild(bubble);
      const meta = el('div', { class: 'note-meta' });
      meta.appendChild(el('span', { text: `${own ? 'You' : n.by || 'Them'} · ${relativeTime(n.at)}` }));
      if (own) {
        meta.appendChild(
          el('button', {
            class: 'note-delete',
            type: 'button',
            text: 'Delete',
            'aria-label': 'Delete this comment',
            onclick: () => {
              store.removeNote(n.id);
              store.emit('item');
            },
          })
        );
      }
      row.appendChild(meta);
      list.appendChild(row);
    }
    store.markThreadSeen(current.uid);
    requestAnimationFrame(() => {
      list.scrollTop = list.scrollHeight;
    });
  };

  /* A name, once per phone: the other phone's comments say who wrote them. */
  const form = el('form', { class: 'thread-compose' });
  const needsName = !store.me().name;
  let nameInput = null;
  if (needsName) {
    nameInput = el('input', {
      class: 'input',
      type: 'text',
      placeholder: 'Your name',
      'aria-label': 'Your name, shown on your comments',
      autocomplete: 'given-name',
      autocapitalize: 'words',
      maxlength: '40',
      enterkeyhint: 'next',
    });
    form.appendChild(el('div', { class: 'thread-name-hint', text: 'First, what should your comments say you are called?' }));
    form.appendChild(nameInput);
  }
  const row = el('div', { class: 'thread-compose-row' });
  const text = el('textarea', {
    class: 'input thread-input',
    rows: '1',
    placeholder: 'Say something about it…',
    'aria-label': 'Your comment',
    maxlength: '2000',
    enterkeyhint: 'send',
  });
  const send = el('button', { class: 'thread-send', type: 'submit', 'aria-label': 'Send', html: icon('send', 20) });
  row.appendChild(text);
  row.appendChild(send);
  form.appendChild(row);
  panel.appendChild(form);

  const grow = () => {
    text.style.height = 'auto';
    text.style.height = `${Math.min(120, text.scrollHeight)}px`;
    send.disabled = !text.value.trim();
  };
  text.addEventListener('input', grow);
  text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (nameInput) {
      const name = nameInput.value.trim();
      if (!name) {
        nameInput.focus();
        toast('Add your name first');
        return;
      }
      store.setName(name);
      nameInput.previousElementSibling?.remove();
      nameInput.remove();
      nameInput = null;
    }
    const note = store.addNote(uid, text.value);
    if (!note) return;
    text.value = '';
    grow();
    store.emit('item');
  });
  grow();

  const unsubscribe = store.subscribe((reason) => {
    if (reason === 'item' && panel.isConnected) paint();
  });

  paint();
  show();
  /* The keyboard only when there is nothing to read yet — opening a thread
     to read it should not cover it. */
  if (!store.notesFor(item).length) requestAnimationFrame(() => (nameInput || text).focus({ preventScroll: true }));
  return { close };
}

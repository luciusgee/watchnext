/*
 * Detail overlay.
 *
 * The old version gave this screen a 340px header containing a single giant
 * emoji, then stacked four full-width buttons down the page. Here the poster
 * is the subject, its own artwork tints the backdrop, and the actions are
 * ordered by how often they're actually used.
 */

import * as store from '../store.js';
import * as actions from '../actions.js';
import { el, clear, poster, button, iconButton, confirmDestructive, openSheet, toast } from '../ui.js';
import { icon } from '../icons.js';
import { runtime, metaLine, imdbUrl, trailerUrl, justWatchUrl, relativeTime, rating } from '../format.js';
import { similarTo } from '../recommend.js';
import { openMatchPicker } from './match.js';

let root = null;
let currentUid = null;
let lastFocus = null;
let onNavigate = null;
const historyStack = [];

export function initDetail({ navigate }) {
  onNavigate = navigate;
  root = document.getElementById('detail');
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && root.classList.contains('is-open')) {
      e.preventDefault();
      closeDetail();
    }
  });
  store.subscribe((reason) => {
    if (reason === 'item' && currentUid && root.classList.contains('is-open')) {
      const item = store.byUid(currentUid);
      if (item) render(item);
      else closeDetail();
    }
  });
}

export function openDetail(uid, { push = true } = {}) {
  const item = store.byUid(uid);
  if (!item) return;
  if (push && currentUid && currentUid !== uid) historyStack.push(currentUid);
  if (!root.classList.contains('is-open')) lastFocus = document.activeElement;

  currentUid = uid;
  render(item);
  root.classList.add('is-open');
  root.setAttribute('aria-hidden', 'false');
  document.getElementById('app').setAttribute('aria-hidden', 'true');
  root.querySelector('.detail-body').scrollTop = 0;
  requestAnimationFrame(() => root.querySelector('.detail-back')?.focus());
}

export function closeDetail() {
  if (historyStack.length) {
    const prev = historyStack.pop();
    if (store.byUid(prev)) {
      openDetail(prev, { push: false });
      return;
    }
  }
  root.classList.remove('is-open');
  root.setAttribute('aria-hidden', 'true');
  document.getElementById('app').setAttribute('aria-hidden', 'false');
  currentUid = null;

  /* The list underneath may have re-rendered while the overlay was open (any
     watch-state change rebuilds it), which detaches the element we came from.
     Falling back to the active screen keeps focus inside the app rather than
     dropping it on <body>, where the next Tab starts from the top again. */
  if (lastFocus && document.contains(lastFocus)) {
    lastFocus.focus();
  } else {
    const screen = document.querySelector('.screen.is-active');
    if (screen) {
      screen.setAttribute('tabindex', '-1');
      screen.focus();
    }
  }
  lastFocus = null;
}

export function isDetailOpen() {
  return root?.classList.contains('is-open');
}

/* ── render ── */

function render(item) {
  clear(root);

  root.appendChild(hero(item));

  const body = el('div', { class: 'scroll detail-body' });
  root.appendChild(body);

  /* Watch state is carried by the action button below, so the old status
     banner just restated it. The one thing the button cannot say is *when*. */
  if (item.watched && item.watchedAt) {
    body.appendChild(
      el('p', {
        style: 'font-size:13px;color:var(--sage);margin-bottom:16px',
        text: `Watched ${relativeTime(item.watchedAt)}`,
      })
    );
  }

  /* overview */
  if (item.overview) {
    body.appendChild(el('p', { class: 'detail-overview', text: item.overview }));
  } else if (item.meta?.status === 'pending' || item.meta?.status === 'stale') {
    body.appendChild(
      el('p', {
        class: 'detail-overview',
        style: 'color:var(--faint)',
        text: 'No description yet — this title has not been looked up.',
      })
    );
  }

  /* primary actions */
  const acts = el('div', { class: 'detail-actions' });
  acts.appendChild(
    button(item.watched ? 'Watched' : 'Mark watched', {
      kind: item.watched ? 'on' : 'secondary',
      iconName: item.watched ? 'check' : 'eye',
      onClick: () => actions.setWatched(item.uid, !item.watched),
    })
  );
  acts.appendChild(
    button(item.owned ? 'I own this' : 'Mark as owned', {
      kind: item.owned ? 'on-amber' : 'secondary',
      iconName: 'drive',
      onClick: () => actions.setOwned(item.uid, !item.owned),
    })
  );
  body.appendChild(acts);

  /* external links */
  const links = el('div', { class: 'detail-links' });
  links.appendChild(linkButton('Trailer', 'playFill', trailerUrl(item)));
  links.appendChild(linkButton('IMDb', 'external', imdbUrl(item)));
  links.appendChild(linkButton('Streaming', 'tv', justWatchUrl(item)));
  body.appendChild(links);

  /* collection */
  body.appendChild(collectionRow(item));

  /* Stop suggesting this.
     The scorer is otherwise unarguable — it picks, and the only recourse is to
     keep saying "something else". One control here is the difference between a
     recommendation you can correct and one you have to put up with. Muting is
     not deleting: the film stays in the library, stays searchable, and stays
     yours. */
  {
    const muted = store.tastePrefs().never.includes(item.uid);
    body.appendChild(
      el(
        'div',
        { style: 'margin-top:10px' },
        el('button', {
          class: 'btn btn-quiet btn-sm',
          type: 'button',
          style: 'width:100%',
          text: muted ? 'Suggest this again' : 'Stop suggesting this',
          onclick: () => {
            store.setTaste('never', item.uid, !muted);
            store.saveNow();
            store.emit('item');
            toast(
              muted
                ? `${item.title} can be suggested again`
                : `${item.title} will not be suggested. It stays in your library.`
            );
            render(store.byUid(item.uid) || item);
          },
        })
      )
    );
  }

  /* metadata state — surfaced honestly rather than hidden */
  if (item.meta?.status === 'review' || item.meta?.status === 'unmatched') {
    body.appendChild(matchWarning(item));
  }

  /* Always available, not only for titles the matcher flagged. A confidently
     wrong match is the one you most need to correct, and it is precisely the
     one that never appears in the review queue. */
  body.appendChild(
    el(
      'div',
      { style: 'margin-top:14px' },
      el('button', {
        class: 'btn btn-quiet btn-sm',
        type: 'button',
        style: 'width:100%',
        text: 'Wrong film? Pick another',
        onclick: () =>
          openMatchPicker(item, {
            /* Re-read from the store rather than re-using the captured item —
               the picker has just replaced most of its fields. */
            onDone: () => {
              const fresh = store.byUid(item.uid);
              if (fresh) render(fresh);
            },
          }),
      })
    )
  );

  /* similar */
  const similar = similarTo(item, store.items());
  if (similar.length) {
    const sec = el('div', { class: 'section', style: 'margin:0 -16px' });
    sec.appendChild(
      el('div', { class: 'section-head' }, el('div', { class: 'eyebrow', text: 'More like this' }))
    );
    const rail = el('div', { class: 'rail' });
    for (const s of similar) rail.appendChild(miniCard(s));
    sec.appendChild(rail);
    body.appendChild(sec);
  }

  /* destructive, last */
  body.appendChild(
    el(
      'div',
      { style: 'margin-top:32px' },
      button('Remove from library', {
        kind: 'danger',
        iconName: 'trash',
        block: true,
        onClick: () =>
          confirmDestructive({
            title: 'Remove this title?',
            message: `${item.title} will be removed from your library. You can undo this straight after.`,
            confirmLabel: 'Remove',
            onConfirm: () => {
              actions.removeItem(item.uid);
              closeDetail();
            },
          }),
      })
    )
  );
}

function hero(item) {
  const wrap = el('div', { class: 'detail-hero' });

  if (item.poster) {
    wrap.appendChild(
      el('div', { class: 'detail-hero-bg', style: `background-image:url("${cssUrl(item.poster)}")` })
    );
  }
  wrap.appendChild(el('div', { class: 'detail-hero-veil' }));

  const back = iconButton('back', 'Back', closeDetail, { cls: 'detail-back' });
  wrap.appendChild(back);

  const inner = el('div', { class: 'detail-hero-in' });
  inner.appendChild(poster(item, { width: 116, lazy: false }));

  const heading = el('div', { class: 'detail-heading' });
  heading.appendChild(el('h1', { class: 'detail-title', text: item.title }));

  const chips = el('div', { class: 'chips' });
  if (item.year) chips.appendChild(el('span', { class: 'chip', text: String(item.year) }));
  if (item.rating !== null && item.rating !== undefined) {
    const r = el('span', { class: 'chip chip-rating' });
    r.appendChild(el('span', { html: icon('starFill', 13) }).firstChild);
    r.appendChild(el('span', { text: rating(item.rating) }));
    chips.appendChild(r);
  }
  if (item.runtime) {
    const t = el('span', { class: 'chip' });
    t.appendChild(el('span', { html: icon('clock', 13) }).firstChild);
    t.appendChild(el('span', { text: runtime(item.runtime) }));
    chips.appendChild(t);
  }
  heading.appendChild(chips);

  const tags = el('div', { class: 'chips', style: 'margin-top:8px' });
  if (item.genre) tags.appendChild(el('span', { class: 'tag', text: item.genre }));
  if (item.type === 'tv') tags.appendChild(el('span', { class: 'tag', text: 'Series' }));
  if (item.quality) tags.appendChild(el('span', { class: 'tag tag-accent', text: item.quality }));
  if (tags.childElementCount) heading.appendChild(tags);

  inner.appendChild(heading);
  wrap.appendChild(inner);
  return wrap;
}

function linkButton(label, iconName, href) {
  const a = el('a', {
    class: 'btn btn-secondary btn-sm',
    href,
    target: '_blank',
    rel: 'noopener noreferrer',
  });
  a.appendChild(el('span', { html: icon(iconName, 15) }).firstChild);
  a.appendChild(el('span', { text: label }));
  return a;
}

function collectionRow(item) {
  const box = el('div', {
    class: 'group',
    style: 'margin:0 0 24px',
  });

  const row = el('button', { class: 'group-item', type: 'button' });
  row.appendChild(el('span', { html: icon('drive', 20) }).firstChild);
  const body = el('div', { class: 'group-item-body' });
  body.appendChild(el('div', { class: 'group-item-t', text: 'In my collection' }));
  body.appendChild(
    el('div', {
      class: 'group-item-s',
      text: item.owned
        ? item.quality
          ? `Yes · ${item.quality}`
          : 'Yes'
        : 'Not marked as owned',
    })
  );
  row.appendChild(body);
  row.appendChild(
    el('span', {
      html: icon(item.owned ? 'check' : 'plus', 18),
      style: item.owned ? 'color:var(--sage)' : 'color:var(--ash)',
    }).firstChild
  );
  row.addEventListener('click', () => {
    if (item.owned) {
      actions.setOwned(item.uid, false);
    } else {
      openSheet({
        title: 'Add to your collection',
        message: 'What quality do you have?',
        actions: ['4K', '1080p', '720p', 'Other'].map((q) => ({
          label: q,
          kind: q === '4K' ? 'primary' : 'secondary',
          onClick: () => {
            store.update(item.uid, { quality: q === 'Other' ? null : q });
            store.lockFields(item.uid, ['quality']);
            actions.setOwned(item.uid, true);
          },
        })),
      });
    }
  });
  box.appendChild(row);
  return box;
}

function matchWarning(item) {
  const box = el('div', { class: 'banner banner-warn' });
  box.appendChild(el('span', { html: icon('warning', 18) }).firstChild);
  const body = el('div');
  body.appendChild(
    el('div', {
      text:
        item.meta.status === 'review'
          ? 'We found more than one film with this name and could not tell which is yours.'
          : 'We could not find this title in the film database.',
    })
  );
  const fix = el('button', {
    class: 'btn btn-quiet btn-sm',
    type: 'button',
    text: 'Fix it',
    style: 'margin-top:10px',
    onclick: () => onNavigate?.('settings', { focus: 'review' }),
  });
  body.appendChild(fix);
  box.appendChild(body);
  return box;
}

function miniCard(item) {
  const card = el('button', { class: 'card', type: 'button' });
  card.appendChild(poster(item, { width: 108 }));
  card.appendChild(el('div', { class: 'card-t', text: item.title }));
  card.appendChild(el('div', { class: 'card-s', text: item.year ? String(item.year) : '' }));
  card.addEventListener('click', () => openDetail(item.uid));
  return card;
}

/** Guard a URL before it goes into a CSS url() — quotes/parens would break out. */
function cssUrl(u) {
  return String(u).replace(/["'()\\\s]/g, (c) => '\\' + c);
}

/* ── automation hook (see main.js exposeTestHooks) ── */
export function testCurrentUid() {
  return currentUid;
}

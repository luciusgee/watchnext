/*
 * Tonight — the app's actual job, answered above the fold.
 *
 * The old home screen was a filter surface pretending to be a home: two
 * independent filter rows sat above six stacked carousels and a stat grid.
 * This shows one pick, says why, and gets out of the way.
 */

import * as store from '../store.js';
import * as actions from '../actions.js';
import { el, clear, poster, posterBadge, button, iconButton, emptyState } from '../ui.js';
import { icon } from '../icons.js';
import { runtime, commitment, relativeTime, rating } from '../format.js';
import { tonightPick, alternates } from '../recommend.js';
import { openDetail } from './detail.js';

let root = null;
let navigate = null;
let offset = 0;
let ownedOnly = true;
const shown = [];

export function initTonight({ navigate: nav }) {
  navigate = nav;
  root = document.getElementById('screen-tonight');
  /* Ownership filter defaults on only if the user actually owns things —
     otherwise the premise filter would empty the screen on day one. */
  const owned = store.items().filter((i) => i.owned).length;
  ownedOnly = owned >= 10;
  store.subscribe((r) => {
    if (r === 'item' && isActive()) render();
  });
}

function isActive() {
  return root?.classList.contains('is-active');
}

export function showTonight() {
  render();
}

export function render() {
  const body = root.querySelector('[data-region="body"]');
  clear(body);

  const items = store.items();
  if (!items.length) {
    body.appendChild(
      emptyState({
        iconName: 'library',
        title: 'Your library is empty',
        message: 'Add the films and shows you own, and this screen will tell you what to watch.',
        action: { label: 'Add titles', onClick: () => navigate('add') },
      })
    );
    return;
  }

  const opts = { ownedOnly, offset };
  const pick = tonightPick(items, opts);

  if (pick) {
    body.appendChild(heroBlock(pick));
  } else {
    body.appendChild(
      emptyState({
        iconName: 'check',
        title: 'Nothing left to suggest',
        message: ownedOnly
          ? 'Everything you own is watched. Turn off the collection filter to see the rest.'
          : "You've watched everything. Genuinely impressive.",
        action: ownedOnly
          ? {
              label: 'Include titles I don’t own',
              onClick: () => {
                ownedOnly = false;
                render();
              },
            }
          : null,
      })
    );
  }

  /* rails */
  /* The pile. This rail used to be the watchlist, which was a list inside a
     list — the whole library is the watchlist. What is actually worth
     surfacing is the thing collectors complain about in these words: films
     they bought and never put on.
     Oldest first, meaning longest in the app. Not longest owned — nothing here
     knows when anything was bought, and on a library imported in one sitting
     this ordering is close to arbitrary until the app has been lived in. */
  const pile = items
    .filter((i) => i.owned && !i.watched)
    .sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
  if (pile.length) {
    body.appendChild(
      rail('The pile', pile.slice(0, 20), () => navigate('library', { filter: 'pile' }))
    );
  }

  const alts = alternates(items, { ...opts, exclude: pick ? [pick.item.uid] : [], limit: 20 });
  if (alts.length) body.appendChild(rail('Also worth tonight', alts.map((a) => a.item)));

  const recent = items
    .filter((i) => i.watched && i.watchedAt)
    .sort((a, b) => b.watchedAt - a.watchedAt)
    .slice(0, 20);
  if (recent.length) body.appendChild(rail('Recently watched', recent));

  body.appendChild(statLine());
  body.appendChild(el('div', { style: 'height:24px' }));
}

function heroBlock(pick) {
  const item = pick.item;
  const wrap = el('section', { class: 'hero', 'aria-labelledby': 'tonight-title' });

  if (item.poster) {
    wrap.appendChild(
      el('div', { class: 'hero-bg', style: `background-image:url("${cssUrl(item.poster)}")` })
    );
  }
  wrap.appendChild(el('div', { class: 'hero-veil' }));

  const inner = el('div', { class: 'hero-in' });

  const posterBtn = el('button', {
    class: 'card',
    type: 'button',
    style: 'width:104px',
    'aria-label': `Open ${item.title}`,
    onclick: () => openDetail(item.uid),
  });
  posterBtn.appendChild(poster(item, { width: 104, lazy: false }));
  inner.appendChild(posterBtn);

  const copy = el('div', { class: 'hero-copy' });
  copy.appendChild(el('div', { class: 'eyebrow', text: 'Tonight' }));
  copy.appendChild(el('h2', { class: 'hero-title', id: 'tonight-title', text: item.title }));

  /* The interrogatable "why" — a recommendation you can't question is noise. */
  const reasons = [];
  if (item.runtime) reasons.push(runtime(item.runtime, { long: true }));
  reasons.push(...pick.why);
  copy.appendChild(
    el('div', {
      style: 'font-size:13px;color:var(--silver);line-height:1.5',
      text: reasons.join(' · '),
    })
  );

  const acts = el('div', { class: 'hero-actions' });
  acts.appendChild(
    button('Watch it', {
      kind: 'primary',
      iconName: 'playFill',
      size: 'sm',
      onClick: () => openDetail(item.uid),
    })
  );
  acts.appendChild(
    button('Not tonight', {
      kind: 'quiet',
      iconName: 'shuffle',
      size: 'sm',
      onClick: () => {
        shown.push(item.uid);
        offset += 1;
        render();
      },
    })
  );
  /* The way out of "not that one, and not the next one either". Tonight's pick
     is one opinion; this is where you say what you actually fancy and deal a
     hand from it. */
  acts.appendChild(
    button('Something else', {
      kind: 'quiet',
      iconName: 'sliders',
      size: 'sm',
      onClick: () => navigate('pick'),
    })
  );
  copy.appendChild(acts);

  inner.appendChild(copy);
  wrap.appendChild(inner);

  /* the premise toggle, stated plainly and quietly */
  const ownedCount = store.items().filter((i) => i.owned).length;
  if (ownedCount) {
    const scope = el('div', { class: 'hero-scope' });
    const toggle = el('button', {
      type: 'button',
      'aria-pressed': String(ownedOnly),
      onclick: () => {
        ownedOnly = !ownedOnly;
        offset = 0;
        render();
      },
    });
    const box = el('span', { class: 'box' });
    if (ownedOnly) box.appendChild(el('span', { html: icon('check', 11) }).firstChild);
    toggle.appendChild(box);
    toggle.appendChild(el('span', { text: 'Only what I own' }));
    scope.appendChild(toggle);
    wrap.appendChild(scope);
  }

  return wrap;
}

function rail(title, items, onSeeAll) {
  const sec = el('section', { class: 'section' });
  const head = el('div', { class: 'section-head' });
  head.appendChild(el('h2', { class: 'eyebrow', text: title }));
  if (onSeeAll) {
    const link = el('button', { class: 'section-link', type: 'button', onclick: onSeeAll });
    link.appendChild(el('span', { text: 'See all' }));
    link.appendChild(el('span', { html: icon('chevronRight', 14) }).firstChild);
    head.appendChild(link);
  }
  sec.appendChild(head);

  const list = el('div', { class: 'rail', role: 'list' });
  for (const item of items) list.appendChild(cardFor(item));
  sec.appendChild(list);
  return sec;
}

export function cardFor(item) {
  const card = el('button', {
    class: 'card',
    type: 'button',
    role: 'listitem',
    'aria-label': `${item.title}${item.year ? `, ${item.year}` : ''}`,
    onclick: () => openDetail(item.uid),
  });
  const badge = item.watched ? posterBadge('watched') : null;
  card.appendChild(poster(item, { width: 108, badge }));
  card.appendChild(el('div', { class: 'card-t', text: item.title }));

  const sub = [];
  if (item.year) sub.push(String(item.year));
  if (item.runtime) sub.push(runtime(item.runtime));
  card.appendChild(el('div', { class: 'card-s', text: sub.join(' · ') }));
  return card;
}

function statLine() {
  const s = store.stats();
  const pct = s.total ? Math.round((s.watched / s.total) * 100) : 0;
  const bits = [`${s.total} titles`, `${s.watched} watched`, `${pct}% through`];
  if (s.hoursWatched) bits.push(`${s.hoursWatched} hours`);
  return el('div', {
    class: 'section',
    style: 'padding:28px 16px 0;font-size:13px;color:var(--ash);text-align:center',
    text: bits.join('  ·  '),
  });
}

function cssUrl(u) {
  return String(u).replace(/["'()\\\s]/g, (c) => '\\' + c);
}

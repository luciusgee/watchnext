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
import { shouldNudgeBackup, markBackedUp } from '../durability.js';
import { seedLibrary } from '../seed.js';
import { toast } from '../ui.js';

let root = null;
let navigate = null;
let ownedOnly = true;

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
    /* The starter set, offered rather than imposed. It used to arrive
       unannounced on every new install — somebody else's shelf, marked as
       owned — and there was no way to tell it apart from your own titles
       afterwards. Wanting something to poke at is a real reason to want it;
       being given it without asking is not. */
    body.appendChild(
      el(
        'div',
        { style: 'display:flex;justify-content:center;margin-top:-8px' },
        button('Or try a sample library', {
          kind: 'quiet',
          size: 'sm',
          onClick: () => {
            const n = store.loadSample(seedLibrary);
            toast(n ? `Added ${n} titles to try. Remove any you do not want.` : 'Nothing to add');
            render();
          },
        })
      )
    );
    return;
  }

  /* Whose evening is it. Only meaningful once a second person exists; solo,
     viewer() is null and this is exactly the code path it always was. */
  const person = store.viewer();
  const opts = {
    ownedOnly,
    muted: store.tastePrefs(),
    viewerSeen: person ? new Set(items.filter((i) => store.seenBy(i, person)).map((i) => i.uid)) : null,
  };
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

  const who = viewerSwitch();
  if (who) body.appendChild(who);

  const nudge = backupNudge();
  if (nudge) body.appendChild(nudge);

  body.appendChild(statLine());
  body.appendChild(el('div', { style: 'height:24px' }));
}

/**
 * Whose evening is it.
 *
 * A household shares a shelf but not a history, and the question on the sofa is
 * "something I have seen and she has not". Switching who the app is answering
 * for is the whole feature; everything else follows from the scorer knowing.
 *
 * Absent entirely for one person, which is the point — a solo library should
 * not have to look at a control for a situation it does not have.
 */
function viewerSwitch() {
  const list = store.people();
  if (list.length < 2) return null;

  const current = store.viewer();
  const wrap = el('section', { class: 'section', style: 'padding:20px 16px 0' });
  wrap.appendChild(el('h2', { class: 'eyebrow', style: 'margin-bottom:10px', text: 'Watching' }));

  const row = el('div', { style: 'display:flex;flex-wrap:wrap;gap:8px' });
  for (const p of list) {
    const active = p.id === current;
    row.appendChild(
      el('button', {
        class: 'pill',
        type: 'button',
        'aria-pressed': String(active),
        style: active ? 'border-color:var(--amber-line);color:var(--amber);background:var(--amber-dim)' : '',
        text: p.name,
        onclick: () => {
          store.setViewer(p.id);
          store.saveNow();
          render();
        },
      })
    );
  }
  wrap.appendChild(row);
  return wrap;
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
    /* "Put it on" rather than "Watch it": the button next to it marks something
        watched, and two labels a letter apart doing opposite things is how you
        get a mis-tap that edits the library. */
    button('Put it on', {
      kind: 'primary',
      iconName: 'playFill',
      size: 'sm',
      onClick: () => openDetail(item.uid),
    })
  );
  /* Closes the loop. Until this existed the screen that made the recommendation
     never found out whether it was right — you watched the film, and nothing
     told the scorer. tasteProfile() weights history by 1/(1+age in years), so
     every one of these makes tomorrow's pick better, and it is the only place
     in the app where marking something watched costs a single tap. */
  acts.appendChild(
    button('Seen it', {
      kind: 'secondary',
      iconName: 'check',
      size: 'sm',
      onClick: () => {
        actions.setWatched(item.uid, true);
        render();
      },
    })
  );
  /* This replaced a "Not tonight" button that advanced the hero by one pick.
     Both answer "no, something else", and dealing a whole hand you can steer is
     a better answer than one more take-it-or-leave-it — so there is one button
     here rather than two doing the same job badly, and four would not fit a
     phone anyway. */
  acts.appendChild(
    button('Something else', {
      kind: 'quiet',
      iconName: 'shuffle',
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

/**
 * Back up your library.
 *
 * This category is defined by data loss — "I had over 750 dvds on the app and
 * they have all disappeared" is a real review of a real competitor — and this
 * app has no server to restore from. Safari clears script-writable storage
 * after seven days without a visit, which takes localStorage and the IndexedDB
 * mirror together.
 *
 * So the prompt lives on the screen someone actually opens, not buried in
 * Settings under a heading nobody reads. Quiet, once the threshold is passed,
 * and dismissible for a fortnight — a nag that cannot be silenced gets ignored
 * permanently, which is worse than one that can.
 */
const SNOOZE_KEY = 'wn.backup.snoozed';
const SNOOZE_DAYS = 14;

function snoozedUntil() {
  try {
    return parseInt(localStorage.getItem(SNOOZE_KEY) || '0', 10) || 0;
  } catch {
    return 0;
  }
}

function backupNudge() {
  if (!shouldNudgeBackup(store.stats())) return null;
  if (Date.now() < snoozedUntil()) return null;

  const box = el('section', {
    class: 'section',
    style:
      'margin:0 16px 8px;padding:14px;border:1px solid var(--amber-line);' +
      'background:var(--amber-dim);border-radius:var(--r-md)',
  });
  const n = store.stats().total;
  box.appendChild(
    el('div', {
      style: 'font-size:13px;line-height:1.5;margin-bottom:10px',
      text: `${n} titles live only on this phone. Browsers clear stored data after a long gap, and there is no copy anywhere else.`,
    })
  );

  const row = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' });
  row.appendChild(
    button('Export a copy', {
      kind: 'primary',
      size: 'sm',
      iconName: 'upload',
      onClick: () => {
        exportNow();
        render();
      },
    })
  );
  row.appendChild(
    button('Later', {
      kind: 'quiet',
      size: 'sm',
      onClick: () => {
        try {
          localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_DAYS * 24 * 3600 * 1000));
        } catch {
          /* storage refused; the prompt simply returns next render */
        }
        render();
      },
    })
  );
  box.appendChild(row);
  return box;
}

/** The same export Settings performs, reachable from where the prompt is. */
function exportNow() {
  const payload = store.exportPayload();
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: `watchnext-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  markBackedUp();
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
  const bits = [`${s.total} titles`, `${s.watched} watched`, `${s.pctWatched}% through`];
  if (s.hoursWatched) bits.push(`${s.hoursWatched} hours`);
  /* A button rather than a caption. These numbers were already the most-read
     thing on the screen and led nowhere. */
  return el('div', {
    class: 'section',
    style: 'padding:28px 16px 0;text-align:center',
  }, el('button', {
    type: 'button',
    style: 'font-size:13px;color:var(--ash);padding:6px 10px;border-radius:8px',
    text: bits.join('  ·  '),
    'aria-label': 'See your shelf in full',
    onclick: () => navigate('stats'),
  }));
}

function cssUrl(u) {
  return String(u).replace(/["'()\\\s]/g, (c) => '\\' + c);
}

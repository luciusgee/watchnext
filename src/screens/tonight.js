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
import { runtime, commitment, relativeTime, rating, plural, fallbackColors } from '../format.js';
import { tonightPick, alternates } from '../recommend.js';
import { openDetail } from './detail.js';
import { openPickSheet } from './pick.js';
import { shouldNudgeBackup, markBackedUp } from '../durability.js';
import * as sync from '../sync.js';
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
  /* Every mutation on this screen rebuilds it, which used to rewind all three
     rails to the left edge — including when the mutation came from behind the
     detail overlay, so they had silently reset by the time it was closed. */
  const railScroll = [...body.querySelectorAll('.rail')].map((r) => r.scrollLeft);
  clear(body);

  const items = store.items();
  if (!items.length) {
    body.appendChild(
      emptyState({
        iconName: 'library',
        title: 'Your library is empty',
        message: 'Add the films and series you own, and this screen will tell you what to watch.',
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
        /* Matched to the primary above it — same height, same radius, same
           type size — and spaced off the scale rather than with a negative
           margin fighting emptyState's own. The `quiet` kind carries the
           hierarchy on its own. */
        { style: 'display:flex;justify-content:center;margin-top:var(--s3)' },
        button('Or try a sample library', {
          kind: 'quiet',
          onClick: () => {
            const n = store.loadSample(seedLibrary);
            toast(n ? `Added ${n} titles to try. Remove any you don’t want.` : 'Nothing to add');
            /* loadSample emits 'item'; the subscriber above renders. */
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
    /* Only when there is a pick to be an alternative to. Offering "find
       something else" directly under "nothing left to suggest" pointed at the
       same exhausted set. */
    body.appendChild(pickerCta());
  } else {
    body.appendChild(
      emptyState({
        iconName: 'check',
        title: 'Nothing left to suggest',
        message: ownedOnly
          ? 'You’ve watched everything you own. The button below brings in the rest.'
          : 'You’ve watched everything. Genuinely impressive.',
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

  body.querySelectorAll('.rail').forEach((r, i) => {
    if (railScroll[i]) r.scrollLeft = railScroll[i];
  });
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
  /* Same structure as rail(), so this section cannot drift off the 24/12
     rhythm the three beside it keep. */
  const wrap = el('section', { class: 'section' });
  wrap.appendChild(
    el('div', { class: 'section-head' }, el('h2', { class: 'eyebrow', text: 'Watching' }))
  );

  const row = el('div', { style: 'display:flex;flex-wrap:wrap;gap:var(--s2);padding:0 var(--s4)' });
  for (const p of list) {
    const active = p.id === current;
    row.appendChild(
      el('button', {
        class: 'pill',
        type: 'button',
        'data-haptic': true,
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

  /* Always a wash — its detail screen gets one without a poster, and a
     posterless pick sat on flat black here. */
  const fb = fallbackColors(item.title);
  wrap.appendChild(
    el('div', {
      class: 'hero-bg',
      style: item.poster
        ? `background-image:url("${cssUrl(item.poster)}")`
        : `background-image:linear-gradient(160deg, ${fb.a}, ${fb.b});filter:none;opacity:0.5`,
    })
  );
  wrap.appendChild(el('div', { class: 'hero-veil' }));

  const inner = el('div', { class: 'hero-in' });

  const posterBtn = el('button', {
    class: 'card',
    type: 'button',
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
      haptic: true,
      onClick: () => {
        /* setWatched emits 'item'; the subscriber renders. Calling render()
           here as well rebuilt ~60 poster nodes and the blurred hero twice. */
        actions.setWatched(item.uid, true);
      },
    })
  );
  /* "Something else" used to be a third small button in this row, which is
     where it went to die: a quiet 15px control wedged beside two others, on a
     dark poster, doing the single most-wanted thing on the screen. It is now
     the full-width button underneath — see pickerCta. */
  copy.appendChild(acts);

  inner.appendChild(copy);
  wrap.appendChild(inner);

  /* the premise toggle, stated plainly and quietly */
  const ownedCount = store.items().filter((i) => i.owned).length;
  if (ownedCount) {
    const scope = el('div', { class: 'hero-scope' });
    const toggle = el('button', {
      type: 'button',
      'data-haptic': true,
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
 * The other question this screen has to answer.
 *
 * Tonight makes one confident suggestion, which is right about as often as any
 * recommendation is. The rest of the time the honest response is "no, but I
 * know roughly what I want", and that needs somewhere obvious to go — right
 * under the pick it is an alternative to, at full width, rather than as the
 * third of three small buttons on top of a poster.
 *
 * It opens the sheet, not the deck. Going straight to a hand dealt from
 * whatever filters happened to be set last time is how you end up swiping
 * through the answer to a question you asked on Tuesday.
 */
function pickerCta() {
  return el(
    'section',
    { class: 'section', style: 'padding:4px 16px 0' },
    button('Find something else', {
      kind: 'secondary',
      iconName: 'sparkle',
      block: true,
      onClick: () => openPickSheet(),
    })
  );
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
  /* With sync on, every change is already a commit in the repo, and "no copy
     anywhere else" was false — and alarming — on both phones. */
  if (sync.config().enabled && sync.status().phase !== 'error') return null;
  if (!shouldNudgeBackup(store.stats())) return null;
  if (Date.now() < snoozedUntil()) return null;

  /* The app already has an amber warning notice — .banner / .banner-warn, used
     by the detail screen. This used to rebuild the same thing inline with
     different padding, a different background and no leading glyph, so the two
     screens appeared to come from different apps. */
  const box = el('div', { class: 'banner banner-warn' });
  box.appendChild(el('span', { html: icon('warning', 18) }).firstChild);
  const inner = el('div', { style: 'flex:1;min-width:0' });
  const n = store.stats().total;
  inner.appendChild(
    el('div', {
      style: 'font-size:var(--t-sub);line-height:1.5',
      text: `${n} titles live only on this phone. Browsers clear stored data after a long gap, and there is no copy anywhere else.`,
    })
  );

  const row = el('div', { style: 'display:flex;gap:var(--s2);flex-wrap:wrap;margin-top:10px' });
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
  inner.appendChild(row);
  box.appendChild(inner);
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
  toast('Exported');
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
  /* display:contents keeps the flex and scroll-snap layout of .card exactly as
     it was while giving the list its items. */
  for (const item of items) {
    list.appendChild(el('div', { role: 'listitem', style: 'display:contents' }, cardFor(item)));
  }
  sec.appendChild(list);
  return sec;
}

export function cardFor(item) {
  /* No role="listitem" here. An explicit role replaces the implicit one, so
     VoiceOver announced the poster as a list item and never said "button" —
     and the same card renders into the library grid, which has no list
     ancestor at all, making those orphan listitems. rail() wraps instead. */
  const card = el('button', {
    class: 'card',
    type: 'button',
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
  const bits = [plural(s.total, 'title'), `${s.watched} watched`, `${s.pctWatched}% through`];
  if (s.hoursWatched) bits.push(plural(s.hoursWatched, 'hour'));
  /* A button rather than a caption. These numbers were already the most-read
     thing on the screen and led nowhere — but nothing about them said so, so
     .statline gives it a real target, a press state and a chevron. The
     separator uses en-spaces: the doubled ASCII spaces that were here collapse
     to one the moment they reach textContent. */
  const btn = el('button', {
    class: 'statline',
    type: 'button',
    'aria-label': 'See your shelf in full',
    onclick: () => navigate('stats'),
  });
  /* The last figure and the chevron are welded together, so a wrap can never
     leave the chevron on a line of its own. */
  const label = el('span', { text: bits.slice(0, -1).join(' · ') + ' · ' });
  const tail = el('span', { style: 'white-space:nowrap', text: bits[bits.length - 1] });
  tail.appendChild(el('span', { html: icon('chevronRight', 13) }).firstChild);
  label.appendChild(tail);
  btn.appendChild(label);
  return el('div', { class: 'section', style: 'padding:28px 16px 0;text-align:center' }, btn);
}

function cssUrl(u) {
  return String(u).replace(/["'()\\\s]/g, (c) => '\\' + c);
}

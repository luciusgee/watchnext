/*
 * Feed — one film per screen, scrolled like a reel.
 *
 * The scroll snaps and stops on every card (scroll-snap-stop: always), so a
 * flick is one film, never a blur of ten. Each card is a film you do not
 * already have. On the right: Spotlight it for the two of you, add it to the
 * list, talk about it, watch the trailer. Double-tap the poster to Spotlight.
 *
 * Cards are cheap until they are near the screen: a list page gives title,
 * poster and synopsis for twenty at once, and the rest — running time,
 * director, cast, certificate, trailer — is fetched for the card on screen
 * and the two after it. Posters load two ahead and are let go of well behind,
 * so an hour of scrolling does not hold an hour of images.
 */

import * as store from '../store.js';
import * as meta from '../metadata.js';
import * as actions from '../actions.js';
import { el, clear, toast, emptyState } from '../ui.js';
import { icon } from '../icons.js';
import { plural, releaseLabel } from '../format.js';
import { FILTERS, createFeed, detailsFor, cached, markSeen, nudge, forgetDetails } from '../feed.js';
import { openThread } from './thread.js';
import * as sync from '../sync.js';

const FILTER_KEY = 'wn.feed.filter';
const AHEAD = 2; // posters loaded ahead of the card on screen
const KEEP = 5; // cards either side that keep their poster

let root = null;
let scrollEl = null;
let barEl = null;
let filtersEl = null;
let navigate = null;
let observer = null;

let filterId = 'foryou';
let feed = null;
let feedKey = '';
let films = [];
let cards = [];
let current = -1;
let enteredAt = 0;
let loading = false;
let ended = false;
let controller = null;
let errBox = null; // the one "did not load" card, if showing
/* When this feed was last looked at, by the wall clock: an iPhone keeps the
   app alive in the background for days, and a feed built on Monday is not
   what is new on Friday. Away longer than this, it starts again from what
   is new now. */
let lastSeenAt = 0;
const STALE_MS = 2 * 3600e3;
const stale = () => !!feed && Date.now() - lastSeenAt >= STALE_MS;

try {
  filterId = localStorage.getItem(FILTER_KEY) || 'foryou';
} catch {
  /* private mode: start on For you */
}

const tmdbKey = () => store.settings().dataKeys?.tmdb || '';
const isActive = () => root?.classList.contains('is-active');

export function initFeed({ navigate: nav }) {
  navigate = nav;
  root = document.getElementById('screen-feed');
  scrollEl = root.querySelector('[data-region="scroll"]');
  barEl = root.querySelector('[data-region="bar"]');
  filtersEl = root.querySelector('[data-region="filters"]');
  observer = new IntersectionObserver(onIntersect, { root: scrollEl, threshold: 0.6 });
  scrollEl.addEventListener('click', onClick);
  filtersEl.addEventListener('scroll', paintEdge, { passive: true });
  store.subscribe((reason) => {
    if (reason === 'item' && isActive()) paintActions();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (isActive() && feed) lastSeenAt = Date.now();
      return;
    }
    /* Time away is not time spent looking at the card. */
    enteredAt = performance.now();
    if (isActive() && tmdbKey() && stale() && !document.querySelector('.thread-sheet, .detail.is-open')) reset();
  });
  window.addEventListener('online', () => {
    if (errBox && isActive()) load();
  });
}

/** Returns 'fresh' when it started the feed again, so the scroll position
    remembered for the old one is not put back on the new one. */
export function showFeed() {
  paintFilters();
  const key = tmdbKey();
  if (!key) {
    feed = null;
    feedKey = '';
    paintNoKey();
    return 'fresh';
  }
  if (!feed || feedKey !== key || stale()) {
    reset();
    return 'fresh';
  }
  paintActions();
  return null;
}

/**
 * The Feed tab, or the pill already chosen, tapped again: down the feed, it
 * goes back to the top; at the top, it checks for what is new.
 */
export function retapFeed() {
  if (!feed) return;
  if (scrollEl.scrollTop > 4) {
    scrollEl.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    return;
  }
  reset();
}

/* ── filters ── */

/* Built once and kept: rebuilding them every time the tab was shown threw
   away a swipe in progress and where the row had been scrolled to. */
function paintFilters() {
  if (!FILTERS.some((f) => f.id === filterId)) filterId = 'foryou';
  if (!filtersEl.children.length) {
    for (const f of FILTERS) {
      const b = el('button', {
        class: 'feed-filter',
        type: 'button',
        'data-filter': f.id,
        'aria-pressed': 'false',
        text: f.label,
        onclick: () => {
          if (f.id === filterId) {
            retapFeed();
            return;
          }
          filterId = f.id;
          try {
            localStorage.setItem(FILTER_KEY, filterId);
          } catch {
            /* remembered for this session only */
          }
          syncFilters();
          centre(b, true);
          reset();
        },
      });
      filtersEl.appendChild(b);
    }
    requestAnimationFrame(() => {
      centre(filtersEl.querySelector('[aria-pressed="true"]'), false);
      paintEdge();
    });
  }
  syncFilters();
}

function syncFilters() {
  for (const b of filtersEl.children) b.setAttribute('aria-pressed', String(b.dataset.filter === filterId));
}

/* The chosen pill into the middle of the row — by scrolling the row alone.
   scrollIntoView would scroll every scroller above it too, the feed
   included. */
function centre(b, smooth) {
  if (!b) return;
  const row = filtersEl.getBoundingClientRect();
  const r = b.getBoundingClientRect();
  const left = Math.max(0, filtersEl.scrollLeft + (r.left - row.left) - (row.width - r.width) / 2);
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  filtersEl.scrollTo({ left, behavior: smooth && !calm ? 'smooth' : 'auto' });
}

/* The fade at the right edge says there are more pills; at the end of the
   row there are not. */
function paintEdge() {
  barEl.classList.toggle('at-end', filtersEl.scrollLeft + filtersEl.clientWidth >= filtersEl.scrollWidth - 2);
}

/* Everything in the scroller but the pill bar. */
function clearCards() {
  for (const n of [...scrollEl.children]) if (n !== barEl) n.remove();
}

function paintNoKey() {
  clearCards();
  const box = el('div', { class: 'feed-card feed-note' });
  box.appendChild(
    emptyState({
      iconName: 'feed',
      title: 'The feed needs a TMDB key',
      message: 'It is where the films, posters and cast come from. The key is free, and it goes in Settings → Connections.',
      action: { label: 'Open Settings', haptic: true, onClick: () => navigate('settings', { focus: 'data' }) },
    })
  );
  scrollEl.appendChild(box);
}

/* ── the feed itself ── */

function reset() {
  controller?.abort();
  controller = new AbortController();
  feedKey = tmdbKey();
  forgetDetails();
  lastSeenAt = Date.now();
  feed = createFeed(filterId, { key: feedKey, signal: controller.signal });
  films = [];
  cards.forEach((c) => observer.unobserve(c));
  cards = [];
  current = -1;
  ended = false;
  loading = false;
  errBox = null;
  clearCards();
  scrollEl.scrollTop = 0;
  load();
}

async function load() {
  if (loading || ended || !feed) return;
  loading = true;
  const mine = feed;
  /* A retry — by the button or by scrolling on — takes the last failure's
     card away, so it never ends up stranded between films. */
  errBox?.remove();
  errBox = null;
  let again = false;
  const spinner = cards.length ? null : el('div', { class: 'feed-card feed-note', html: '<div class="feed-loading" aria-label="Loading"></div>' });
  if (spinner) scrollEl.appendChild(spinner);
  try {
    const batch = await mine.more();
    if (mine !== feed) return;
    spinner?.remove();
    if (!batch.length) {
      ended = true;
      scrollEl.appendChild(endCard());
      return;
    }
    for (const film of batch) addCard(film);
    if (current < 0) setCurrent(0);
    /* A short batch — one film, say — leaves nothing below to scroll to, and
       it is scrolling near the end that asks for more. Ask now instead. */
    again = current >= films.length - 5;
  } catch (err) {
    if (mine !== feed || err?.name === 'AbortError') return;
    spinner?.remove();
    errBox = errorCard(err);
    scrollEl.appendChild(errBox);
  } finally {
    if (mine === feed) loading = false;
  }
  if (again && mine === feed) load();
}

function endCard() {
  const box = el('div', { class: 'feed-card feed-note' });
  box.appendChild(
    emptyState({
      iconName: 'check',
      title: 'That is everything here',
      message: 'You have been through every film under this filter. Try another one at the top, or look again later.',
      action: { label: 'Check for new films', haptic: true, onClick: () => reset() },
    })
  );
  return box;
}

function errorCard(err) {
  const box = el('div', { class: 'feed-card feed-note' });
  box.appendChild(
    emptyState({
      iconName: 'warning',
      title: err?.code === 'auth' ? 'TMDB turned the key down' : 'The films did not load',
      message:
        err?.code === 'auth'
          ? 'Check the key in Settings → Connections.'
          : navigator.onLine === false
            ? 'You are offline. They will be here when you are back.'
            : 'Something went wrong asking TMDB. Try again.',
      action: {
        label: 'Try again',
        haptic: true,
        onClick: () => load(),
      },
    })
  );
  return box;
}

/* ── cards ── */

function addCard(film) {
  const i = films.length;
  films.push(film);
  const card = el('article', { class: 'feed-card', 'data-i': String(i), 'aria-label': film.title });

  const art = el('div', { class: 'feed-art' });
  const img = el('img', { alt: '', decoding: 'async', draggable: 'false' });
  img.dataset.src = film.poster;
  art.appendChild(img);
  card.appendChild(art);

  const body = el('div', { class: 'feed-body' });
  const meta = el('div', { class: 'feed-meta' });
  paintMeta(meta, film, null);
  body.appendChild(meta);
  body.appendChild(el('h2', { class: 'feed-title', text: film.title }));
  body.appendChild(el('div', { class: 'feed-tagline' }));
  body.appendChild(el('div', { class: 'feed-genres', text: film.genres.slice(0, 3).join(' · ') }));
  body.appendChild(el('p', { class: 'feed-overview selectable', text: film.overview || 'No synopsis yet.' }));
  body.appendChild(el('div', { class: 'feed-credits' }));
  card.appendChild(body);

  const rail = el('div', { class: 'feed-rail' });
  rail.appendChild(act('spotlight', 'star', 'Spotlight'));
  rail.appendChild(act('add', 'plus', 'Add'));
  rail.appendChild(act('comment', 'comment', 'Comment'));
  const trailer = act('trailer', 'playFill', 'Trailer');
  trailer.hidden = true;
  rail.appendChild(trailer);
  card.appendChild(rail);

  scrollEl.appendChild(card);
  cards.push(card);
  observer.observe(card);
  const d = cached(film);
  if (d) paintDetails(i, d);
}

function act(name, iconName, label) {
  const b = el('button', { class: 'feed-act', type: 'button', 'data-act': name, 'aria-label': label });
  b.appendChild(el('span', { class: 'feed-act-icon', html: icon(iconName, 26) }));
  b.appendChild(el('span', { class: 'feed-act-label', text: label }));
  return b;
}

const hm = (m) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`);

/* Coming or just out, said first, in amber: "In cinemas Fri 14 Nov". From
   the list's date until the details bring the UK ones. The year is left off
   then — the date has said it. */
function paintMeta(node, film, d) {
  clear(node);
  const r = d?.release || {};
  const when = releaseLabel({
    cinema: r.cinema || (film.dateKind === 'cinema' ? film.date : null),
    digital: r.digital || null,
    fallback: film.date,
  });
  if (when) node.appendChild(el('span', { class: 'feed-when', text: when }));
  const rest = metaLine(film, d, { year: !when });
  if (rest) node.appendChild(document.createTextNode(`${when ? '  ·  ' : ''}${rest}`));
}

function metaLine(film, d, { year = true } = {}) {
  const bits = [];
  if (film.year && year) bits.push(String(film.year));
  if (film.type === 'tv') bits.push(d?.seasons ? plural(d.seasons, 'season') : 'Series');
  else if (d?.runtime) bits.push(hm(d.runtime));
  if (d?.certificate) bits.push(d.certificate);
  if (film.rating) bits.push(`★ ${film.rating.toFixed(1)}`);
  return bits.join('  ·  ');
}

function paintDetails(i, d) {
  const card = cards[i];
  const film = films[i];
  if (!card || !d) return;
  paintMeta(card.querySelector('.feed-meta'), film, d);
  card.querySelector('.feed-tagline').textContent = d.tagline || '';
  if (d.genres?.length) card.querySelector('.feed-genres').textContent = d.genres.slice(0, 3).join(' · ');
  const credits = card.querySelector('.feed-credits');
  clear(credits);
  const bits = [];
  if (d.makers.length) bits.push(`${film.type === 'tv' ? 'Created by' : 'Directed by'} ${d.makers.join(' & ')}`);
  if (d.cast.length) bits.push(`Starring ${d.cast.join(', ')}`);
  credits.appendChild(el('span', { text: bits.join('  ·  ') }));
  if (d.imdbId) {
    credits.appendChild(
      el('a', {
        class: 'feed-imdb',
        href: `https://www.imdb.com/title/${d.imdbId}/`,
        target: '_blank',
        rel: 'noopener noreferrer',
        text: 'IMDb',
      })
    );
  }
  card.querySelector('[data-act="trailer"]').hidden = !d.trailer;
}

/* ── which card is on screen ── */

function onIntersect(entries) {
  for (const e of entries) {
    if (e.isIntersecting && e.intersectionRatio >= 0.6) setCurrent(Number(e.target.dataset.i));
  }
}

function setCurrent(i) {
  if (i === current || !films[i]) return;
  /* How long the last one held you is the quietest signal there is: a flick
     past is a small no, a long look a small yes. Only for a move on to the
     next card — going back to the top passes every card at speed, and is
     not thirty small noes. */
  const prev = i === current + 1 ? films[current] : null;
  if (prev) {
    const dwell = performance.now() - enteredAt;
    if (dwell < 1200) nudge(prev, -0.25);
    else if (dwell > 7000) nudge(prev, 0.25);
  }
  current = i;
  enteredAt = performance.now();
  lastSeenAt = Date.now();
  markSeen(films[i]);

  cards.forEach((card, j) => {
    const img = card.querySelector('.feed-art img');
    if (!img) return;
    if (j >= i - 1 && j <= i + AHEAD) {
      if (!img.getAttribute('src') && img.dataset.src) img.src = img.dataset.src;
    } else if (Math.abs(j - i) > KEEP && img.getAttribute('src')) {
      img.removeAttribute('src');
    }
  });

  for (let j = i; j <= i + AHEAD && j < films.length; j++) {
    const film = films[j];
    if (cached(film)) {
      paintDetails(j, cached(film));
      continue;
    }
    detailsFor(film, { key: feedKey, signal: controller?.signal })
      .then((d) => {
        if (films[j] === film) paintDetails(j, d);
      })
      .catch(() => {
        /* the card still has what the list gave it */
      });
  }
  paintActions();
  if (i >= films.length - 5) load();
}

/* ── the library, as seen from a card ── */

function itemFor(film) {
  const d = cached(film);
  return (
    store.items().find(
      (i) =>
        (String(i.meta?.sourceId || '') === String(film.id) && i.type === film.type) ||
        (d?.imdbId && i.imdbId === d.imdbId)
    ) || store.findDuplicate(film.title, film.year, film.type)
  );
}

/* Spotlight, a comment and Add all need the film on the shelf. It goes on as
   something to watch — not owned, not watched — with everything the card
   already knows, and the details TMDB gave for it. */
async function ensureItem(film) {
  const held = itemFor(film);
  if (held) return held;
  let d = cached(film);
  if (!d) {
    try {
      d = await detailsFor(film, { key: feedKey });
    } catch {
      d = null;
    }
  }
  const held2 = itemFor(film);
  if (held2) return held2;
  const rec = d?.record || null;
  const { item } = actions.addItem({
    title: rec?.title || film.title,
    year: rec?.year || film.year,
    type: film.type,
    poster: rec?.poster || film.poster,
    imdbId: rec?.imdbId || d?.imdbId || null,
    overview: rec?.overview || film.overview,
    owned: false,
    /* Coming soon: Tonight leaves it alone until it can be watched. */
    released: d?.release?.digital || d?.release?.cinema || film.date || null,
    locked: ['title', 'year'],
    meta: {
      v: meta.META_VERSION,
      status: 'matched',
      at: null,
      confidence: 1,
      source: 'user',
      sourceId: String(film.id),
    },
  });
  if (rec) {
    const patch = meta.toPatch(item, rec, 1, 'tmdb', { chosen: true });
    patch.meta = { ...patch.meta, source: 'user', chosenAt: Date.now() };
    store.update(item.uid, patch);
  }
  store.saveNow();
  return store.byUid(item.uid) || item;
}

function paintActions() {
  for (let j = Math.max(0, current - 3); j <= current + 3 && j < cards.length; j++) {
    const card = cards[j];
    const item = itemFor(films[j]);
    const star = card.querySelector('[data-act="spotlight"]');
    const on = !!item?.spotlight;
    star.classList.toggle('is-on', on);
    star.setAttribute('aria-pressed', String(on));
    star.querySelector('.feed-act-icon').innerHTML = icon(on ? 'starFill' : 'star', 26);
    const add = card.querySelector('[data-act="add"]');
    add.classList.toggle('is-on', !!item);
    add.querySelector('.feed-act-icon').innerHTML = icon(item ? 'check' : 'plus', 26);
    add.querySelector('.feed-act-label').textContent = item ? 'In list' : 'Add';
    const count = item ? store.notesFor(item).length : 0;
    const unread = item ? store.unreadFor(item) : 0;
    const comment = card.querySelector('[data-act="comment"]');
    comment.querySelector('.feed-act-label').textContent = count ? String(count) : 'Comment';
    comment.classList.toggle('has-unread', unread > 0);
  }
}

/* ── taps ── */

let lastTap = { t: 0, x: 0, y: 0 };

async function onClick(e) {
  const btn = e.target.closest('[data-act]');
  const card = e.target.closest('.feed-card[data-i]');
  if (!card) return;
  const i = Number(card.dataset.i);
  const film = films[i];
  if (!film) return;

  if (btn) {
    const what = btn.dataset.act;
    if (what === 'trailer') {
      const d = cached(film);
      if (d?.trailer) window.open(d.trailer, '_blank', 'noopener,noreferrer');
      return;
    }
    if (what === 'spotlight') return toggleSpotlight(film, i);
    if (what === 'add') return toggleAdd(film, i);
    if (what === 'comment') {
      /* Talking about a film puts it on the list (and in Spotlight) — but only
         once something is said. Opened and closed with nothing written, the
         film goes back off. */
      const created = !itemFor(film);
      const item = await ensureItem(film);
      store.emit('item');
      openThread(item.uid, {
        onClose: () => {
          const now = store.byUid(item.uid);
          if (created && now && !now.spotlight && !store.notesFor(now).length) {
            store.remove(now.uid);
            store.saveNow();
            store.emit('item');
          }
          paintActions();
        },
      });
      return;
    }
    return;
  }

  if (e.target.closest('.feed-overview')) {
    e.target.closest('.feed-overview').classList.toggle('is-open');
    return;
  }
  if (e.target.closest('a')) return;

  /* Double-tap the poster: Spotlight, the way a double-tap likes a reel. */
  const now = performance.now();
  if (now - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
    lastTap = { t: 0, x: 0, y: 0 };
    burst(card, e);
    const item = itemFor(film);
    if (!item?.spotlight) toggleSpotlight(film, i);
    return;
  }
  lastTap = { t: now, x: e.clientX, y: e.clientY };
}

async function toggleSpotlight(film, i) {
  const item = await ensureItem(film);
  const on = !item.spotlight;
  store.setSpotlight(item.uid, on);
  store.emit('item');
  if (on) {
    nudge(film, 1.5);
    toast(`${item.title} is in Spotlight`);
    /* Up now: the other phone hears of it when it reaches the repo. */
    sync.pushSoon();
  }
  paintActions();
}

async function toggleAdd(film, i) {
  const held = itemFor(film);
  if (held) {
    toast(`${held.title} is in your list`, {
      action: 'Remove',
      onAction: () => {
        store.remove(held.uid);
        store.saveNow();
        store.emit('item');
        paintActions();
      },
    });
    return;
  }
  const item = await ensureItem(film);
  store.emit('item');
  nudge(film, 1);
  toast(`Added ${item.title} to your list`, {
    action: 'Undo',
    onAction: () => {
      store.remove(item.uid);
      store.saveNow();
      store.emit('item');
      paintActions();
    },
  });
  paintActions();
}

function burst(card, e) {
  const r = card.getBoundingClientRect();
  const star = el('div', { class: 'feed-burst', html: icon('starFill', 96) });
  star.style.left = `${e.clientX - r.left}px`;
  star.style.top = `${e.clientY - r.top}px`;
  card.appendChild(star);
  star.addEventListener('animationend', () => star.remove(), { once: true });
  setTimeout(() => star.remove(), 1200);
}

/* For tests: which film is on screen. */
export function feedState() {
  return { filter: filterId, current, count: films.length, film: films[current] || null };
}

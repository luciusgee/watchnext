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
import { plural } from '../format.js';
import { FILTERS, createFeed, detailsFor, cached, markSeen, nudge } from '../feed.js';
import { openThread } from './thread.js';

const FILTER_KEY = 'wn.feed.filter';
const AHEAD = 2; // posters loaded ahead of the card on screen
const KEEP = 5; // cards either side that keep their poster

let root = null;
let scrollEl = null;
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
  filtersEl = root.querySelector('[data-region="filters"]');
  observer = new IntersectionObserver(onIntersect, { root: scrollEl, threshold: 0.6 });
  scrollEl.addEventListener('click', onClick);
  store.subscribe((reason) => {
    if (reason === 'item' && isActive()) paintActions();
  });
}

export function showFeed() {
  paintFilters();
  const key = tmdbKey();
  if (!key) {
    feed = null;
    feedKey = '';
    paintNoKey();
    return;
  }
  if (!feed || feedKey !== key) reset();
  else paintActions();
}

/* ── filters ── */

function paintFilters() {
  clear(filtersEl);
  for (const f of FILTERS) {
    const b = el('button', {
      class: 'feed-filter',
      type: 'button',
      'aria-pressed': String(f.id === filterId),
      text: f.label,
      onclick: () => {
        if (f.id === filterId) {
          scrollEl.scrollTo({ top: 0, behavior: 'smooth' });
          return;
        }
        filterId = f.id;
        try {
          localStorage.setItem(FILTER_KEY, filterId);
        } catch {
          /* remembered for this session only */
        }
        for (const other of filtersEl.children) other.setAttribute('aria-pressed', String(other === b));
        b.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
        reset();
      },
    });
    filtersEl.appendChild(b);
  }
  requestAnimationFrame(() =>
    filtersEl.querySelector('[aria-pressed="true"]')?.scrollIntoView({ inline: 'center', block: 'nearest' })
  );
}

function paintNoKey() {
  clear(scrollEl);
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
  feed = createFeed(filterId, { key: feedKey, signal: controller.signal });
  films = [];
  cards.forEach((c) => observer.unobserve(c));
  cards = [];
  current = -1;
  ended = false;
  loading = false;
  clear(scrollEl);
  scrollEl.scrollTop = 0;
  load();
}

async function load() {
  if (loading || ended || !feed) return;
  loading = true;
  const mine = feed;
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
  } catch (err) {
    if (mine !== feed || err?.name === 'AbortError') return;
    spinner?.remove();
    scrollEl.appendChild(errorCard(err));
  } finally {
    if (mine === feed) loading = false;
  }
}

function endCard() {
  const box = el('div', { class: 'feed-card feed-note' });
  box.appendChild(
    emptyState({
      iconName: 'check',
      title: 'That is everything here',
      message: 'You have been through every film under this filter. Try another one at the top.',
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
        onClick: () => {
          box.remove();
          load();
        },
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
  body.appendChild(el('div', { class: 'feed-meta', text: metaLine(film, null) }));
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

function metaLine(film, d) {
  const bits = [];
  if (film.year) bits.push(String(film.year));
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
  card.querySelector('.feed-meta').textContent = metaLine(film, d);
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
     past is a small no, a long look a small yes. */
  const prev = films[current];
  if (prev) {
    const dwell = performance.now() - enteredAt;
    if (dwell < 1200) nudge(prev, -0.25);
    else if (dwell > 7000) nudge(prev, 0.25);
  }
  current = i;
  enteredAt = performance.now();
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
      const item = await ensureItem(film);
      store.emit('item');
      openThread(item.uid, { onClose: paintActions });
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

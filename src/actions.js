/*
 * Mutations. Every state change funnels through here so that activity
 * logging, undo and re-render notification happen in exactly one place.
 */

import * as store from './store.js';
import { toast } from './ui.js';

/** Snapshot only the fields an action touches, so undo is precise. */
function snapshot(item, fields) {
  const out = {};
  for (const f of fields) out[f] = item[f];
  return out;
}

export function setWatched(uid, watched, { silent = false } = {}) {
  const item = store.byUid(uid);
  if (!item) return null;
  const prev = snapshot(item, ['watched', 'watchedAt', 'saved', 'seen', 'seenAt']);

  const patch = {
    watched,
    watchedAt: watched ? Date.now() : null,
  };
  /* Marking something watched retires it from the watchlist — leaving it in
     both places was a persistent annoyance in the old version. */
  if (watched) {
    patch.saved = false;
    patch.seen = true;
    patch.seenAt = item.seenAt || Date.now();
  }

  const next = store.update(uid, patch);
  store.logActivity(watched ? 'watched' : 'unwatched', item, prev);
  store.emit('item');

  if (!silent) {
    toast(watched ? `Marked ${item.title} as watched` : `Moved ${item.title} back to unwatched`, {
      action: 'Undo',
      onAction: () => {
        store.update(uid, prev);
        store.emit('item');
      },
    });
  }
  return next;
}

export function setSaved(uid, saved, { silent = false } = {}) {
  const item = store.byUid(uid);
  if (!item) return null;
  const prev = snapshot(item, ['saved', 'saved_at']);

  const next = store.update(uid, { saved, saved_at: saved ? Date.now() : null });
  store.logActivity(saved ? 'saved' : 'unsaved', item, prev);
  store.emit('item');

  if (!silent) {
    toast(saved ? `Added ${item.title} to your watchlist` : `Removed ${item.title} from your watchlist`, {
      action: 'Undo',
      onAction: () => {
        store.update(uid, prev);
        store.emit('item');
      },
    });
  }
  return next;
}

export function setOwned(uid, owned) {
  const item = store.byUid(uid);
  if (!item) return null;
  const prev = snapshot(item, ['owned']);
  const next = store.update(uid, { owned });
  store.logActivity(owned ? 'owned' : 'unowned', item, prev);
  store.emit('item');
  toast(owned ? `${item.title} marked as in your collection` : `${item.title} removed from your collection`);
  return next;
}

export function setSeen(uid, seen) {
  const item = store.byUid(uid);
  if (!item) return null;
  store.update(uid, { seen, seenAt: seen ? Date.now() : null });
  store.emit('item');
}

export function removeItem(uid) {
  const item = store.byUid(uid);
  if (!item) return;
  const removed = store.remove(uid);
  store.emit('item');
  toast(`Removed ${item.title}`, {
    action: 'Undo',
    duration: 6000,
    onAction: () => {
      store.getState().items.push(removed);
      store.saveNow();
      store.emit('item');
    },
  });
}

export function addItem(fields) {
  const dupe = store.findDuplicate(fields.title, fields.year, fields.type);
  if (dupe) return { item: dupe, duplicate: true };
  const item = store.add({
    ...fields,
    /* Anything typed by hand is authoritative — enrichment must not
       silently rewrite it. */
    locked: fields.locked || [],
    meta: { v: 0, status: 'pending', at: null, confidence: null },
  });
  store.emit('item');
  return { item, duplicate: false };
}

/** Bulk add from pasted lines. Returns a report. */
export function addMany(lines, type) {
  const report = { added: [], duplicates: [], invalid: [] };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    /* Accept "Title (2016)" and "Title, 2016" as well as a bare title. */
    const m = line.match(/^(.*?)[\s,]*\((\d{4})\)\s*$/) || line.match(/^(.*?),\s*(\d{4})\s*$/);
    const title = (m ? m[1] : line).trim();
    const year = m ? parseInt(m[2], 10) : null;
    if (!title || title.length > 200) {
      report.invalid.push(line);
      continue;
    }
    const dupe = store.findDuplicate(title, year, type);
    if (dupe) {
      report.duplicates.push(title);
      continue;
    }
    const item = store.add({
      title,
      year,
      type,
      meta: { v: 0, status: 'pending', at: null, confidence: null },
    });
    report.added.push(item);
  }
  if (report.added.length) store.emit('item');
  return report;
}

/* ── bulk resets ── */

export function clearWatchlist() {
  let n = 0;
  store.bulk((i) => {
    if (i.saved) {
      n += 1;
      return { saved: false, saved_at: null };
    }
    return null;
  });
  store.emit('item');
  toast(n ? `Cleared ${n} from your watchlist` : 'Your watchlist was already empty');
}

export function clearWatched() {
  let n = 0;
  store.bulk((i) => {
    if (i.watched) {
      n += 1;
      return { watched: false, watchedAt: null };
    }
    return null;
  });
  store.emit('item');
  toast(n ? `Reset ${n} titles to unwatched` : 'Nothing was marked watched');
}

export function resetDiscover() {
  let n = 0;
  store.bulk((i) => {
    if (i.seen) {
      n += 1;
      return { seen: false, seenAt: null };
    }
    return null;
  });
  store.emit('item');
  toast(n ? `${n} titles will appear in Discover again` : 'Discover was already reset');
}

export function resetEverything() {
  store.bulk(() => ({
    watched: false,
    watchedAt: null,
    saved: false,
    saved_at: null,
    seen: false,
    seenAt: null,
  }));
  store.clearActivity();
  store.emit('item');
  toast('All watch activity cleared');
}

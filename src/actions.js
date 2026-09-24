/*
 * Mutations. Every state change funnels through here so that activity
 * logging, undo and re-render notification happen in exactly one place.
 */

import * as store from './store.js';
import { toast } from './ui.js';
import { cleanTitleLine, stripListMarkers, plural } from './format.js';

/** Snapshot only the fields an action touches, so undo is precise. */
function snapshot(item, fields) {
  const out = {};
  for (const f of fields) out[f] = item[f];
  return out;
}

export function setWatched(uid, watched, { silent = false } = {}) {
  const item = store.byUid(uid);
  if (!item) return null;
  const prev = snapshot(item, ['watched', 'watchedAt', 'seen', 'seenAt', 'watchedBy']);

  /* In a household this records who, not just that. store.setSeenBy keeps the
     shared `watched` flag as the OR of everyone's, so every filter, statistic
     and the scorer carry on reading the field they always read. */
  const person = store.viewer();
  if (person) {
    store.setSeenBy(uid, person, watched);
    if (watched) store.update(uid, { seen: true, seenAt: item.seenAt || Date.now() });
    store.logActivity(watched ? 'watched' : 'unwatched', item, prev);
    store.emit('item');
    if (!silent) {
      const who = store.people().find((p) => p.id === person)?.name || 'you';
      toast(watched ? `${item.title} — watched by ${who}` : `Unmarked for ${who}`, {
        action: 'Undo',
        onAction: () => {
          store.update(uid, prev);
          store.emit('item');
        },
      });
    }
    return store.byUid(uid);
  }

  const patch = {
    watched,
    watchedAt: watched ? Date.now() : null,
  };
  /* Watching something also retires it from the Discover deck. */
  if (watched) {
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
  /* Same hygiene as a pasted block: one title copied out of a list carries its
     bullet too, and a title is not the place to keep a stray tab. */
  fields = { ...fields, title: cleanTitleLine(fields.title) };
  const dupe = store.findDuplicate(fields.title, fields.year, fields.type);
  if (dupe) return { item: dupe, duplicate: true };
  const item = store.add({
    ...fields,
    /* Anything typed by hand is authoritative — enrichment must not
       silently rewrite it. */
    locked: fields.locked || [],
    /* A caller that already knows which record this is — search-to-add, where
       the user picked it off a list — says so, and that must survive. Hardcoding
       "pending" here meant a confirmed choice was downgraded on the way in and
       re-matched by the next sweep, which is how a hand-picked film silently
       becomes a different one. */
    meta: fields.meta || { v: 0, status: 'pending', at: null, confidence: null },
  });
  store.emit('item');
  return { item, duplicate: false };
}

/** Bulk add from pasted lines. Returns a report. */
export function addMany(lines, type) {
  const report = { added: [], duplicates: [], invalid: [] };
  /* Lists get pasted with their bullets attached. Strip them once, for the
     whole block, so "1." markers are judged against their neighbours. */
  for (const line of stripListMarkers(lines)) {
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

export function clearWatched() {
  let n = 0;
  store.bulk((i) => {
    /* watchedBy too. In a household, Tonight and the deck read who has seen
       what from it, so clearing only the shared flag changed nothing for
       either person — the same films stayed hidden, and the person pill kept
       its count straight after "every title will be marked unwatched". */
    const marked = i.watched || (i.watchedBy && Object.keys(i.watchedBy).length);
    if (!marked) return null;
    n += 1;
    return { watched: false, watchedAt: null, watchedBy: {} };
  });
  store.emit('item');
  toast(n ? `Reset ${plural(n, 'title')} to unwatched` : 'Nothing was marked watched');
}

export function resetDiscover() {
  let n = 0;
  store.bulk((i) => {
    if (i.seen) {
      /* Only what will actually come back: watched titles stay out of the deck,
         and counting them promised a number of cards that never appeared. */
      if (!i.watched) n += 1;
      return { seen: false, seenAt: null };
    }
    return null;
  });
  store.emit('item');
  toast(n ? `${plural(n, 'title')} will appear in Discover again` : 'Discover was already reset');
}

export function resetEverything() {
  store.bulk(() => ({
    watched: false,
    watchedAt: null,
    watchedBy: {},
    seen: false,
    seenAt: null,
    /* Retired with the watchlist. Nothing reads these any more, but "clear
       everything" should mean it, and they are still on every title saved
       before the collapse. */
    saved: false,
    saved_at: null,
  }));
  store.clearActivity();
  store.emit('item');
  toast('All watch activity cleared');
}

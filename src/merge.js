/*
 * Merging two copies of a library.
 *
 * Two phones, one shelf, no server to arbitrate. Whoever saves last must not
 * win the whole file — that is how one of you spends an evening adding films
 * and the other's next save quietly deletes them. So nothing merges at the
 * level of the library; everything merges at the level of a single title.
 *
 * Two facts make that possible, and the store had neither before this:
 *
 *  · `updatedAt` on every item. Without it, two versions of the same film are
 *    indistinguishable and the merge is guessing. With it, the newer edit wins
 *    and the older one loses only that one film.
 *  · Tombstones. A deleted film is not an absent film — absent is also what a
 *    film looks like on a phone that has not heard about it yet. Delete
 *    something on her phone, sync, and without a record of the deletion your
 *    copy hands it straight back. The record is the only difference between a
 *    delete and a gap.
 *
 * A tombstone is `{ uid, at }` and it beats any version of that item older
 * than it — and loses to any version newer, which is what makes re-adding a
 * film you deleted last month work rather than being silently undone.
 *
 * Deliberately last-write-wins per title, not a CRDT. Editing the same film on
 * two phones inside the same minute loses one of the two edits, and for a
 * household shelf that is an acceptable trade for something small enough to
 * read in one sitting. Adding different films — which is the actual use — is
 * always safe, because they never touch the same record.
 *
 * Pure: no store, no network, no browser. Its tests run in plain node.
 */

/* Long enough that a phone left in a drawer over a holiday still learns about
   a deletion; short enough that the file does not grow forever. */
export const TOMBSTONE_DAYS = 180;

function stamp(item) {
  return Number(item?.updatedAt ?? item?.addedAt ?? 0) || 0;
}

/**
 * Merge two `{ items, tombstones, people }` snapshots.
 *
 * Symmetric apart from ties: when two versions of a title carry the exact same
 * `updatedAt`, `mine` is kept, so a merge with no real changes is a no-op
 * rather than a write that ping-pongs between two devices forever.
 */
export function mergeLibraries(mine, theirs, now = Date.now()) {
  /* Defaulted rather than declared in the signature: a default only fires for
     `undefined`, and the interesting case here is `null` — which is exactly
     what "the file is not in the repo yet" looks like on a first run. */
  mine = mine || {};
  theirs = theirs || {};

  const items = new Map();
  for (const item of mine.items || []) {
    if (item?.uid) items.set(item.uid, item);
  }
  for (const item of theirs.items || []) {
    if (!item?.uid) continue;
    const held = items.get(item.uid);
    /* Strictly greater, so a tie keeps mine. */
    if (!held || stamp(item) > stamp(held)) items.set(item.uid, item);
  }

  const graves = new Map();
  for (const t of [...(mine.tombstones || []), ...(theirs.tombstones || [])]) {
    if (!t?.uid) continue;
    const at = Number(t.at) || 0;
    if (!graves.has(t.uid) || at > graves.get(t.uid)) graves.set(t.uid, at);
  }

  for (const [uid, at] of graves) {
    const item = items.get(uid);
    if (!item) continue;
    if (stamp(item) > at) {
      /* Added back after it was deleted. The item is the later fact, so the
         tombstone goes rather than the film. */
      graves.delete(uid);
    } else {
      items.delete(uid);
    }
  }

  /* Comments never change once written, so two copies of one are the same
     comment, and a union loses nothing. A deleted one has a tombstone like a
     deleted film, and a tombstone always wins: there is no later version of a
     comment that could mean it came back. */
  const notes = new Map();
  for (const n of [...(mine.notes || []), ...(theirs.notes || [])]) {
    if (n?.id && !notes.has(n.id)) notes.set(n.id, n);
  }
  for (const id of graves.keys()) notes.delete(id);

  /* A tombstone only has to outlive the slowest device. Past that it is just
     weight in a file both phones download. */
  const cutoff = now - TOMBSTONE_DAYS * 24 * 3600 * 1000;
  const tombstones = [...graves]
    .filter(([, at]) => at >= cutoff)
    .map(([uid, at]) => ({ uid, at }))
    .sort((a, b) => a.uid.localeCompare(b.uid));

  /* People carry no timestamps and are only ever added or removed wholesale,
     so this is a union by id. Names come from whoever has one — renaming a
     person on one phone is not worth a field on every record to arbitrate. */
  const people = new Map();
  for (const p of [...(mine.people || []), ...(theirs.people || [])]) {
    if (p?.id && !people.has(p.id)) people.set(p.id, p);
  }

  /* Last, so a film both phones added on their own is one film by the time
     either of them sees the result. */
  const out = collapseDuplicates(
    {
      items: [...items.values()].sort((a, b) => String(a.uid).localeCompare(String(b.uid))),
      tombstones,
      people: [...people.values()],
      notes: [...notes.values()].sort((a, b) => (a.at || 0) - (b.at || 0) || String(a.id).localeCompare(String(b.id))),
    },
    now
  );
  return {
    items: out.items,
    tombstones: [...out.tombstones].sort((a, b) => a.uid.localeCompare(b.uid)),
    people: out.people,
    notes: out.notes,
  };
}

/**
 * A stable string for "is this the same library?".
 *
 * Compared rather than deep-equalled because the answer decides whether to
 * spend a network write, and because two devices must agree on the answer —
 * so the ordering has to be canonical rather than whatever order the arrays
 * happen to be in. mergeLibraries already sorts; this does not assume it.
 */
export function fingerprint(snapshot = {}) {
  const items = [...(snapshot.items || [])]
    .filter((i) => i?.uid)
    .sort((a, b) => String(a.uid).localeCompare(String(b.uid)))
    .map((i) => `${i.uid}:${stamp(i)}`);
  const graves = [...(snapshot.tombstones || [])]
    .filter((t) => t?.uid)
    .sort((a, b) => String(a.uid).localeCompare(String(b.uid)))
    .map((t) => `${t.uid}:${Number(t.at) || 0}`);
  const people = [...(snapshot.people || [])]
    .filter((p) => p?.id)
    .map((p) => p.id)
    .sort();
  const notes = [...(snapshot.notes || [])]
    .filter((n) => n?.id)
    .map((n) => n.id)
    .sort();
  return JSON.stringify({ items, graves, people, notes });
}

/* ── duplicates ──
   One film, two records. A library brought across from the old app arrived
   with seven, and there are other ways in: a misspelt title ("Insendies")
   that the lookup then matches to the film already there, or both phones
   adding the same film before either has synced — two uids, so the merge
   above keeps both.

   Keyed on the IMDb id, but never on the id alone. The old app's matcher gave
   about a third of its titles the wrong id — one library had 28 Days Later
   and The Butterfly Effect sharing one — so two records are only the same
   film when the id agrees AND the titles are near enough to be one spelling
   of the same name AND the years do not disagree. A title comparison alone
   would merge remakes; the id alone would delete films. */

const plain = (t) =>
  String(t || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/^(the|a|an)\s+/, '')
    .replace(/[^a-z0-9]+/g, '');

/* Sørensen–Dice over letter pairs, as metadata.js scores matches — inlined
   because this module stays free of imports so its tests run in plain node.
   "Insendies" against "Incendies" is 0.75; unrelated titles sit near 0. */
function alike(a, b) {
  const x = plain(a);
  const y = plain(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length < 3 || y.length < 3) return false;
  const pairs = (w) => {
    const m = new Map();
    for (let i = 0; i < w.length - 1; i++) m.set(w.slice(i, i + 2), (m.get(w.slice(i, i + 2)) || 0) + 1);
    return m;
  };
  const px = pairs(x);
  const py = pairs(y);
  let overlap = 0;
  for (const [g, n] of px) overlap += Math.min(n, py.get(g) || 0);
  return (2 * overlap) / (x.length - 1 + (y.length - 1)) >= 0.7;
}

function sameFilm(a, b) {
  if (a.year && b.year && Math.abs(Number(a.year) - Number(b.year)) > 1) return false;
  return alike(a.title, b.title);
}

const trusted = (item) => (['confirmed', 'matched'].includes(item?.meta?.status) ? 0 : 1);

/* Which copy stays. Deterministic, so two phones collapsing the same pair on
   their own pick the same survivor and agree after the next sync: a looked-up
   record over one that was not, then the older, then the uid. */
function rank(a, b) {
  return (
    trusted(a) - trusted(b) ||
    (Number(a.addedAt) || 0) - (Number(b.addedAt) || 0) ||
    String(a.uid).localeCompare(String(b.uid))
  );
}

const empty = (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length);

/* The survivor keeps what it has and takes anything it lacks. Every "yes" —
   watched, owned, seen by a person — survives from either copy: losing one of
   those is the one outcome that would be noticed. */
function absorb(keep, other) {
  const out = { ...keep };
  for (const [k, v] of Object.entries(other)) {
    if (k === 'uid') continue;
    if (empty(out[k]) && !empty(v)) out[k] = v;
  }
  for (const k of ['watched', 'owned', 'seen', 'saved']) out[k] = !!(keep[k] || other[k]);
  const by = { ...(other.watchedBy || {}) };
  for (const [p, at] of Object.entries(keep.watchedBy || {})) by[p] = at ?? by[p] ?? null;
  out.watchedBy = by;
  out.locked = [...new Set([...(keep.locked || []), ...(other.locked || [])])];
  out.addedAt = Math.min(Number(keep.addedAt) || Infinity, Number(other.addedAt) || Infinity);
  if (!Number.isFinite(out.addedAt)) out.addedAt = keep.addedAt ?? null;
  return out;
}

/**
 * Fold records of the same film into one.
 *
 * Returns the snapshot unchanged (same object) when there is nothing to do.
 * Otherwise the survivor is stamped `now`, so its merged fields beat the
 * other phone's older copy, and every folded uid gets a tombstone, so the
 * other phone's copy of it is deleted rather than handed back.
 */
export function collapseDuplicates(snapshot, now = Date.now()) {
  const list = snapshot?.items || [];
  const groups = new Map();
  for (const item of list) {
    if (!item?.imdbId) continue;
    const key = `${item.type === 'tv' ? 'tv' : 'movie'}:${item.imdbId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const replace = new Map();
  const gone = new Set();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    /* Best first, and each record joins the first survivor it is plainly the
       same film as. One that is not stays exactly as it was. */
    const clusters = [];
    for (const item of [...group].sort(rank)) {
      const home = clusters.find((c) => sameFilm(c[0], item));
      if (home) home.push(item);
      else clusters.push([item]);
    }
    for (const [keep, ...rest] of clusters) {
      if (!rest.length) continue;
      let merged = keep;
      for (const other of rest) {
        merged = absorb(merged, other);
        gone.add(other.uid);
      }
      merged.updatedAt = now;
      replace.set(keep.uid, merged);
    }
  }
  if (!gone.size) return snapshot;

  const graves = (snapshot.tombstones || []).filter((t) => !gone.has(t?.uid));
  for (const uid of gone) graves.push({ uid, at: now });
  return {
    ...snapshot,
    items: list.filter((i) => !gone.has(i?.uid)).map((i) => replace.get(i?.uid) || i),
    tombstones: graves,
    collapsed: gone.size,
  };
}

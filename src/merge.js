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

  return {
    items: [...items.values()].sort((a, b) => String(a.uid).localeCompare(String(b.uid))),
    tombstones,
    people: [...people.values()],
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
  return JSON.stringify({ items, graves, people });
}

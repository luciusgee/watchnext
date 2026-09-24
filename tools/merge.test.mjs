/*
 * Merging two copies of a library.
 *
 * Every case here is a way two phones can disagree. The ones that matter most
 * are the ones where a naive merge loses data silently: a deletion that comes
 * back, an edit that gets overwritten by an older one, a film added on the
 * other phone that never arrives.
 */
import { mergeLibraries, fingerprint, TOMBSTONE_DAYS } from '../src/merge.js';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

const NOW = 1_800_000_000_000;
const item = (uid, updatedAt, extra = {}) => ({ uid, title: uid, updatedAt, ...extra });
const uids = (r) => r.items.map((i) => i.uid).sort().join(',');

console.log('\n─── adding on both sides ───');
{
  const mine = { items: [item('a', 10), item('b', 10)] };
  const theirs = { items: [item('a', 10), item('c', 10)] };
  const r = mergeLibraries(mine, theirs, NOW);
  check('everything both phones have survives', uids(r) === 'a,b,c', uids(r));
  /* The whole point. One of you adds films all evening; the other's next save
     must not be the one that counts. */
  const back = mergeLibraries(theirs, mine, NOW);
  check('and it does not matter which way round it runs', uids(back) === 'a,b,c', uids(back));
}

console.log('\n─── the same film, edited twice ───');
{
  const mine = { items: [item('a', 100, { title: 'mine' })] };
  const theirs = { items: [item('a', 200, { title: 'theirs' })] };
  check('the newer edit wins',
    mergeLibraries(mine, theirs, NOW).items[0].title === 'theirs');
  check('regardless of argument order',
    mergeLibraries(theirs, mine, NOW).items[0].title === 'theirs');
  /* A tie must be decided the same way by both devices or they push each
     other's version back and forth forever. */
  const tieA = mergeLibraries({ items: [item('a', 50, { title: 'x' })] }, { items: [item('a', 50, { title: 'y' })] }, NOW);
  check('a tie keeps the local copy, so a no-op merge stays a no-op', tieA.items[0].title === 'x');
}

console.log('\n─── deletions ───');
{
  /* Without a tombstone this is indistinguishable from "she has not heard of
     it yet", and the film comes straight back. */
  const DAY = 24 * 3600 * 1000;
  const hers = { items: [], tombstones: [{ uid: 'a', at: NOW - DAY }] };
  const mine = { items: [item('a', NOW - 5 * DAY)], tombstones: [] };
  const r = mergeLibraries(mine, hers, NOW);
  check('a film she deleted stays deleted here', uids(r) === '', uids(r));
  check('and the tombstone is kept, so the third device hears about it too',
    r.tombstones.length === 1 && r.tombstones[0].uid === 'a');

  /* The other direction: re-adding something is a later fact than deleting it. */
  const readded = mergeLibraries({ items: [item('a', NOW - 1000)], tombstones: [] }, hers, NOW);
  check('but re-adding it afterwards sticks', uids(readded) === 'a', uids(readded));
  check('and the stale tombstone is dropped rather than left to kill it again',
    readded.tombstones.length === 0, JSON.stringify(readded.tombstones));
}

console.log('\n─── tombstones do not accumulate forever ───');
{
  const old = NOW - (TOMBSTONE_DAYS + 5) * 24 * 3600 * 1000;
  const recent = NOW - 24 * 3600 * 1000;
  const r = mergeLibraries(
    { items: [], tombstones: [{ uid: 'old', at: old }, { uid: 'new', at: recent }] },
    { items: [] },
    NOW
  );
  check('an ancient one is pruned', !r.tombstones.some((t) => t.uid === 'old'));
  check('a recent one is not', r.tombstones.some((t) => t.uid === 'new'));
}

console.log('\n─── people ───');
{
  const r = mergeLibraries(
    { items: [], people: [{ id: 'p1', name: 'Luke' }] },
    { items: [], people: [{ id: 'p2', name: 'Partner' }] },
    NOW
  );
  /* watchedBy is keyed on these ids, so a household that does not agree on
     them has per-person watch marks that mean nothing on the other phone. */
  check('both people end up on both phones', r.people.length === 2,
    r.people.map((p) => p.name).join(','));
}

console.log('\n─── first run, with nothing on the other side ───');
{
  const r = mergeLibraries({ items: [item('a', 1), item('b', 2)] }, null, NOW);
  check('an empty remote does not wipe the library', uids(r) === 'a,b', uids(r));
  const r2 = mergeLibraries({}, { items: [item('z', 1)] }, NOW);
  check('and an empty local adopts theirs', uids(r2) === 'z', uids(r2));
}

console.log('\n─── records that predate updatedAt ───');
{
  /* Several hundred of Luke's titles were written before the field existed. */
  const legacy = { uid: 'a', title: 'old', addedAt: 400 };
  const r = mergeLibraries({ items: [legacy] }, { items: [item('a', 300, { title: 'newer?' })] }, NOW);
  check('addedAt stands in for a missing updatedAt', r.items[0].title === 'old', r.items[0].title);
  const r2 = mergeLibraries({ items: [{ uid: 'a', title: 'no stamps at all' }] }, { items: [item('a', 1, { title: 'stamped' })] }, NOW);
  check('and a record with neither loses to one that has them', r2.items[0].title === 'stamped', r2.items[0].title);
}

console.log('\n─── the fingerprint decides whether to spend a write ───');
{
  const a = { items: [item('x', 1), item('y', 2)], tombstones: [{ uid: 'z', at: 3 }], people: [] };
  const b = { items: [item('y', 2), item('x', 1)], tombstones: [{ uid: 'z', at: 3 }], people: [] };
  check('order does not change it', fingerprint(a) === fingerprint(b));
  const c = { ...a, items: [item('x', 9), item('y', 2)] };
  check('an edit does', fingerprint(a) !== fingerprint(c));
  /* Merging twice must settle. If it did not, two phones would write to the
     repo on every poll for the rest of time. */
  const once = mergeLibraries(a, b, NOW);
  const twice = mergeLibraries(once, b, NOW);
  check('merging is idempotent, so syncing settles instead of ping-ponging',
    fingerprint(once) === fingerprint(twice));
}

console.log(`\n══════════  ${pass} passed, ${fail} failed  ══════════`);
if (failures.length) { console.log('\nFailures:'); failures.forEach((f) => console.log('  · ' + f)); }
process.exit(fail ? 1 : 0);

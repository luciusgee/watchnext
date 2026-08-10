/*
 * The scorer.
 *
 * 250 lines with no tests, sitting under Tonight, the session picker, the
 * "also worth tonight" rail and the similar-titles row. Every ranking decision
 * in the app goes through here, and until now the only way to notice a change
 * had broken something was to look at the home screen and feel that the pick
 * seemed off.
 *
 * These are behavioural, not numerical: they assert the ordering rules the
 * product actually promises — you can play it tonight, it fits the hour, a
 * re-watch has to earn its place — rather than the exact constants, which are
 * meant to be tuned. A test that pins `score === 41.6` fails on every honest
 * tweak and teaches you to stop caring about failures.
 */

import { tasteProfile, scoreItem, rank, tonightPick, alternates, similarTo } from '../src/recommend.js';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ok    ${name}`);
  } else {
    fail++;
    failures.push(name + (detail ? ` — ${detail}` : ''));
    console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const YEAR = 365 * 24 * 3600 * 1000;
let n = 0;
const film = (over = {}) => ({
  uid: `u${++n}`,
  title: `Film ${n}`,
  year: 2000,
  type: 'movie',
  genre: 'Horror',
  genres: ['Horror'],
  rating: 7,
  runtime: 100,
  poster: 'p.jpg',
  quality: null,
  owned: false,
  watched: false,
  watchedAt: null,
  seen: false,
  addedAt: 1600000000000,
  ...over,
});

const ctx = (over = {}) => ({
  seed: 'fixed',
  hour: 20,
  ownedOnly: false,
  allowRewatch: true,
  primeTime: true,
  ...over,
});

const flat = { affinity: new Map(), sampleSize: 0, top: [] };

console.log('\n─── taste profile ───');
{
  const items = [
    film({ genre: 'Horror', watched: true, watchedAt: Date.now() - 0.1 * YEAR }),
    film({ genre: 'Horror', watched: true, watchedAt: Date.now() - 0.2 * YEAR }),
    film({ genre: 'Comedy', watched: true, watchedAt: Date.now() - 6 * YEAR }),
    film({ genre: 'Drama', watched: false }),
  ];
  const p = tasteProfile(items);
  check('only watched titles count towards taste', p.sampleSize === 3, String(p.sampleSize));
  check('an unwatched genre earns no affinity', !p.affinity.has('Drama'));
  check('recent viewing outweighs old viewing',
    p.affinity.get('Horror') > p.affinity.get('Comedy'),
    `${p.affinity.get('Horror')} vs ${p.affinity.get('Comedy')}`);
  check('affinities are a distribution, summing to 1',
    Math.abs([...p.affinity.values()].reduce((a, b) => a + b, 0) - 1) < 1e-9);
  check('the top list is ordered by weight', p.top[0] === 'Horror', p.top.join(','));
}
{
  const p = tasteProfile([]);
  check('an empty library produces an empty profile, not a crash',
    p.sampleSize === 0 && p.affinity.size === 0 && p.top.length === 0);
}
{
  /* Clock skew, or a device whose date was wrong when something was marked. */
  const p = tasteProfile([film({ genre: 'Horror', watched: true, watchedAt: Date.now() + 5 * YEAR })]);
  check('a future watch date does not produce a negative or infinite weight',
    Number.isFinite(p.affinity.get('Horror')) && p.affinity.get('Horror') > 0,
    String(p.affinity.get('Horror')));
}

console.log('\n─── the hard filters ───');
{
  check('ownedOnly excludes what you do not own',
    scoreItem(film({ owned: false }), flat, ctx({ ownedOnly: true })) === null);
  check('and keeps what you do',
    scoreItem(film({ owned: true }), flat, ctx({ ownedOnly: true })) !== null);
  check('a re-watch is excluded when re-watches are off',
    scoreItem(film({ watched: true }), flat, ctx({ allowRewatch: false })) === null);
}

console.log('\n─── what outranks what ───');
{
  const owned = scoreItem(film({ owned: true }), flat, ctx());
  const notOwned = scoreItem(film({ owned: false }), flat, ctx());
  check('something you own beats an identical film you do not',
    owned.score > notOwned.score, `${owned.score} vs ${notOwned.score}`);
  check('and it says why', owned.why.includes('you already have this'), owned.why.join(' · '));

  const better = scoreItem(film({ rating: 8.5 }), flat, ctx());
  const worse = scoreItem(film({ rating: 5.5 }), flat, ctx());
  check('a better-rated film wins, all else equal',
    better.score > worse.score, `${better.score} vs ${worse.score}`);

  const unplayed = scoreItem(film({ owned: true, watched: false }), flat, ctx());
  check('owned and never watched carries its own reason',
    unplayed.why.some((w) => /have not watched/.test(w)), unplayed.why.join(' · '));

  const seen = scoreItem(film({ seen: true }), flat, ctx());
  const fresh = scoreItem(film({ seen: false }), flat, ctx());
  check('something already dismissed in Discover ranks lower',
    seen.score < fresh.score, `${seen.score} vs ${fresh.score}`);

  const noArt = scoreItem(film({ poster: null }), flat, ctx());
  check('a title with no artwork ranks lower — it makes a poor hero',
    noArt.score < fresh.score, `${noArt.score} vs ${fresh.score}`);

  const show = scoreItem(film({ type: 'tv' }), flat, ctx());
  check('a series ranks below a film — it is a bigger commitment',
    show.score < fresh.score, `${show.score} vs ${fresh.score}`);
}

console.log('\n─── the hour of the day ───');
{
  const lateShort = scoreItem(film({ runtime: 95 }), flat, ctx({ hour: 23 }));
  const lateLong = scoreItem(film({ runtime: 165 }), flat, ctx({ hour: 23 }));
  check('late at night a short film beats a long one',
    lateShort.score > lateLong.score, `${lateShort.score} vs ${lateLong.score}`);
  check('and it says so', lateShort.why.includes('short enough for tonight'), lateShort.why.join(' · '));

  const eveningLong = scoreItem(film({ runtime: 165 }), flat, ctx({ hour: 20 }));
  check('the same long film is not penalised at eight in the evening',
    eveningLong.score > lateLong.score, `${eveningLong.score} vs ${lateLong.score}`);

  /* The window wraps midnight — 1am is late, 2am is not (you are asleep, or the
     hour is wrong). Worth pinning because an off-by-one here is invisible. */
  const at1am = scoreItem(film({ runtime: 95 }), flat, ctx({ hour: 1 }));
  check('1am counts as late', at1am.why.includes('short enough for tonight'));

  const prime4K = scoreItem(film({ owned: true, quality: '4K' }), flat, ctx({ hour: 20, primeTime: true }));
  const offPeak4K = scoreItem(film({ owned: true, quality: '4K' }), flat, ctx({ hour: 14, primeTime: false }));
  check('4K counts for more in prime time',
    prime4K.score > offPeak4K.score, `${prime4K.score} vs ${offPeak4K.score}`);
  check('and only then does it get mentioned',
    prime4K.why.some((w) => /4K/.test(w)) && !offPeak4K.why.some((w) => /4K/.test(w)));
}

console.log('\n─── a re-watch has to earn its place ───');
{
  const recent = scoreItem(
    film({ watched: true, watchedAt: Date.now() - 0.5 * YEAR, rating: 9 }), flat, ctx());
  check('something watched six months ago is not suggested again', recent === null);

  const lovedLongAgo = scoreItem(
    film({ watched: true, watchedAt: Date.now() - 4 * YEAR, rating: 8.5 }), flat, ctx());
  check('a film you loved four years ago is fair game', lovedLongAgo !== null);
  check('and the reason replaces the others rather than stacking',
    lovedLongAgo.why.length === 1 && /you loved this/.test(lovedLongAgo.why[0]),
    lovedLongAgo.why.join(' · '));

  const mediocre = scoreItem(
    film({ watched: true, watchedAt: Date.now() - 4 * YEAR, rating: 6 }), flat, ctx());
  check('a film you did not love is not resurrected', mediocre === null);

  const unrated = scoreItem(
    film({ watched: true, watchedAt: Date.now() - 4 * YEAR, rating: null }), flat, ctx());
  check('nor one with no rating to judge it by', unrated === null);

  const older = scoreItem(
    film({ watched: true, watchedAt: Date.now() - 6 * YEAR, rating: 8.5 }), flat, ctx());
  const newer = scoreItem(
    film({ watched: true, watchedAt: Date.now() - 1.5 * YEAR, rating: 8.5 }), flat, ctx());
  check('the longer it has been, the stronger the case',
    older.score > newer.score, `${older.score} vs ${newer.score}`);

  /* The re-watch curve is -14 up front, +2.5 a year to a six-year cap, +6 for
     a film you loved. So it climbs from well behind to roughly level, and the
     meaningful assertion is about where it still loses: two years is not
     enough to displace something you own and have never played. */
  const twoYears = scoreItem(
    { ...film({ watched: true, watchedAt: Date.now() - 2 * YEAR, rating: 8.5, owned: true }), uid: 'same' },
    flat, ctx());
  const neverPlayed = scoreItem(
    { ...film({ rating: 8.5, owned: true }), uid: 'same' }, flat, ctx());
  check('a two-year-old re-watch loses to something you own and never played',
    neverPlayed.score > twoYears.score, `${neverPlayed.score} vs ${twoYears.score}`);

  const sixYears = scoreItem(
    { ...film({ watched: true, watchedAt: Date.now() - 6 * YEAR, rating: 8.5, owned: true }), uid: 'same' },
    flat, ctx());
  check('and only draws level with it after many years',
    Math.abs(sixYears.score - neverPlayed.score) < 3,
    `${sixYears.score} vs ${neverPlayed.score}`);
}

console.log('\n─── taste actually moves the ranking ───');
{
  const history = Array.from({ length: 6 }, () =>
    film({ genre: 'Horror', watched: true, watchedAt: Date.now() - 0.2 * YEAR, rating: 7 }));
  const horror = film({ genre: 'Horror', genres: ['Horror'] });
  const western = film({ genre: 'Western', genres: ['Western'] });
  const p = tasteProfile(history);

  const h = scoreItem(horror, p, ctx());
  const w = scoreItem(western, p, ctx());
  check('a genre you watch a lot outranks one you never touch',
    h.score > w.score, `${h.score} vs ${w.score}`);
  check('and the reason names it',
    h.why.some((r) => /you watch a lot of horror/.test(r)), h.why.join(' · '));

  /* Same uid on both, so the per-item jitter is identical and any difference
     left is taste. Comparing two different films here would let a 0-6 point
     shuffle stand in for the signal being measured. */
  const thin = tasteProfile([film({ genre: 'Horror', watched: true })]);
  const hThin = scoreItem({ ...horror, uid: 'same' }, thin, ctx());
  const wThin = scoreItem({ ...western, uid: 'same' }, thin, ctx());
  check('one watched film is not enough to claim a taste',
    Math.abs(hThin.score - wThin.score) < 0.01, `${hThin.score} vs ${wThin.score}`);
}

console.log('\n─── rank() ───');
{
  const items = [
    film({ owned: true, rating: 8 }),
    film({ owned: false, rating: 8 }),
    film({ owned: true, rating: 5 }),
  ];
  const r = rank(items, { seed: 'x', hour: 20 });
  check('every candidate comes back scored', r.length === 3, String(r.length));
  check('sorted best first', r[0].score >= r[1].score && r[1].score >= r[2].score);
  check('each result carries its item and its reasons',
    r.every((x) => x.item && Array.isArray(x.why)));

  check('the limit is respected', rank(items, { seed: 'x', limit: 2 }).length === 2);
  check('an empty library ranks to nothing', rank([], { seed: 'x' }).length === 0);

  const long = [film({ runtime: 200, owned: true }), film({ runtime: 88, owned: true })];
  const short = rank(long, { seed: 'x', maxRuntime: 90 });
  check('maxRuntime filters before scoring', short.length === 1 && short[0].item.runtime === 88);

  const noRuntime = rank([film({ runtime: null, owned: true })], { seed: 'x', maxRuntime: 90 });
  check('a title with no runtime is not excluded by a runtime limit', noRuntime.length === 1);

  /* Stability is the point of the daily seed: the home screen must not
     reshuffle between renders. */
  const a = rank(items, { seed: '2026-08-10', hour: 20 }).map((x) => x.item.uid);
  const b = rank(items, { seed: '2026-08-10', hour: 20 }).map((x) => x.item.uid);
  check('the same seed gives the same order every time', a.join() === b.join());

  const c = rank(items, { seed: 'a-different-day', hour: 20 }).map((x) => x.item.uid);
  check('a different seed is free to differ', Array.isArray(c) && c.length === 3);
}

console.log('\n─── the taste profile is the caller\'s to supply ───');
{
  /* The session picker narrows the library before ranking, so it has to pass
     the profile built from everything. Without this option it computed taste
     from the filtered slice, and a genre filter would erase the taste signal
     it was meant to work alongside. */
  const library = [
    ...Array.from({ length: 6 }, () =>
      film({ genre: 'Horror', watched: true, watchedAt: Date.now() - 0.2 * YEAR })),
    film({ genre: 'Western', owned: true }),
    film({ genre: 'Horror', owned: true }),
  ];
  const pool = library.filter((i) => !i.watched); // one western, one horror

  const whole = tasteProfile(library);
  const fromPool = tasteProfile(pool);
  check('a filtered pool alone yields no usable taste', fromPool.sampleSize === 0);

  const withProfile = rank(pool, { seed: 'x', hour: 20, profile: whole });
  const withoutProfile = rank(pool, { seed: 'x', hour: 20 });
  check('passing the real profile puts the horror film first',
    withProfile[0].item.genre === 'Horror', withProfile[0].item.genre);
  check('and it is genuinely different from ranking the pool blind',
    withProfile[0].score !== withoutProfile[0].score,
    `${withProfile[0].score} vs ${withoutProfile[0].score}`);
}

console.log('\n─── tonightPick and alternates ───');
{
  const items = [film({ owned: true, rating: 9 }), film({ owned: true, rating: 8 }), film({ owned: true, rating: 7 })];
  const first = tonightPick(items, { seed: 'x', hour: 20 });
  check('there is a pick', !!first);
  const second = tonightPick(items, { seed: 'x', hour: 20, offset: 1 });
  check('"not tonight" moves to a different film', first.item.uid !== second.item.uid);

  const wrapped = tonightPick(items, { seed: 'x', hour: 20, offset: 3 });
  check('the offset wraps rather than running out', wrapped.item.uid === first.item.uid);
  check('nothing to pick from returns null, not a crash', tonightPick([], { seed: 'x' }) === null);

  const alt = alternates(items, { seed: 'x', hour: 20, exclude: [first.item.uid] });
  check('alternates exclude what is already on screen',
    !alt.some((a) => a.item.uid === first.item.uid));

  /* An empty shelf is a worse answer than a slightly weaker suggestion. */
  const nothingOwned = [film({ owned: false, rating: 8 })];
  const relaxed = alternates(nothingOwned, { seed: 'x', hour: 20, ownedOnly: true });
  check('with nothing owned, alternates relax rather than return nothing',
    relaxed.length === 1, String(relaxed.length));
}

console.log('\n─── similar titles ───');
{
  /* `genres` has to be overridden alongside `genre` or the factory default
     leaves a Romance film still tagged Horror — which is a fair description of
     how this data actually behaves, and worth getting right in the fixture. */
  const subject = film({ genre: 'Horror', genres: ['Horror'], year: 1999, type: 'movie' });
  const pool = [
    subject,
    film({ genre: 'Horror', genres: ['Horror'], year: 2001, type: 'movie', rating: 8 }),
    film({ genre: 'Horror', genres: ['Horror'], year: 1960, type: 'movie', rating: 8 }),
    film({ genre: 'Romance', genres: ['Romance'], year: 1999, type: 'movie', rating: 8 }),
    film({ genre: 'Thriller', genres: ['Thriller', 'Horror'], year: 1998, type: 'movie', rating: 8 }),
  ];
  const sim = similarTo(subject, pool);
  check('a film is never similar to itself', !sim.some((s) => s.uid === subject.uid));
  check('same genre and close in era comes first', sim[0].year === 2001, String(sim[0]?.year));
  check('a different genre does not clear the bar',
    !sim.some((s) => s.genre === 'Romance'), sim.map((s) => s.genre).join(','));
  check('but an overlapping secondary genre does',
    sim.some((s) => s.genre === 'Thriller'), sim.map((s) => s.genre).join(','));
  check('an empty library returns nothing rather than throwing', similarTo(subject, []).length === 0);
}

console.log(`\n══════════  ${pass} passed, ${fail} failed  ══════════`);
if (failures.length) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log('  · ' + f));
}
process.exit(fail ? 1 : 0);

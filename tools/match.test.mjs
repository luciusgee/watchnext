/*
 * Matcher unit tests — offline, using recorded OMDb-shaped fixtures.
 *
 * These encode the failures that made the previous version put the wrong
 * poster on a third of the library. Run with:  node tools/match.test.mjs
 */

globalThis.localStorage ??= {
  _d: {},
  getItem(k) { return this._d[k] ?? null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; },
};

const { scoreCandidate, decide, similarity, parseRuntime, parseRating, parseYear, pickGenre } =
  await import('../src/metadata.js');
const { posterUrl: omdbPoster } = await import('../src/providers/omdb.js');
const { posterUrl: tmdbPoster } = await import('../src/providers/tmdb.js');
const { normaliseGenres } = await import('../src/providers/shared.js');

let pass = 0, fail = 0;
const t = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
};

/* neutral Record shape — what every provider returns */
const C = (title, year, type, sourceId) => ({
  sourceId, imdbId: /^tt/.test(sourceId) ? sourceId : null,
  title, year, type: type === 'series' ? 'tv' : type,
  genres: [], genre: null, runtime: null, rating: null, votes: null,
  overview: '', poster: 'https://x/y.jpg',
});

/* Rank a candidate list the way findMatch does, so the decision logic is
   exercised without touching the network. */
function best(query, candidates) {
  return candidates
    .map((c) => ({ candidate: c, ...scoreCandidate(query, c) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
}

console.log('\n─── string similarity ───');
t('identical titles score 1', similarity('Blade Runner', 'Blade Runner') === 1);
t('article and case are ignored', similarity('The Thing', 'thing') === 1);
t('punctuation is ignored', similarity('WALL·E', 'WALL-E') === 1);
t('ampersand normalises', similarity('Fire & Blood', 'Fire and Blood') === 1);
t('unrelated titles score low', similarity('Casino', 'Awakenings') < 0.3);
t('Alien vs Aliens are distinguishable', similarity('Alien', 'Aliens') < 1);

console.log('\n─── the wrong-film failures from the old build ───');
{
  // "1899" (a 2022 series) must not resolve to the making-of documentary,
  // even though the stored type says "movie".
  const r = best({ title: '1899', year: 2022, type: 'movie' }, [
    C('1899', 2022, 'series', 'tt9319668'),
    C('Making 1899', 2022, 'movie', 'tt2383010'),
    C('Space: 1899', 2004, 'movie', 'tt0439821'),
  ]);
  t('1899 ranks the real series first', r[0].candidate.sourceId === 'tt9319668',
    `${r[0].candidate.title} (${r[0].candidate.year})`);
}
{
  // "Dune" (2021) is canonically titled "Dune: Part One" — a subtitle appended
  // to the query must beat an unrelated film that merely ends in the query.
  const r = best({ title: 'Dune', year: 2021, type: 'movie' }, [
    C('Planet Dune', 2021, 'movie', 'tt13927406'),
    C('Dune: Part One', 2021, 'movie', 'tt1160419'),
    C('Dune', 1984, 'movie', 'tt0087182'),
    C('Dune Drifter', 2020, 'movie', 'tt11762476'),
  ]);
  t('Dune 2021 ranks "Dune: Part One" first', r[0].candidate.sourceId === 'tt1160419',
    `${r[0].candidate.title}`);
}
{
  const r = best({ title: 'Dune', year: 1984, type: 'movie' }, [
    C('Dune: Part One', 2021, 'movie', 'tt1160419'),
    C('Dune', 1984, 'movie', 'tt0087182'),
  ]);
  t('Dune 1984 still ranks the Lynch film first', r[0].candidate.sourceId === 'tt0087182');
}
{
  const r = best({ title: 'Alien', year: 1979, type: 'movie' }, [
    C('Aliens', 1986, 'movie', 'tt0090605'),
    C('Alien', 1979, 'movie', 'tt0078748'),
    C('Alien: Romulus', 2024, 'movie', 'tt18412256'),
  ]);
  t('Alien does not drift onto Aliens', r[0].candidate.sourceId === 'tt0078748');
}
{
  const r = best({ title: 'Aliens', year: 1986, type: 'movie' }, [
    C('Alien', 1979, 'movie', 'tt0078748'),
    C('Aliens', 1986, 'movie', 'tt0090605'),
  ]);
  t('Aliens does not drift onto Alien', r[0].candidate.sourceId === 'tt0090605');
}
{
  const r = best({ title: 'It', year: 2017, type: 'movie' }, [
    C('It', 2017, 'movie', 'tt1396484'),
    C('IT', 1990, 'series', 'tt0099864'),
    C('It Chapter Two', 2019, 'movie', 'tt7349950'),
  ]);
  t('short ambiguous titles use the year', r[0].candidate.sourceId === 'tt1396484');
}
{
  const r = best({ title: 'It', year: 1990, type: 'tv' }, [
    C('It', 2017, 'movie', 'tt1396484'),
    C('IT', 1990, 'series', 'tt0099864'),
  ]);
  t('the 1990 miniseries wins when that is what you asked for', r[0].candidate.sourceId === 'tt0099864');
}

console.log('\n─── refusing to guess ───');
{
  const r = best({ title: 'Zzzqqx Nonexistent', year: 2020, type: 'movie' }, [
    C('Casino', 1995, 'movie', 'tt0112641'),
    C('Awakenings', 1990, 'movie', 'tt0099077'),
  ]);
  t('nothing plausible scores at all', r.length === 0, `${r.length} candidates survived`);
}
{
  const s = scoreCandidate({ title: 'World War Z', year: 2013, type: 'movie' },
    C('Mars Attacks!', 1996, 'movie', 'tt0116996'));
  t('a wholly different film scores zero', s.score === 0, `${s.score}`);
}
{
  // A candidate 30 years adrift must be heavily penalised even on an exact title.
  const near = scoreCandidate({ title: 'The Thing', year: 1982, type: 'movie' }, C('The Thing', 1982, 'movie', 'tt0084787'));
  const far  = scoreCandidate({ title: 'The Thing', year: 1982, type: 'movie' }, C('The Thing', 2011, 'movie', 'tt0905372'));
  t('the right year scores well above the wrong one', near.score - far.score > 0.4,
    `${near.score.toFixed(2)} vs ${far.score.toFixed(2)}`);
}

console.log('\n─── field parsing ───');
t('runtime parses "117 min"', parseRuntime('117 min', 'movie') === 117);
t('runtime survives OMDb\'s malformed "56S min"', parseRuntime('56S min', 'tv') === 56);
t('runtime rejects N/A', parseRuntime('N/A', 'movie') === null);
t('runtime rejects an implausible value', parseRuntime('4000 min', 'movie') === null);
t('rating parses', parseRating('8.1') === 8.1);
t('rating rejects out-of-range', parseRating('42') === null);
t('year parses from a range', parseYear('2011–2019') === 2011);
t('year rejects nonsense', parseYear('N/A') === null);
t('genre prefers the characterful one', pickGenre('Drama, Horror, Mystery') === 'Horror');
t('genre falls back sensibly', pickGenre('Drama') === 'Drama');
t('genre rejects N/A', pickGenre('N/A') === null);
t('OMDb poster is upscaled', omdbPoster('https://m.media-amazon.com/images/M/abc._V1_SX300.jpg', 600).includes('SX600'));
t('OMDb poster rejects N/A', omdbPoster('N/A') === null);
t('TMDB poster builds a full URL', tmdbPoster('/abc.jpg') === 'https://image.tmdb.org/t/p/w500/abc.jpg');
t('TMDB poster tolerates a missing slash', tmdbPoster('abc.jpg') === 'https://image.tmdb.org/t/p/w500/abc.jpg');
t('TMDB poster rejects null', tmdbPoster(null) === null);
t('runtime accepts a plain number (TMDB)', parseRuntime(117, 'movie') === 117);
t('genres normalise from TMDB objects', normaliseGenres([{ id: 27, name: 'Horror' }, { id: 18, name: 'Drama' }]).join() === 'Horror,Drama');
t('genres normalise TMDB "Science Fiction"', normaliseGenres([{ id: 878, name: 'Science Fiction' }])[0] === 'Sci-Fi');
t('genres normalise TMDB "Sci-Fi & Fantasy"', normaliseGenres([{ id: 10765, name: 'Sci-Fi & Fantasy' }])[0] === 'Sci-Fi');
t('genres normalise an OMDb comma string', normaliseGenres('Drama, Horror, Mystery').join() === 'Drama,Horror,Thriller');

console.log('\n─── decision boundaries ───');
{
  const d = decide({ title: 'Heat', year: 1995, type: 'movie' }, [C('Heat', 1995, 'movie', 'tt0113277')]);
  t('an exact title+year match auto-accepts', d.status === 'matched' && d.confidence >= 0.9);
}
{
  const d = decide({ title: 'Nosferatu', year: null, type: 'movie' },
    [C('Nosferatu', 2024, 'movie', 'a'), C('Nosferatu', 1922, 'movie', 'b')]);
  t('no year plus two same-titled candidates goes to review', d.status === 'review', d.status);
}
{
  /* Same title, same year, different type — the requested type is the only
     thing that can discriminate, and it should. */
  const d = decide({ title: 'Ghost', year: 1990, type: 'movie' },
    [C('Ghost', 1990, 'tv', 'y'), C('Ghost', 1990, 'movie', 'x')]);
  t('type discriminates when title and year tie', d.status === 'matched' && d.chosen.sourceId === 'x',
    `${d.status}/${d.chosen?.sourceId}`);
}
{
  /* Two remakes, no year on the item, nothing left to go on. */
  const d = decide({ title: 'The Getaway', year: null, type: 'movie' },
    [C('The Getaway', 1972, 'movie', 'a'), C('The Getaway', 1994, 'movie', 'b')]);
  t('no year plus identical titles never guesses', d.status === 'review' && d.chosen === null, d.status);
  t('review still offers both candidates to choose from', d.candidates.length === 2, `${d.candidates.length}`);
}
{
  /* A year present and agreeing on one candidate only — not ambiguous. */
  const d = decide({ title: 'The Getaway', year: 1972, type: 'movie' },
    [C('The Getaway', 1972, 'movie', 'a'), C('The Getaway', 1994, 'movie', 'b')]);
  t('a year resolves what would otherwise be ambiguous', d.status === 'matched' && d.chosen.sourceId === 'a');
}
{
  const d = decide({ title: 'Utterly Unknown Film', year: 2020, type: 'movie' }, []);
  t('an empty candidate list is unmatched, never a guess', d.status === 'unmatched' && d.chosen === null);
}

console.log(`\n══════════  ${pass} passed, ${fail} failed  ══════════\n`);
process.exit(fail ? 1 : 0);

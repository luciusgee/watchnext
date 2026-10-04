/*
 * The Savoy, Corby's listings: read from its page, saved by the Action, and
 * matched to the films on your list.
 *
 * The page is a trimmed copy of the real Coming Soon page (a few of its
 * films, the same markup), so the reader is tested against what the Savoy
 * actually sends. The Action runs against a stand-in for GitHub's contents
 * API and the Savoy's site; the matching runs on cinema.js itself with a
 * stand-in localStorage holding the listings.
 */
import fs from 'node:fs';
import path from 'node:path';

process.env.TZ = 'Europe/London';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}
const is = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const here = path.dirname(new URL(import.meta.url).pathname);
const page = fs.readFileSync(path.join(here, 'fixtures/savoy-comingsoon.html'), 'utf8');
const savoy = await import('../src/watchnext-cinema.js');
const NOW = new Date('2026-10-04T12:00:00Z');

console.log('\n─── titles, as the Savoy writes them ───');
is('a format in brackets', savoy.normaliseTitle('Wicked: For Good (2D)'), 'wicked for good');
is('an encore', savoy.normaliseTitle('Avengers: Endgame Encore'), 'avengers endgame');
is('a preview, and Part Three', savoy.normaliseTitle('Dune: Part Three – See It First Preview'), 'dune part 3');
is('an anniversary', savoy.normaliseTitle('Scream 30th Anniversary'), 'scream');
is('a leading "The"', savoy.normaliseTitle('The Hunger Games'), 'hunger games');
is('accents and ampersands', savoy.normaliseTitle('Tad & The Magic Lamp'), 'tad and the magic lamp');
is('a translated title gives both', savoy.altTitleKeys('Lalka (The Doll)'), ['lalka', 'doll']);
is('the library side: Part 3 and Part Three meet', savoy.normaliseTitle('Dune: Part Three'), savoy.normaliseTitle('Dune Part 3'));

console.log('\n─── dates without years ───');
is('Opening Fri 9 Oct, read on 4 Oct', savoy.parseUkDayLabel('Opening Fri 9 Oct', '2026-10-04'), '2026-10-09');
is('a January date read in December is next year', savoy.parseUkDayLabel('Fri 8 Jan', '2026-12-20'), '2027-01-08');
is('the next programme week starts on Friday', savoy.nextProgrammeWeek('2026-10-04'), '2026-10-09');

console.log('\n─── the Coming Soon page ───');
const listing = savoy.parseSavoy({ comingSoonHtml: page, now: NOW });
const byTitle = (t) => listing.films.find((f) => f.title === t);
check('every film on the page, on sale or announced', listing.films.length === 11, `${listing.films.length} films`);
const digger = byTitle('Digger');
check('a film on sale has its showings', digger?.showings.length === 4);
check('each with a date, a time and a screen',
  digger.showings.every((s) => /^\d{4}-\d{2}-\d{2}$/.test(s.date) && /^\d{2}:\d{2}$/.test(s.time) && /^Screen \d$/.test(s.screen)));
check('and a link straight to choosing seats for that showing',
  digger.showings.every((s) => /^https:\/\/savoycorby\.co\.uk\/SavoyCorby\.dll\/Booking\?Booking=TSelectItems\.waSelectItemsPrompt\.TcsWebMenuItem_0\.TcsWebTab_0\.TcsPerformance_\d+\.TcsSection_\d+$/.test(s.book)),
  digger.showings[0]?.book);
check('soonest first', digger.showings.map((s) => s.date + s.time).join() === digger.showings.map((s) => s.date + s.time).sort().join());
check('certificate and running time from the programme', digger.certificate === '15' && digger.runtime === 129);
check('the film page link', digger.url === 'https://savoycorby.co.uk/SavoyCorby.dll/WhatsOn?f=49175098');
const reckoning = byTitle('The Social Reckoning');
check('an announced film, not on sale yet: on Coming Soon, no showings', reckoning?.comingSoon === true && reckoning.showings.length === 0);
is('with the day it opens', reckoning?.opens, '2026-10-09');
is('Clayface opens a fortnight later', byTitle('Clayface')?.opens, '2026-10-23');
const party = byTitle('24 Hour Party People');
check('a film sold through another site keeps that link, marked as elsewhere',
  party?.showings.length === 2 && party.showings.every((s) => s.external && /^https:\/\/escapes\.cinematik\.app\//.test(s.book)));
check('the anniversary showing is an event, under its own title', byTitle('Scream 30th Anniversary')?.event === true);
check('a kids club showing is tagged as one', byTitle('Hocus Pocus')?.showings.some((s) => s.tags.includes('Kids Club')));
check('a re-release is tagged as one', byTitle('The Hunger Games')?.showings.every((s) => s.tags.includes('Re-release')));

let threw = null;
try {
  savoy.parseSavoy({ comingSoonHtml: page.replace(/"Performances":\[[^\]]*\]/g, '"Performances":[]'), now: NOW });
} catch (err) {
  threw = err.message;
}
check('a page with nothing on sale is an error, not an empty cinema', /no showings/.test(threw || ''), threw);
threw = null;
try {
  savoy.parseSavoy({ comingSoonHtml: '<html>Down for maintenance</html>', now: NOW });
} catch (err) {
  threw = err.message;
}
check('and so is a page without the programme', /could not find/.test(threw || ''), threw);

console.log('\n─── the Action ───');
/* GitHub's contents API for one repo, and the Savoy's site, in one fetch. */
function world({ savoyDown = false, collideOnce = false } = {}) {
  const files = new Map();
  const log = [];
  let sha = 0;
  let collided = false;
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetch = async (url, opts = {}) => {
    const u = new URL(url);
    if (u.hostname === 'savoycorby.co.uk') {
      log.push(`savoy ${u.pathname}${u.search}`);
      if (savoyDown) return new Response('Service Unavailable', { status: 503 });
      if (u.search === '?p=1&m=mm') return new Response(page, { status: 200 });
      return new Response('<html><div id="Content"><h1 class="title">Film</h1><ul class="programme-info"><li>101mins</li></ul></div></html>', { status: 200 });
    }
    if (u.hostname === 'api.example.test') {
      check(`GitHub is asked with the run's token (${opts.method || 'GET'})`, opts.headers?.authorization === 'Bearer t0ken');
      const p = decodeURIComponent(u.pathname.replace('/repos/me/data/contents/', ''));
      if ((opts.method || 'GET') === 'GET') {
        log.push(`get ${p}`);
        const f = files.get(p);
        return f ? json(200, { sha: f.sha, content: Buffer.from(f.text).toString('base64') }) : json(404, {});
      }
      const body = JSON.parse(opts.body);
      log.push(`put ${p} ${body.message}`);
      if (collideOnce && !collided) {
        collided = true;
        files.set(p, { sha: `s${++sha}`, text: '{"films":[]}' });
        return json(409, {});
      }
      const held = files.get(p);
      if ((held?.sha || undefined) !== body.sha) return json(409, {});
      files.set(p, { sha: `s${++sha}`, text: Buffer.from(body.content, 'base64').toString('utf8') });
      return json(200, {});
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { files, log, fetch };
}
const env = { GITHUB_API_URL: 'https://api.example.test', GITHUB_REPOSITORY: 'me/data', GITHUB_TOKEN: 't0ken' };
const quiet = [];
const logTo = (m) => quiet.push(m);

{
  const w = world();
  const first = await savoy.runAction({ env, fetch: w.fetch, log: logTo });
  check('the first run saves the listings', first.changed === true && w.files.has('cinema/savoy-corby.json'));
  const saved = JSON.parse(w.files.get('cinema/savoy-corby.json').text);
  check('as the listings the page gives', saved.films.length === 11 && saved.films.some((f) => f.title === 'Digger' && f.showings.length === 4));
  check('with a commit message that says what is on', w.log.some((l) => /^put cinema\/savoy-corby\.json Savoy listings: 11 films, \d+ showings$/.test(l)), w.log.join(' | '));
  const films = w.log.filter((l) => l.startsWith('savoy ')).length;
  check('one page from the Savoy, plus a page each for films not on sale yet', films === 3, w.log.join(' | '));

  w.log.length = 0;
  const second = await savoy.runAction({ env, fetch: w.fetch, log: logTo });
  check('a run that finds the same listings writes nothing', second.changed === false && !w.log.some((l) => l.startsWith('put')), w.log.join(' | '));
  check('and does not fetch the announced films again, already known from last time',
    w.log.filter((l) => l.startsWith('savoy ')).length === 1, w.log.join(' | '));
}
{
  const w = world({ savoyDown: true });
  w.files.set('cinema/savoy-corby.json', { sha: 's0', text: JSON.stringify({ films: [{ id: '1', title: 'Kept', showings: [] }] }) });
  quiet.length = 0;
  const down = await savoy.runAction({ env, fetch: w.fetch, log: logTo });
  check('the Savoy\'s site down: the run does not fail', down.changed === false && /503/.test(down.error || ''));
  check('it keeps the last listings', JSON.parse(w.files.get('cinema/savoy-corby.json').text).films[0].title === 'Kept');
  check('and says why, as a warning on the run', quiet.some((m) => m.startsWith('::warning::') && /503/.test(m)), quiet.join(' | '));
}
{
  const w = world({ collideOnce: true });
  const res = await savoy.runAction({ env, fetch: w.fetch, log: logTo });
  check('a phone writing at the same moment: read again and saved', res.changed === true && JSON.parse(w.files.get('cinema/savoy-corby.json').text).films.length === 11);
}

console.log('\n─── matching your films ───');
/* cinema.js reads the listings from localStorage; nothing else here needs
   a browser. */
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
const recent = { ...listing, fetchedAt: new Date().toISOString() };
/* Showings from the page are dated October 2026; move them to start today,
   whatever today is, so "still to come" holds. */
const today = new Date();
const shift = Math.round((Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) - Date.UTC(2026, 9, 4)) / 864e5);
const moveDate = (d) => {
  const [y, m, dd] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, dd + shift)).toISOString().slice(0, 10);
};
for (const f of recent.films) {
  if (f.opens) f.opens = moveDate(f.opens);
  for (const s of f.showings) s.date = moveDate(s.date);
}
mem.set('wn.cinema', JSON.stringify(recent));
const cinema = await import('../src/cinema.js');
const future = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 1);

const yearOfShow = today.getFullYear();
check('your new film, by its own title', cinema.filmFor({ title: 'Digger', year: yearOfShow })?.id === '49175098');
check('and its showings, soonest first', cinema.showingsFor({ title: 'Digger', year: yearOfShow }, future).length === 4);
check('a film with no year on your list still matches', cinema.filmFor({ title: 'Digger' })?.id === '49175098');
check('"Avengers: Endgame" (2019) finds its encore', cinema.filmFor({ title: 'Avengers: Endgame', year: 2019 })?.id === '20140259');
check('"Scream" (1996) finds the 30th anniversary showing', cinema.filmFor({ title: 'Scream', year: 1996 })?.id === '27607894');
check('"The Hunger Games" (2012) finds the re-release', cinema.filmFor({ title: 'The Hunger Games', year: 2012 })?.id === '49170666');
check('"Hocus Pocus" (1993) finds the kids club morning', cinema.filmFor({ title: 'Hocus Pocus', year: 1993 })?.id === '23210457');
check('but an old film is not a new one that shares its title', cinema.filmFor({ title: 'Digger', year: 1993 }) === null);
check('"The Doll" finds "Lalka (The Doll)"', cinema.filmFor({ title: 'The Doll', year: yearOfShow })?.id === '49236973');
check('"Dune: Part Three" finds the See It First preview', cinema.filmFor({ title: 'Dune: Part Three', year: yearOfShow })?.id === '49167973');
check('an announced film matches, with no showings yet',
  cinema.filmFor({ title: 'Clayface', year: yearOfShow })?.opens && cinema.showingsFor({ title: 'Clayface', year: yearOfShow }).length === 0);
check('a film the Savoy is not showing matches nothing', cinema.filmFor({ title: 'Paddington in Peru', year: 2024 }) === null);
const later = new Date(future.getTime() + 864e5 * 400);
check('showings that have been and gone are not offered', cinema.showingsFor({ title: 'Digger' }, later).length === 0);

mem.set('wn.cinema', JSON.stringify({ ...recent, fetchedAt: new Date(Date.now() - 6 * 864e5).toISOString(), checkedAt: Date.now() - 6 * 864e5 }));
/* A fresh import: cinema.js keeps the listings it has read. */
const stale = await import(`../src/cinema.js?stale`);
check('listings days old are not gone by: no times rather than wrong ones', stale.current() === null && stale.showingsFor({ title: 'Digger' }).length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nFailures:\n  ' + failures.join('\n  '));
  process.exit(1);
}

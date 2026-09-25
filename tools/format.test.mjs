/*
 * Pasted-list hygiene.
 *
 * A list copied out of Notes arrives with its bullets attached — "•\tThe Power"
 * — and six titles in a real 529-title library were stored, displayed and
 * exported that way. These cases are the line between stripping a marker and
 * mangling a title that happens to start like one.
 */
import { cleanTitleLine, looksNumberedList, stripListMarkers, releaseLabel, ymd, shiftDays } from '../src/format.js';

/* London, as the phones are: the date cases below are about BST. */
process.env.TZ = 'Europe/London';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}
const is = (name, got, want) => check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

console.log('\n─── the damage, exactly as it was stored ───');
is('a bullet and a tab', cleanTitleLine('•\tThe Power'), 'The Power');
is('with a colon in the title', cleanTitleLine('•\tRare Exports: A Christmas Tale'), 'Rare Exports: A Christmas Tale');

console.log('\n─── markers that are always markers ───');
is('a dash and a space', cleanTitleLine('- The Thing (1982)'), 'The Thing (1982)');
is('an asterisk', cleanTitleLine('  *  Sicario, 2015 '), 'Sicario, 2015');
is('an em dash', cleanTitleLine('— Hereditary'), 'Hereditary');
is('a markdown task box', cleanTitleLine('- [ ] Hereditary'), 'Hereditary');
is('a ticked task box', cleanTitleLine('- [x] Alien'), 'Alien');
is('a bullet with no space', cleanTitleLine('•Heat'), 'Heat');
is('a tab inside the title is tidied too', cleanTitleLine('The\tThing'), 'The Thing');

console.log('\n─── titles that only look like they start with one ───');
is('a hyphenated title', cleanTitleLine('X-Men'), 'X-Men');
is('a number that is the title', cleanTitleLine('12 Monkeys'), '12 Monkeys');
is('a year that is the title', cleanTitleLine('1917'), '1917');
is('a numbered title on its own is left alone', cleanTitleLine('9. Kompanie'), '9. Kompanie');
is('a dash with no space after it', cleanTitleLine('-30-'), '-30-');

console.log('\n─── numbered lists need their neighbours to agree ───');
check('two numbered lines are a list', looksNumberedList(['1. Alien', '2. Aliens']));
check('one is not', !looksNumberedList(['1. Alien', 'Aliens']));
const numbered = stripListMarkers('1. Alien\n2) Aliens\n3. Alien 3');
is('first', numbered[0], 'Alien');
is('second, with a bracket', numbered[1], 'Aliens');
is('a number inside the title survives', numbered[2], 'Alien 3');
is('a lone numbered line in a bulleted block keeps its number',
  stripListMarkers('• Heat\n9. Kompanie')[1], '9. Kompanie');

console.log('\n─── nothing in, nothing out ───');
is('null', cleanTitleLine(null), '');
is('a bare bullet', cleanTitleLine('•'), '');
is('whitespace', cleanTitleLine(' \t '), '');

console.log('\n─── when a film comes out ───');
{
  /* Thursday 24 September 2026, late evening in London (BST). */
  const now = new Date(2026, 8, 24, 23, 30);
  const L = (r) => releaseLabel(r, now);
  is('today, by the phone’s calendar even near midnight', ymd(now), '2026-09-24');
  is('days ahead cross the clocks going back', shiftDays(40, now), '2026-11-03');
  is('tomorrow', L({ cinema: '2026-09-25' }), 'In cinemas tomorrow');
  is('a UK cinema date', L({ cinema: '2026-11-13' }), 'In cinemas Fri 13 Nov');
  is('the digital date when that is first', L({ digital: '2026-10-09' }), 'On digital Fri 9 Oct');
  is('far off, with the year', L({ cinema: '2027-04-08' }), 'In cinemas Thu 8 Apr 2027');
  is('out today', L({ cinema: '2026-09-24' }), 'In cinemas today');
  is('out today at home', L({ digital: '2026-09-24' }), 'Out today');
  is('in cinemas, not yet at home', L({ cinema: '2026-09-04', digital: '2026-11-20' }), 'In cinemas now');
  is('in cinemas, no home date known', L({ cinema: '2026-09-04' }), 'In cinemas now');
  is('long in cinemas, home date coming', L({ cinema: '2026-05-01', digital: '2026-10-02' }), 'On digital Fri 2 Oct');
  is('just reached home', L({ cinema: '2026-08-01', digital: '2026-09-18' }), 'New');
  is('the list date when there is no UK one', L({ fallback: '2026-09-10' }), 'New');
  is('a UK date wins over the list date', L({ cinema: '2026-10-16', fallback: '2026-09-01' }), 'In cinemas Fri 16 Oct');
  is('nothing to say about an old film', L({ fallback: '1979-05-25' }), null);
  is('nor about an old cinema run', L({ cinema: '2025-01-10' }), null);
  is('nothing in, nothing out', L({}), null);
  is('a TMDB timestamp is read as its day', L({ cinema: '2026-09-25T00:00:00.000Z' }), 'In cinemas tomorrow');
  /* Just after midnight in BST it is still the previous day in UTC: a date
     taken from UTC would call today's film "tomorrow". */
  const early = new Date(2026, 8, 25, 0, 30);
  is('just after midnight, BST: today is the new day', ymd(early), '2026-09-25');
  is('so a film out today says today', releaseLabel({ cinema: '2026-09-25' }, early), 'In cinemas today');
  is('and counting days starts from it', shiftDays(0, new Date(2026, 9, 20, 0, 30)), '2026-10-20');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFailures:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }

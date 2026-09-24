/*
 * Pasted-list hygiene.
 *
 * A list copied out of Notes arrives with its bullets attached — "•\tThe Power"
 * — and six titles in a real 529-title library were stored, displayed and
 * exported that way. These cases are the line between stripping a marker and
 * mangling a title that happens to start like one.
 */
import { cleanTitleLine, looksNumberedList, stripListMarkers } from '../src/format.js';

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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nFailures:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }

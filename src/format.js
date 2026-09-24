/* Formatting helpers. Kept pure so they can be unit-tested without a DOM. */

export function runtime(mins, { long = false } = {}) {
  if (!mins || mins <= 0) return '';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (long) {
    if (!h) return `${m} min`;
    return m ? `${h} hr ${m} min` : `${h} hr`;
  }
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

export function rating(r) {
  if (r === null || r === undefined) return '';
  return Number(r).toFixed(1);
}

/** "2h 14m of your evening" style helper for the hero. */
export function commitment(mins) {
  if (!mins) return '';
  if (mins <= 95) return 'a short one';
  if (mins <= 130) return 'a normal evening';
  if (mins <= 165) return 'a long one';
  return 'clear the schedule';
}

export function relativeTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many || one + 's'}`;
}

/** Initials for the poster fallback: "The Dark Knight" -> "DK" */
export function initials(title) {
  const words = String(title || '')
    .replace(/^(the|a|an)\s+/i, '')
    .split(/[\s:–—-]+/)
    .filter((w) => /[a-z0-9]/i.test(w));
  if (!words.length) return '?';
  if (words.length === 1) {
    const w = words[0];
    return (w.length > 1 ? w.slice(0, 2) : w).toUpperCase();
  }
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** Deterministic hue from a title, so a film's fallback tile is always the same. */
export function titleHue(title) {
  let h = 0;
  const s = String(title || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** Two muted stops for the fallback gradient — desaturated so it never shouts. */
export function fallbackColors(title) {
  const hue = titleHue(title);
  return {
    a: `hsl(${hue} 16% 17%)`,
    b: `hsl(${(hue + 28) % 360} 20% 9%)`,
  };
}

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ── external links ── */

export function imdbUrl(item) {
  if (item.imdbId) return `https://www.imdb.com/title/${item.imdbId}/`;
  return `https://www.imdb.com/find/?q=${encodeURIComponent(item.title)}`;
}

export function trailerUrl(item) {
  const q = `${item.title} ${item.year || ''} trailer`.trim();
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
}

export function justWatchUrl(item) {
  return `https://www.justwatch.com/uk/search?q=${encodeURIComponent(item.title)}`;
}

/** The one-line subtitle used under titles throughout the app. */
export function metaLine(item, { showType = false } = {}) {
  const bits = [];
  if (item.year) bits.push(item.year);
  if (showType && item.type === 'tv') bits.push('Series');
  if (item.genre) bits.push(item.genre);
  const rt = runtime(item.runtime);
  if (rt) bits.push(rt);
  return bits.join(' · ');
}

/* ── pasted list hygiene ──
 * A list copied out of Notes, a blog post or a spreadsheet arrives carrying its
 * bullets: "•\tThe Power". Nothing downstream strips them, so the bullet became
 * part of the title — visible on every row, and baked into the backup. Cleaning
 * happens here, in one pure function, so the paste form, the by-hand form and
 * the repair pass on load all agree on what a marker is.
 */

/* Symbols that never open a real title, so no further evidence is needed.
   The trailing space is optional: "•Title" is just as much a bullet. */
const HARD_BULLET = /^[•·‣▪▫●◦⁃»›]+\s*/;
/* Punctuation that could be a bullet or could be a title's own first character,
   so a separating space is required: "- The Thing", never "-30-". */
const SOFT_BULLET = /^[-*+–—]\s+/;
/* Markdown task lists paste as "- [ ] Title"; the dash goes above, the box here. */
const TASK_BOX = /^\[[ xX✓]?\]\s*/;
/* "1." / "2)" / "03." — genuinely ambiguous, because a few real titles open
   with a number and a dot. Only stripped when the surrounding lines agree. */
const NUMBER_MARKER = /^\d{1,3}[.)]\s+/;

/**
 * One pasted line, minus its list marker and with its whitespace tidied.
 * `numbered` opts in to stripping "1." style markers — see looksNumberedList.
 */
export function cleanTitleLine(line, { numbered = false } = {}) {
  let s = String(line ?? '').replace(/\s+/g, ' ').trim();
  /* Loop, because "- [ ] Title" carries two markers and "•• Title" carries a
     doubled one. Three passes is far more than any real paste needs. */
  for (let i = 0; i < 3; i++) {
    const before = s;
    s = s.replace(HARD_BULLET, '').replace(SOFT_BULLET, '').replace(TASK_BOX, '');
    if (numbered) s = s.replace(NUMBER_MARKER, '');
    s = s.trim();
    if (s === before) break;
  }
  return s;
}

/**
 * True when at least two lines open with a number marker — the evidence that
 * makes stripping them safe. One line on its own is left alone, because a
 * lone "9. Kompanie" is more likely a title than a list of one.
 */
export function looksNumberedList(lines) {
  let n = 0;
  for (const line of lines || []) {
    if (NUMBER_MARKER.test(String(line ?? '').replace(/\s+/g, ' ').trim())) n += 1;
    if (n >= 2) return true;
  }
  return false;
}

/** Clean a whole pasted block, deciding the numbered question once for all of it. */
export function stripListMarkers(lines) {
  const rows = Array.isArray(lines) ? lines : String(lines ?? '').split('\n');
  const numbered = looksNumberedList(rows);
  return rows.map((line) => cleanTitleLine(line, { numbered }));
}

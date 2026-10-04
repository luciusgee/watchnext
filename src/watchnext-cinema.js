/*
 * The Savoy, Corby's listings, read from its own website.
 *
 * This file runs in two places. In a GitHub Action in your private sync
 * repo — copied there by the app as .github/watchnext-cinema.mjs (see
 * cinemaSender.js) — where it fetches the Savoy's pages a few times a day
 * and saves cinema/savoy-corby.json. And in the app, which uses only its
 * title helpers (normaliseTitle) to match the Savoy's films to yours. No
 * dependencies; Node 20 or later in the Action.
 *
 * How the site publishes its programme (SavoyCorby.dll, a Savoy Systems "TCS" site):
 *   * EVERY page embeds the whole on-sale programme as one JSON blob in the QuickBook widget:
 *       <script>\nvar Events = \n{"Events":[{ID,Title,Rating,Type,RunningTime,ImageURL,URL,Year,
 *         DateRangeOverride,Tags:[{Format}],Performances:[{ID,StartDate:'YYYY-MM-DD',StartTime:'HHMM',
 *         StartTimeAndNotes,Notes,AuditoriumName,IsSoldOut,IsOpenForSale,KC,SS,PB,SP,SB,DA,TC,RR,
 *         URL:'Booking?Booking=TSelectItems.waSelectItemsPrompt.TcsWebMenuItem_0.TcsWebTab_0.TcsPerformance_<id>.TcsSection_<id>'}]}]}
 *     It has every future performance (months ahead), so no date paging / CalendarBaseDate cookies.
 *     Each performance's URL opens seat selection for that showing — the "buy tickets" link.
 *   * Films announced but not yet on sale are NOT in that JSON. They only appear as server-rendered
 *     boxes on the Coming Soon page (Page?p=1&m=mm): <div id="Film_<id>" class="boxx ..."> with
 *     <h4 class="subtitle coming-soon">Opening Fri 9 Oct</h4> (no year, no certificate/runtime).
 *   * The film page (WhatsOn?f=<id>) has certificate + runtime ("120mins") for those.
 *   So one request (the Coming Soon page) gives the complete picture; film pages are optional extras.
 */

export const BASE = 'https://savoycorby.co.uk/SavoyCorby.dll/';
export const PAGES = {
  home: BASE + 'Home',
  whatsOn: BASE + 'WhatsOn',
  comingSoon: BASE + 'Page?p=1&m=mm',
  film: (id) => BASE + 'WhatsOn?f=' + encodeURIComponent(id),
};
const USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

// Performance flags in the JSON ("Y"/"N"), labels from the site's own "Event Key".
export const FLAG_TAGS = {
  KC: 'Kids Club',
  SS: 'Silver Screen',
  PB: 'Parent & Baby',
  SP: 'Supportive',
  SB: 'Subtitled',
  DA: 'Dolby Atmos',
  TC: 'Toddler Club',
  RR: 'Re-release',
};
const BOX_TAGS = { ...FLAG_TAGS }; // server-rendered boxes print the same codes in <span class="tag">

// Programme types (Events[].Type). From the WhatsOn page filter tabs; refreshed from it when an unknown id shows up.
export const PROGRAMME_TYPES = {
  293: 'Film',
  3194: 'Concerts',
  3796457: 'Exhibition on Screen',
  3659328: 'MET Opera',
  3796460: 'National Theatre',
  5391: 'Other Ballet',
  3192: 'Other Theatre',
  3796339: 'Royal Ballet & Opera',
  191272: 'Special Events',
};
const FILM_TYPE = 293;

// ---------------------------------------------------------------------------------------------
// Small text helpers

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', pound: '£', euro: '€', copy: '©', reg: '®',
  trade: '™', hellip: '…', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•',
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', aacute: 'á', agrave: 'à', acirc: 'â', auml: 'ä', aring: 'å',
  ccedil: 'ç', iacute: 'í', icirc: 'î', iuml: 'ï', ntilde: 'ñ', oacute: 'ó', ograve: 'ò', ocirc: 'ô', ouml: 'ö',
  oslash: 'ø', uacute: 'ú', ugrave: 'ù', ucirc: 'û', uuml: 'ü', szlig: 'ß', Eacute: 'É', Ouml: 'Ö', Uuml: 'Ü',
};

export function decodeEntities(s) {
  if (!s) return '';
  // Decode twice at most: the JSON sometimes carries "&amp;amp;"-style double escaping.
  let out = String(s);
  for (let i = 0; i < 2 && /&[#a-zA-Z0-9]+;/.test(out); i++) {
    out = out.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, e) => {
      if (e[0] === '#') {
        const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : m;
      }
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, e) ? NAMED_ENTITIES[e] : m;
    });
  }
  return out;
}

const stripTags = (s) => String(s || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]*>/g, ' ');
const textOf = (html) => decodeEntities(stripTags(html)).replace(/\s+/g, ' ').trim();
export const cleanTitle = (t) => decodeEntities(String(t || '')).replace(/\s+/g, ' ').trim();
const attr = (tag, name) => {
  const m = new RegExp('\\s' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i').exec(tag || '');
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? '').trim() : undefined;
};
const absUrl = (u) => {
  if (!u) return undefined;
  try { return new URL(u.trim(), BASE).href; } catch { return undefined; }
};

// ---------------------------------------------------------------------------------------------
// Dates (UK local)

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const WEEKDAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const pad2 = (n) => String(n).padStart(2, '0');
const isoDate = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;

/** Today's date in the UK as YYYY-MM-DD. */
export function ukToday(now = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(now)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}`;
}

/**
 * Parse a Savoy day label ("Opening Fri 9 Oct", "Mon 5 Oct", "9th October 2026") to YYYY-MM-DD.
 * The site omits the year; it is inferred as the occurrence nearest to `today` that is not more than
 * ~6 weeks in the past, preferring a year whose weekday matches the printed weekday.
 */
export function parseUkDayLabel(text, today = ukToday()) {
  if (!text) return undefined;
  const m = /(?:\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:,?\s+(\d{4}))?/i.exec(
    text,
  );
  if (!m) return undefined;
  const wd = m[1] ? WEEKDAYS[m[1].toLowerCase()] : undefined;
  const d = +m[2];
  const mo = MONTHS[m[3].toLowerCase()];
  const valid = (y) => {
    const dt = new Date(Date.UTC(y, mo - 1, d));
    return dt.getUTCMonth() === mo - 1 ? dt : null;
  };
  if (m[4]) {
    const dt = valid(+m[4]);
    return dt ? isoDate(+m[4], mo, d) : undefined;
  }
  const [ty, tm, td] = today.split('-').map(Number);
  const t0 = Date.UTC(ty, tm - 1, td);
  let cands = [ty - 1, ty, ty + 1]
    .map((y) => ({ y, dt: valid(y) }))
    .filter((c) => c.dt)
    .map((c) => ({ ...c, diff: (c.dt.getTime() - t0) / 86400000 }))
    .filter((c) => c.diff >= -45);
  if (wd !== undefined && cands.some((c) => c.dt.getUTCDay() === wd)) cands = cands.filter((c) => c.dt.getUTCDay() === wd);
  cands.sort((a, b) => Math.abs(a.diff) - Math.abs(b.diff));
  return cands[0] ? isoDate(cands[0].y, mo, d) : undefined;
}

/** First day of the next Fri-Thu cinema programme week after `today` (YYYY-MM-DD): the coming Friday, or a week on if today is Friday. */
export function nextProgrammeWeek(today = ukToday()) {
  const [y, m, d] = today.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + ((5 - t.getUTCDay() + 7) % 7 || 7));
  return t.toISOString().slice(0, 10);
}

function hhmm(startTime, startTimeAndNotes) {
  let m = /^(\d{1,2})(\d{2})$/.exec(String(startTime || '').trim());
  if (!m) m = /(\d{1,2})[:.](\d{2})/.exec(String(startTimeAndNotes || ''));
  if (!m) return undefined;
  const h = +m[1], mi = +m[2];
  return h < 30 && mi < 60 ? `${pad2(h)}:${m[2]}` : undefined; // allow 24:xx+ "late night" if ever used
}

// ---------------------------------------------------------------------------------------------
// Title normalisation for matching against a library (TMDB) title

const FMT =
  "2D|3D|Real ?D 3D|IMAX(?: 3D| 2D)?|4DX(?: 3D)?|Screen ?X|D-?BOX|Dolby(?: Atmos| Cinema| Vision)?|Atmos|HFR|70 ?mm|35 ?mm|4K(?: Restoration| Remaster(?:ed)?)?|" +
  'Subtitled|Subs|HOH|Hard of Hearing|S\\/?T|AD|Audio Described|Descriptive Subtitles|Relaxed(?: Screening)?|Autism[- ]Friendly|Sensory[- ]Friendly|' +
  "Dementia[- ]Friendly|Parent (?:and|&) Baby|Kids'? Club|Silver Screen|Toddler Club|Sing[- ]?a[- ]?long|Singalong|Re-?release|Encore|Live|Recorded|" +
  "Preview|Previews|Sneak Peek|Early Access|Early Screening|Advance Screening|Fan Event|Fan Screening|Director'?s Cut|Extended(?: Edition| Cut)?|" +
  'Remastered|Restored|Uncut|Anniversary|\\d+(?:st|nd|rd|th) Anniversary(?: Re-?release| Edition)?|Dubbed|English Dub|Original Version|' +
  'U|PG|12A?|15|18|R18|TBC|Cert(?:ificate)? ?(?:U|PG|12A?|15|18)|(?:19|20)\\d\\d';
const BRACKET_SUFFIX = new RegExp(`\\s*[\\(\\[]\\s*(?:${FMT})(?:\\s*[\\/,+&|-]\\s*(?:${FMT}))*\\s*[\\)\\]]\\s*$`, 'i');
const TRAILING_SUFFIXES = [
  /\s*[-:–—]?\s*(?:the\s+)?(?:IMAX|4DX|ScreenX|Dolby(?: Cinema)?)\s+experience$/i,
  /\s*[-:–—]?\s*(?:in\s+)?(?:Real ?D\s+)?(?:2D|3D|IMAX 3D|IMAX|4DX|ScreenX)$/i,
  /\s*[-:–—]?\s*(?:\d+(?:st|nd|rd|th)\s+)?anniversary(?:\s+(?:edition|re-?release|screening|celebration))?$/i,
  /\s*[-:–—]?\s*(?:see it first(?:\s+preview)?|preview(?:\s+screening)?|sneak peek|early access(?:\s+screening)?|advance screening|fan (?:event|screening))$/i,
  /\s*[-:–—]?\s*(?:encore(?:\s+screening)?|re-?release|rerelease|sing[- ]?a[- ]?long(?:\s+version)?|subtitled|(?:with\s+)?subtitles|relaxed screening|autism[- ]friendly(?:\s+screening)?)$/i,
  /\s*[-:–—]?\s*(?:director'?s cut|extended (?:edition|cut)|remastered|4k restoration|4k remaster(?:ed)?)$/i,
];
const LEADING_PREFIXES =
  /^(?:kids'?\s*club|silver\s*screen|parent\s*(?:and|&)\s*baby|toddler\s*club|autism\s*friendly|relaxed(?:\s+screening)?|supportive(?:\s+screening)?|subtitled|savoy\s+rewind|re-?release|preview|throwback|cult\s+classics?|classic\s+cinema|(?:\d+(?:st|nd|rd|th)\s+)?anniversary)\s*[:\-–—|]\s*/i;
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

/** Strip Savoy format/event suffixes and prefixes, keeping the display casing. "Avengers: Endgame Encore" -> "Avengers: Endgame". */
export function baseTitle(title) {
  let t = cleanTitle(title).replace(/[‘’`´]/g, "'").replace(/[“”]/g, '"');
  for (let i = 0; i < 6; i++) {
    const before = t;
    t = t.replace(LEADING_PREFIXES, '');
    t = t.replace(BRACKET_SUFFIX, '');
    for (const re of TRAILING_SUFFIXES) t = t.replace(re, '');
    t = t.replace(/\s*[-:–—|,]\s*$/, '').trim();
    if (t === before) break;
  }
  return t || cleanTitle(title);
}

/** Normalised comparison key: base title, ASCII-folded, lower case, punctuation-free, leading "the" dropped. */
export function normaliseTitle(title) {
  let t = baseTitle(title)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  t = t.replace(/\b(part|chapter|volume|vol|episode)\s+(one|two|three|four|five|six|seven|eight|nine|ten)\b/g, (m, w, n) => `${w} ${NUMBER_WORDS[n]}`);
  t = t.replace(/\bvol\b/g, 'volume');
  t = t.replace(/^(the|a|an)\s+/, '');
  return t.replace(/\s+/g, ' ').trim();
}

/** Extra keys worth trying: "Lalka (The Doll)" -> ["lalka", "doll"]. */
export function altTitleKeys(title) {
  const base = baseTitle(title);
  const keys = new Set();
  const m = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(base);
  if (m) {
    keys.add(normaliseTitle(m[1]));
    keys.add(normaliseTitle(m[2]));
  }

  const main = normaliseTitle(title);
  keys.delete(main);
  keys.delete('');
  return [...keys];
}

// ---------------------------------------------------------------------------------------------
// Parsers (pure; work on HTML strings so saved pages can be used as fixtures)

/** Extract `var Events = {...}` from any SavoyCorby.dll page. Returns the Events array or null. */
export function extractEventsJson(html) {
  if (!html) return null;
  const at = html.search(/var\s+Events\s*=/);
  if (at < 0) return null;
  const start = html.indexOf('{', at);
  if (start < 0) return null;
  // Brace-match, honouring JSON strings, so a "}" inside a synopsis cannot end the object early.
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < html.length; i++) {
    const c = html.charCodeAt(i);
    if (inStr) {
      if (esc) esc = false;
      else if (c === 92) esc = true; // backslash
      else if (c === 34) inStr = false; // "
      continue;
    }
    if (c === 34) inStr = true;
    else if (c === 123) depth++;
    else if (c === 125 && --depth === 0) { end = i + 1; break; }
    else if (c === 60 && html.startsWith('</script', i)) break;
  }
  if (end < 0) return null;
  try {
    const obj = JSON.parse(html.slice(start, end));
    return Array.isArray(obj?.Events) ? obj.Events : null;
  } catch {
    return null;
  }
}

/** Programme type labels from the WhatsOn page filter tabs. */
export function parseProgrammeTypes(html) {
  const out = {};
  for (const m of String(html || '').matchAll(/data-sort="programmetype"\s+data-sort-value="(\d+)"[^>]*>([^<]*)</g)) {
    out[+m[1]] = cleanTitle(m[2]);
  }
  return out;
}

function certificateFrom(s) {
  if (!s) return undefined;
  const txt = decodeEntities(String(s));
  const m = /BBFC Rating:\s*\(([^)]*)\)/i.exec(txt) || /rated\s*\(([^)]*)\)/i.exec(txt) || /bbfc\/\w+\/([A-Za-z0-9]+)\.png/i.exec(txt);
  if (!m) return undefined;
  const v = m[1].trim().toUpperCase();
  if (/TBC|TBA|^$/.test(v)) return undefined; // "12A TBC" is the site's placeholder for unrated events
  const c = /^(U|PG|12A|12|15|18|R18)$/.exec(v);
  return c ? c[1] : undefined;
}

/** Server-rendered film boxes (Coming Soon page and similar). */
export function parseFilmBoxes(html, today = ukToday()) {
  const src = String(html || '');
  const listAt = src.indexOf('id="whats-on-list"');
  if (listAt < 0) return [];
  const listEnd = (() => {
    const e = src.indexOf('</section>', listAt);
    return e < 0 ? src.length : e;
  })();
  const list = src.slice(listAt, listEnd);
  const parts = list.split(/(?=<div\s+id="Film_\d+")/).slice(1);
  const films = [];
  for (const part of parts) {
    const id = /^<div\s+id="Film_(\d+)"/.exec(part)?.[1];
    if (!id) continue;
    const titleM = /<h3\b[^>]*class="[^"]*film-title[^"]*"[^>]*>([\s\S]*?)<\/h3>/i.exec(part);
    const imgTag = /<img\b[^>]*class="[^"]*film-image[^"]*"[^>]*>/i.exec(part)?.[0];
    const linkTag = /<a\b[^>]*id="(?:ImageLink|TitleLink|MoreInfoButton)_\d+"[^>]*>/i.exec(part)?.[0];
    const openingM = /<h4\b[^>]*class="[^"]*coming-soon[^"]*"[^>]*>([\s\S]*?)<\/h4>/i.exec(part);
    const film = {
      id,
      title: cleanTitle(titleM ? textOf(titleM[1]) : attr(imgTag, 'alt')),
      poster: absUrl(attr(imgTag, 'src')),
      url: absUrl(attr(linkTag, 'href')) || PAGES.film(id),
      certificate: certificateFrom(/<div\b[^>]*class="rating-image"[^>]*>([\s\S]*?)<\/div>/i.exec(part)?.[1]),
      openingText: openingM ? textOf(openingM[1]) : undefined,
      showings: [],
    };
    if (film.openingText) film.opens = parseUkDayLabel(film.openingText, today);
    // Performances: <li class="performance"><span class="date">Mon 5 Oct</span> ... <a id="Performance_<id>" href=...><span class="time">18:00</span><span class="tag ...">SO</span></a>
    for (const li of part.matchAll(/<li\b[^>]*class="[^"]*\bperformance\b[^"]*"[^>]*>([\s\S]*?)<\/li>/gi)) {
      const dateText = textOf(/<span\b[^>]*class="[^"]*\bdate\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(li[1])?.[1] || '');
      const date = parseUkDayLabel(dateText, today);
      for (const a of li[1].matchAll(/<a\b([^>]*\bid="Performance_(\d+)"[^>]*)>([\s\S]*?)<\/a>/gi)) {
        const time = hhmm('', textOf(/<span\b[^>]*class="[^"]*\btime\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(a[3])?.[1] || ''));
        const codes = [...a[3].matchAll(/<span\b[^>]*class="[^"]*\btag\b[^"]*"[^>]*>([\s\S]*?)<\/span>/gi)].map((t) => textOf(t[1]).toUpperCase());
        if (!date || !time) continue;
        const s = { id: a[2], date, time, tags: codes.map((c) => BOX_TAGS[c]).filter(Boolean), book: absUrl(attr('<a ' + a[1] + '>', 'href')) };
        if (codes.includes('SO')) s.soldOut = true;
        film.showings.push(s);
      }
    }
    films.push(film);
  }
  return films;
}

/** A film page (WhatsOn?f=<id>): title, certificate, runtime, opening line, poster. */
export function parseFilmPage(html, today = ukToday()) {
  const src = String(html || '');
  const contentAt = src.search(/<div\s+id="Content"/);
  const asideAt = contentAt >= 0 ? src.indexOf('id="Aside"', contentAt) : -1;
  const content = contentAt < 0 ? src : src.slice(contentAt, asideAt > contentAt ? asideAt : undefined);
  const h1 = /<h1\b[^>]*class="title"[^>]*>([\s\S]*?)<\/h1>/i.exec(content);
  const info = /<ul\b[^>]*class="[^"]*programme-info[^"]*"[^>]*>([\s\S]*?)<\/ul>/i.exec(content)?.[1] || '';
  const runtime = /(\d{2,3})\s*min/i.exec(textOf(info))?.[1];
  const openingM = /<h4\b[^>]*class="[^"]*coming-soon[^"]*"[^>]*>([\s\S]*?)<\/h4>/i.exec(content);
  const ogImage = /<meta\s+property="og:image"\s+content="([^"]*)"/i.exec(src)?.[1];
  const out = {
    // The h1 carries the rating as an <img> or, for unrated films, <span class="film-rating">rated (12A TBC)</span>.
    title: h1 ? cleanTitle(textOf(h1[1].replace(/<img[\s\S]*?>/gi, '').replace(/<span\b[^>]*film-rating[^>]*>[\s\S]*?<\/span>/gi, ''))) : undefined,
    certificate: certificateFrom(info) || certificateFrom(h1?.[1]),
    runtime: runtime ? +runtime : undefined,
    poster: absUrl(ogImage),
    openingText: openingM ? textOf(openingM[1]) : undefined,
  };
  if (out.openingText) out.opens = parseUkDayLabel(out.openingText, today);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Assembly

function showingFromPerformance(p, event) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(p.StartDate || '').trim()) ? p.StartDate.trim() : undefined;
  const time = hhmm(p.StartTime, p.StartTimeAndNotes);
  if (!date || !time || p.ID == null) return null;
  const tags = [];
  for (const [flag, label] of Object.entries(FLAG_TAGS)) if (String(p[flag]).toUpperCase() === 'Y') tags.push(label);
  const note = cleanTitle(p.Notes);
  if (/relaxed|autism|sensory/i.test(note) && !tags.includes('Relaxed')) tags.push('Relaxed');
  // Format hints: the (currently empty) Tags[].Format field and the title itself, e.g. "Avatar (3D)".
  const fmtSrc = [...(event.Tags || []).map((t) => t?.Format || ''), event.Title || '', note].join(' ');
  for (const f of ['3D', 'IMAX', '4DX', '2D']) if (new RegExp(`\\b${f}\\b`, 'i').test(fmtSrc) && !tags.includes(f)) tags.push(f);
  const book = absUrl(p.URL) || absUrl(event.URL);
  const s = { id: String(p.ID), date, time, screen: cleanTitle(p.AuditoriumName) || undefined, tags, book };
  const same = (a, b) => a.toLowerCase().replace(/&/g, 'and').replace(/[^a-z]/g, '') === b.toLowerCase().replace(/&/g, 'and').replace(/[^a-z]/g, '');
  if (note && !tags.some((t) => same(t, note))) s.note = note;
  if (String(p.IsSoldOut).toUpperCase() === 'Y') s.soldOut = true;
  if (p.IsOpenForSale === false) s.onSale = false;
  try { if (new URL(book).hostname !== new URL(BASE).hostname) s.external = true; } catch {}
  return s;
}

function filmFromEvent(e, typeLabels, today) {
  const title = cleanTitle(e.Title);
  const year = /^\s*((?:19|20)\d\d)\s*$/.exec(String(e.Year || ''))?.[1] || /\(((?:19|20)\d\d)\)\s*$/.exec(title)?.[1];
  const runtime = Number(e.RunningTime);
  const type = Number(e.Type);
  const f = {
    id: String(e.ID),
    title,
    key: normaliseTitle(title),
    year: year ? +year : undefined,
    certificate: certificateFrom(e.Rating),
    runtime: runtime > 0 && runtime < 1000 ? runtime : undefined,
    poster: absUrl(e.ImageURL),
    url: absUrl(e.URL) || PAGES.film(e.ID),
    category: typeLabels[type] || (Number.isFinite(type) ? `Type ${type}` : undefined),
    event: Number.isFinite(type) ? type !== FILM_TYPE : undefined,
    showings: [],
  };
  const override = cleanTitle(e.DateRangeOverride);
  if (/opening|opens|from|release/i.test(override)) {
    f.opensText = override;
    f.opens = parseUkDayLabel(override, today);
  }
  return f;
}

const cmpShow = (a, b) => (a.date + a.time).localeCompare(b.date + b.time) || a.id.localeCompare(b.id);

function finaliseFilm(f) {
  const seen = new Set();
  f.showings = f.showings.filter((s) => s && !seen.has(s.id) && seen.add(s.id)).sort(cmpShow);
  const alt = altTitleKeys(f.title);
  if (alt.length) f.altKeys = alt;
  const out = {};
  for (const k of ['id', 'title', 'key', 'altKeys', 'year', 'certificate', 'runtime', 'poster', 'url', 'category', 'event', 'comingSoon', 'opens', 'opensText', 'showings']) {
    if (f[k] !== undefined && f[k] !== '' && f[k] !== null) out[k] = f[k];
  }
  return out;
}

/** Ids of Coming Soon films that have no on-sale performances (the only ones a film page adds anything for). */
export function comingSoonOnlyIds(comingSoonHtml, events, today = ukToday()) {
  const inJson = new Set((events || []).map((e) => String(e.ID)));
  return parseFilmBoxes(comingSoonHtml, today).filter((b) => !inJson.has(b.id)).map((b) => b.id);
}

/**
 * Pure assembly from saved HTML. `filmPages` maps film id -> film page HTML (optional).
 * `previous` is an earlier fetchSavoy() result; its certificate/runtime are reused for coming-soon films.
 */
export function parseSavoy({ comingSoonHtml, whatsOnHtml, homeHtml, filmPages = {}, previous = null, now = new Date() } = {}) {
  const today = ukToday(now);
  const events = extractEventsJson(comingSoonHtml) || extractEventsJson(whatsOnHtml) || extractEventsJson(homeHtml);
  if (!events) throw new Error('Savoy: could not find the "var Events = {...}" programme JSON');
  // A cinema always has something on sale: an empty programme means a broken or maintenance page, and
  // failing here keeps the last good JSON instead of replacing it with an empty listing.
  if (!events.some((e) => (e?.Performances || []).length)) throw new Error('Savoy: the programme JSON has no showings');
  const typeLabels = { ...PROGRAMME_TYPES, ...parseProgrammeTypes(whatsOnHtml) };
  const prevById = new Map((previous?.films || []).map((f) => [String(f.id), f]));

  const films = new Map();
  for (const e of events) {
    if (e?.ID == null) continue;
    const id = String(e.ID);
    const f = films.get(id) || filmFromEvent(e, typeLabels, today);
    for (const p of e.Performances || []) f.showings.push(showingFromPerformance(p, e));
    films.set(id, f);
  }

  // Coming Soon page: flags films as coming soon and adds announced films that are not on sale yet.
  for (const b of parseFilmBoxes(comingSoonHtml, today)) {
    let f = films.get(b.id);
    if (!f) {
      f = { id: b.id, title: b.title, key: normaliseTitle(b.title), poster: b.poster, url: b.url, certificate: b.certificate, showings: b.showings };
      const yr = /\(((?:19|20)\d\d)\)\s*$/.exec(b.title)?.[1];
      if (yr) f.year = +yr;
      films.set(b.id, f);
    }
    f.comingSoon = true;
    f.poster ||= b.poster;
    if (b.opens) f.opens = b.opens;
    if (b.openingText && !b.opens) f.opensText = b.openingText;
  }

  // Film pages / previous run: certificate + runtime for films the JSON does not cover.
  for (const f of films.values()) {
    const page = filmPages[f.id] ? parseFilmPage(filmPages[f.id], today) : null;
    const prev = prevById.get(f.id);
    if (page) {
      f.certificate ||= page.certificate;
      f.runtime ||= page.runtime;
      f.poster ||= page.poster;
      if (!f.opens && page.opens) f.opens = page.opens;
    } else if (prev) {
      f.certificate ||= prev.certificate;
      f.runtime ||= prev.runtime;
    }
  }

  // `opens` = the first day the film is on at the Savoy (UK date).
  //  1. An "Opening Fri 9 Oct" line (Coming Soon box / film page, set above) always wins.
  //  2. Else an earlier run's `opens` that is today or in the past: the film has opened, and the showings
  //     before now have dropped out of the listing, so the first showing left would creep forward a day at
  //     a time. (A future `opens` from an earlier run is not trusted: the current listing is.)
  //  3. Else the first showing, when the film is on Coming Soon, or when it has no showings left in the
  //     current Fri-Thu programme week (so it is on sale ahead of its run: next Friday's new releases,
  //     previews, one-off events) and the previous run did not list it with an earlier showing that has
  //     since been played (one still in the future that vanished was moved, not played). "First
  //     showing after today" alone is not enough: in the evening a film that has run for weeks has nothing
  //     left until tomorrow, and on a Thursday night a film carrying on has nothing left until Friday.
  //  An "Opening ..." line with no readable date (e.g. "Opening Soon") is kept as `opensText` instead.
  const nextWeek = nextProgrammeWeek(today);
  for (const f of films.values()) {
    if (!f.opens && !f.opensText) {
      const first = f.showings.filter(Boolean).map((s) => s.date).sort()[0];
      const prev = prevById.get(f.id);
      const prevOpens = prev?.opens;
      const prevFirst = (prev?.showings || []).map((s) => s?.date).filter(Boolean).sort()[0];
      if (/^\d{4}-\d{2}-\d{2}$/.test(prevOpens || '') && prevOpens <= today && (!first || prevOpens <= first)) f.opens = prevOpens;
      else if (first && (f.comingSoon || (first >= nextWeek && !(prevFirst && prevFirst < first && prevFirst <= today)))) f.opens = first;
    }
    if (f.opens) delete f.opensText;
  }

  const list = [...films.values()].map(finaliseFilm);
  const firstAt = (f) => (f.showings[0] ? f.showings[0].date + 'T' + f.showings[0].time : (f.opens || '9999-12-31') + 'T99:99');
  list.sort((a, b) => firstAt(a).localeCompare(firstAt(b)) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  return { cinema: 'Savoy Corby', url: PAGES.whatsOn, fetchedAt: now.toISOString(), films: list };
}

// ---------------------------------------------------------------------------------------------
// Network

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getHtml(fetchImpl, url, { retries = 1, timeoutMs = 45000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-GB,en;q=0.9' },
        redirect: 'follow',
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(4000);
    }
  }
  throw lastErr;
}

/**
 * Fetch the Savoy Corby programme.
 * Requests: 1 (Coming Soon page, which carries the full programme JSON too) + WhatsOn only if needed
 * + one film page per announced-but-not-on-sale film not already known from `previous` (max `maxDetails`).
 */
export async function fetchSavoy({
  fetch = globalThis.fetch,
  now = undefined,
  previous = null,
  details = true,
  maxDetails = 20,
  delayMs = 500,
  onPage = null, // (name, url, html) => void, e.g. to save fixtures
} = {}) {
  if (typeof fetch !== 'function') throw new Error('fetchSavoy: no fetch implementation (Node 18+ required)');
  const pages = {};
  const get = async (name, url) => {
    const html = await getHtml(fetch, url);
    pages[name] = html;
    if (onPage) await onPage(name, url, html);
    return html;
  };

  const comingSoonHtml = await get('comingsoon', PAGES.comingSoon);
  let events = extractEventsJson(comingSoonHtml);
  let whatsOnHtml;
  const unknownType = (events || []).some((e) => !(Number(e.Type) in PROGRAMME_TYPES));
  if (!events || unknownType) {
    await sleep(delayMs);
    whatsOnHtml = await get('whatson', PAGES.whatsOn);
    events ||= extractEventsJson(whatsOnHtml);
  }

  const filmPages = {};
  if (details && events) {
    const today = ukToday(now || new Date());
    const prevById = new Map((previous?.films || []).map((f) => [String(f.id), f]));
    const want = comingSoonOnlyIds(comingSoonHtml, events, today).filter((id) => {
      const p = prevById.get(id);
      return !(p && p.runtime); // already known from an earlier run
    });
    for (const id of want.slice(0, maxDetails)) {
      await sleep(delayMs);
      try {
        filmPages[id] = await get('film-' + id, PAGES.film(id));
      } catch (err) {
        console.error(`savoy: film page ${id} failed: ${err.message}`);
      }
    }
  }

  return parseSavoy({ comingSoonHtml, whatsOnHtml, filmPages, previous, now: now || new Date() });
}


// ---------------------------------------------------------------------------------------------
// The Action: read the last listings from the repo, fetch new ones, save them if anything changed.

export const LISTINGS_PATH = 'cinema/savoy-corby.json';

/** The same listings, apart from when they were fetched. */
export function sameListings(a, b) {
  const strip = (x) => JSON.stringify({ ...(x || {}), fetchedAt: undefined });
  return !!a && !!b && strip(a) === strip(b);
}

/**
 * One run of the Action. Never fails the run over the Savoy's site being down
 * or changed: the last good listings stay in the repo, a warning says why,
 * and the app carries on with what it has (and stops showing times once they
 * are a few days old). A failed run would email you; a warning does not.
 */
export async function runAction({ env = process.env, fetch = globalThis.fetch, log = console.log } = {}) {
  const api = env.GITHUB_API_URL || 'https://api.github.com';
  const url = `${api}/repos/${env.GITHUB_REPOSITORY}/contents/${LISTINGS_PATH}`;
  const headers = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${env.GITHUB_TOKEN}`,
    'x-github-api-version': '2022-11-28',
    'user-agent': 'watchnext-cinema',
  };
  const read = async () => {
    const res = await fetch(url, { headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub said ${res.status} reading ${LISTINGS_PATH}`);
    const body = await res.json();
    return { sha: body.sha, text: Buffer.from(body.content || '', 'base64').toString('utf8') };
  };

  let held = await read();
  let previous = null;
  try {
    previous = held ? JSON.parse(held.text) : null;
  } catch {
    previous = null;
  }

  let result;
  try {
    result = await fetchSavoy({ fetch, previous });
  } catch (err) {
    log(`::warning::Could not read the Savoy's listings (${err?.message || err}). Keeping the last ones.`);
    return { changed: false, error: String(err?.message || err) };
  }
  const showings = result.films.reduce((n, f) => n + f.showings.length, 0);
  log(`savoy: ${result.films.length} films, ${showings} showings`);
  if (sameListings(previous, result)) {
    log('savoy: no change');
    return { changed: false };
  }

  const content = Buffer.from(JSON.stringify(result) + '\n').toString('base64');
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      method: 'PUT',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: `Savoy listings: ${result.films.length} films, ${showings} showings`,
        content,
        ...(held ? { sha: held.sha } : {}),
      }),
    });
    if (res.ok) return { changed: true, films: result.films.length, showings };
    /* A phone wrote at the same moment: read the file's new sha and go again. */
    if (res.status === 409 || res.status === 422) {
      held = await read();
      continue;
    }
    throw new Error(`GitHub said ${res.status} saving ${LISTINGS_PATH}`);
  }
  throw new Error(`Could not save ${LISTINGS_PATH}: it kept changing underneath.`);
}

// ---------------------------------------------------------------------------------------------
// Run directly: as the Action (GITHUB_ACTIONS is set), or by hand:
//   node watchnext-cinema.mjs [--prev previous.json] [--raw dir] [--no-details] [--compact] > out.json
//   node watchnext-cinema.mjs --from dir [--now ISO]   (re-parse saved pages: comingsoon.html, whatson.html?, film-<id>.html)

async function main(argv) {
  const { readFile, writeFile, mkdir, readdir } = await import('node:fs/promises');
  const path = await import('node:path');
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  let previous = null;
  const prevPath = arg('--prev');
  if (prevPath) {
    try { previous = JSON.parse(await readFile(prevPath, 'utf8')); } catch (err) { console.error(`savoy: ignoring --prev (${err.message})`); }
  }
  const indent = argv.includes('--compact') ? 0 : 2;
  let result;
  const from = arg('--from');
  if (from) {
    const read = (f) => readFile(path.join(from, f), 'utf8').catch(() => undefined);
    const filmPages = {};
    for (const f of await readdir(from)) {
      const m = /^film-(\d+)\.html$/.exec(f);
      if (m) filmPages[m[1]] = await read(f);
    }
    const nowArg = arg('--now');
    result = parseSavoy({
      comingSoonHtml: await read('comingsoon.html'),
      whatsOnHtml: await read('whatson.html'),
      homeHtml: await read('home.html'),
      filmPages,
      previous,
      now: nowArg ? new Date(nowArg) : new Date(),
    });
  } else {
    const rawDir = arg('--raw');
    if (rawDir) await mkdir(rawDir, { recursive: true });
    result = await fetchSavoy({
      previous,
      details: !argv.includes('--no-details'),
      onPage: rawDir ? (name, _url, html) => writeFile(path.join(rawDir, name + '.html'), html) : null,
    });
  }
  const n = result.films.reduce((a, f) => a + f.showings.length, 0);
  console.error(`savoy: ${result.films.length} films, ${n} showings`);
  process.stdout.write(JSON.stringify(result, null, indent) + '\n');
}

/* Only when Node runs this file itself — never in the app, and never when a
   test imports it. No top-level await, so the app's import stays simple. */
if (typeof process !== 'undefined' && process.versions?.node && process.argv?.[1]) {
  Promise.all([import('node:url'), import('node:fs')])
    .then(([{ pathToFileURL }, { realpathSync }]) => {
      if (import.meta.url !== pathToFileURL(realpathSync(process.argv[1])).href) return;
      return process.env.GITHUB_ACTIONS ? runAction() : main(process.argv.slice(2));
    })
    .catch((err) => {
      console.error('savoy: ' + (err?.stack || err));
      process.exit(1);
    });
}

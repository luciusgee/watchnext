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

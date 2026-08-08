/*
 * Icon set — 24x24 grid, 1.6 stroke, round caps/joins.
 * Drawn as a single coherent family so nothing reads as clip-art.
 * Every glyph inherits currentColor.
 */

const P = {
  /* ── navigation ── */
  tonight:
    '<path d="M4 11.2 12 4.5l8 6.7"/><path d="M6.2 9.6V19a1 1 0 0 0 1 1h9.6a1 1 0 0 0 1-1V9.6"/><path d="M10.4 20v-5.1h3.2V20"/>',
  discover:
    '<rect x="3.4" y="5.2" width="12.2" height="15.4" rx="2.2"/><path d="M17.6 7.4l2.1.75a1.9 1.9 0 0 1 1.13 2.42l-3.1 8.6"/>',
  library:
    '<rect x="3.2" y="4.4" width="4.6" height="15.2" rx="1.4"/><rect x="9.6" y="4.4" width="4.6" height="15.2" rx="1.4"/><path d="M16.8 6.3l2.6-.72a1.3 1.3 0 0 1 1.6.9l3 11.3"/>',
  ask:
    '<path d="M12 3.6l1.9 4.9 4.9 1.9-4.9 1.9L12 17.2l-1.9-4.9-4.9-1.9 4.9-1.9z"/><path d="M18.4 15.4l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',

  /* ── chrome ── */
  settings:
    '<circle cx="12" cy="12" r="3.1"/><path d="M19.5 14.6a1.5 1.5 0 0 0 .3 1.65l.05.05a1.8 1.8 0 1 1-2.55 2.55l-.05-.05a1.5 1.5 0 0 0-1.65-.3 1.5 1.5 0 0 0-.9 1.37v.13a1.8 1.8 0 0 1-3.6 0v-.07a1.5 1.5 0 0 0-.98-1.37 1.5 1.5 0 0 0-1.65.3l-.05.05a1.8 1.8 0 1 1-2.55-2.55l.05-.05a1.5 1.5 0 0 0 .3-1.65 1.5 1.5 0 0 0-1.37-.9h-.13a1.8 1.8 0 0 1 0-3.6h.07a1.5 1.5 0 0 0 1.37-.98 1.5 1.5 0 0 0-.3-1.65l-.05-.05a1.8 1.8 0 1 1 2.55-2.55l.05.05a1.5 1.5 0 0 0 1.65.3h.07a1.5 1.5 0 0 0 .9-1.37v-.13a1.8 1.8 0 0 1 3.6 0v.07a1.5 1.5 0 0 0 .9 1.37 1.5 1.5 0 0 0 1.65-.3l.05-.05a1.8 1.8 0 1 1 2.55 2.55l-.05.05a1.5 1.5 0 0 0-.3 1.65v.07a1.5 1.5 0 0 0 1.37.9h.13a1.8 1.8 0 0 1 0 3.6h-.07a1.5 1.5 0 0 0-1.37.9z"/>',
  plus: '<path d="M12 5.2v13.6"/><path d="M5.2 12h13.6"/>',
  close: '<path d="M6.4 6.4l11.2 11.2"/><path d="M17.6 6.4L6.4 17.6"/>',
  back: '<path d="M14.5 5.5 8 12l6.5 6.5"/>',
  chevronRight: '<path d="M9.5 5.5 16 12l-6.5 6.5"/>',
  chevronDown: '<path d="M5.5 9.5 12 16l6.5-6.5"/>',
  search: '<circle cx="11" cy="11" r="6.4"/><path d="M15.7 15.7 20.4 20.4"/>',
  check: '<path d="M5 12.6l4.6 4.6L19 7.2"/>',
  refresh:
    '<path d="M20 11.6a8 8 0 1 0-.62 4.1"/><path d="M20.4 5.6v5.2h-5.2"/>',
  filter: '<path d="M4.4 6.6h15.2"/><path d="M7.2 12h9.6"/><path d="M10 17.4h4"/>',
  undo: '<path d="M4.4 9.2h9.4a5.4 5.4 0 1 1 0 10.8H8"/><path d="M8 4.6 3.6 9.2 8 13.8"/>',

  /* ── object / state ── */
  bookmark: '<path d="M6.6 4.6h10.8a1 1 0 0 1 1 1v14.2L12 15.9l-6.4 3.9V5.6a1 1 0 0 1 1-1z"/>',
  bookmarkFill:
    '<path d="M6.6 4.6h10.8a1 1 0 0 1 1 1v14.2L12 15.9l-6.4 3.9V5.6a1 1 0 0 1 1-1z" fill="currentColor" stroke-linejoin="round"/>',
  eye: '<path d="M2.4 12S6 5.6 12 5.6 21.6 12 21.6 12 18 18.4 12 18.4 2.4 12 2.4 12z"/><circle cx="12" cy="12" r="2.9"/>',
  eyeOff:
    '<path d="M9.9 5.9A8.9 8.9 0 0 1 12 5.6c6 0 9.6 6.4 9.6 6.4a17 17 0 0 1-2.5 3.4"/><path d="M6.3 7.7A17 17 0 0 0 2.4 12s3.6 6.4 9.6 6.4a8.7 8.7 0 0 0 3.9-.9"/><path d="M10 10.1a2.9 2.9 0 0 0 4 4"/><path d="M4.6 4.6l14.8 14.8"/>',
  download: '<path d="M12 4.4v10.2"/><path d="M7.6 10.6 12 15l4.4-4.4"/><path d="M4.6 17.2v1.4a1.4 1.4 0 0 0 1.4 1.4h12a1.4 1.4 0 0 0 1.4-1.4v-1.4"/>',
  drive: '<rect x="3.4" y="4.6" width="17.2" height="14.8" rx="2"/><path d="M8.2 4.6v5.2h7.6V4.6"/><path d="M7.4 19.4v-4.6h9.2v4.6"/>',
  trash:
    '<path d="M4.6 6.8h14.8"/><path d="M9.4 6.8V5.4a1.4 1.4 0 0 1 1.4-1.4h2.4a1.4 1.4 0 0 1 1.4 1.4v1.4"/><path d="M6.6 6.8l.8 12a1.4 1.4 0 0 0 1.4 1.3h6.4a1.4 1.4 0 0 0 1.4-1.3l.8-12"/><path d="M10.4 10.6v5.6"/><path d="M13.6 10.6v5.6"/>',
  star: '<path d="M12 4.2l2.42 4.9 5.42.79-3.92 3.82.93 5.4L12 16.56l-4.85 2.55.93-5.4L4.16 9.89l5.42-.79z"/>',
  starFill:
    '<path d="M12 4.2l2.42 4.9 5.42.79-3.92 3.82.93 5.4L12 16.56l-4.85 2.55.93-5.4L4.16 9.89l5.42-.79z" fill="currentColor" stroke-linejoin="round"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7.4V12l3.1 1.9"/>',
  calendar:
    '<rect x="3.6" y="5.4" width="16.8" height="15" rx="2"/><path d="M3.6 10h16.8"/><path d="M8.2 3.4v3.4"/><path d="M15.8 3.4v3.4"/>',
  play: '<path d="M8.4 5.6 18.6 12 8.4 18.4z"/>',
  playFill: '<path d="M8.4 5.6 18.6 12 8.4 18.4z" fill="currentColor" stroke-linejoin="round"/>',
  external: '<path d="M13.4 4.6h6v6"/><path d="M19.4 4.6 11 13"/><path d="M18 14.2v4.2a1.4 1.4 0 0 1-1.4 1.4H5.6a1.4 1.4 0 0 1-1.4-1.4V7.4A1.4 1.4 0 0 1 5.6 6h4.2"/>',
  skip: '<path d="M15.2 5.6 8.8 12l6.4 6.4"/><path d="M8.8 5.6v12.8"/>',
  info: '<circle cx="12" cy="12" r="8.2"/><path d="M12 11.2v5"/><path d="M12 8.1h.01"/>',
  warning:
    '<path d="M10.7 4.5 2.9 17.8a1.5 1.5 0 0 0 1.3 2.2h15.6a1.5 1.5 0 0 0 1.3-2.2L13.3 4.5a1.5 1.5 0 0 0-2.6 0z"/><path d="M12 9.4v4.2"/><path d="M12 17h.01"/>',
  tv: '<rect x="2.8" y="6.6" width="18.4" height="12.6" rx="2"/><path d="M8 3.4 12 6.6l4-3.2"/>',
  film: '<rect x="3.2" y="4.4" width="17.6" height="15.2" rx="2"/><path d="M7.6 4.4v15.2"/><path d="M16.4 4.4v15.2"/><path d="M3.2 12h17.6"/><path d="M3.2 8.2h4.4"/><path d="M3.2 15.8h4.4"/><path d="M16.4 8.2h4.4"/><path d="M16.4 15.8h4.4"/>',
  shuffle:
    '<path d="M17.6 4.8 20.8 8l-3.2 3.2"/><path d="M17.6 12.8 20.8 16l-3.2 3.2"/><path d="M3.2 8h3.4a4 4 0 0 1 3.3 1.8l4 6.4a4 4 0 0 0 3.3 1.8h3.6"/><path d="M3.2 16h3.4a4 4 0 0 0 3.3-1.8l.7-1.1"/><path d="M14.2 9.9l.4-.7A4 4 0 0 1 17.9 7.4h2.9"/>',
  sliders:
    '<path d="M4.4 7.4h9.2"/><path d="M17.6 7.4h2"/><path d="M4.4 16.6h2.4"/><path d="M10.8 16.6h8.8"/><circle cx="15.6" cy="7.4" r="2.1"/><circle cx="8.8" cy="16.6" r="2.1"/>',
  send: '<path d="M20.4 3.6 3.8 10.2a.6.6 0 0 0 .05 1.12l6.5 2.3 2.3 6.5a.6.6 0 0 0 1.12.05z"/><path d="M20.4 3.6 10.35 13.62"/>',
  upload: '<path d="M12 15.4V5.2"/><path d="M7.6 9.2 12 4.8l4.4 4.4"/><path d="M4.6 17.2v1.4a1.4 1.4 0 0 0 1.4 1.4h12a1.4 1.4 0 0 0 1.4-1.4v-1.4"/>',
  sparkle: '<path d="M12 3.6l1.9 4.9 4.9 1.9-4.9 1.9L12 17.2l-1.9-4.9-4.9-1.9 4.9-1.9z"/>',
  grid: '<rect x="3.8" y="3.8" width="7" height="7" rx="1.6"/><rect x="13.2" y="3.8" width="7" height="7" rx="1.6"/><rect x="3.8" y="13.2" width="7" height="7" rx="1.6"/><rect x="13.2" y="13.2" width="7" height="7" rx="1.6"/>',
  rows: '<path d="M4 6.4h16"/><path d="M4 12h16"/><path d="M4 17.6h16"/>',
};

/** Returns an SVG string. size in px, optional extra class. */
export function icon(name, size = 22, cls = '') {
  const d = P[name];
  if (!d) return '';
  return (
    `<svg class="ic${cls ? ' ' + cls : ''}" width="${size}" height="${size}" viewBox="0 0 24 24" ` +
    `fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" ` +
    `stroke-linejoin="round" aria-hidden="true" focusable="false">${d}</svg>`
  );
}

/** Returns a real SVGElement (for when you need a node, not a string). */
export function iconEl(name, size = 22, cls = '') {
  const tpl = document.createElement('template');
  tpl.innerHTML = icon(name, size, cls);
  return tpl.content.firstElementChild;
}

export const iconNames = Object.keys(P);

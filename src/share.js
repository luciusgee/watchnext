/*
 * Sending someone a shelf.
 *
 * A list of films, compressed into the fragment of a URL. The fragment is the
 * one part of a URL a browser never transmits, so this shares a library without
 * a server, an account, or a byte leaving the sender's phone — the same
 * property the rest of the app has, kept rather than traded away.
 *
 * This is what is left of "shared watch lists" after the evidence: co-edited
 * lists need two people with the app on day one, which an app with one user
 * does not have, and shared mutable state needs a backend, which fails the
 * only maintenance test that matters here. A one-way link needs neither. The
 * recipient does not need the app, an account, or a key — they get a web page.
 *
 * Format, versioned so a future change is detectable rather than a crash:
 *
 *   #l=1.<base64url(deflate-raw(payload))>
 *
 *   payload  = record \x1e record \x1e …
 *   record   = title \x1f year \x1f quality \x1f watched
 *
 * Those two separators are the ASCII record and unit separators. Neither can
 * appear in a film title, which is why they are used: no escaping, therefore no
 * escaping bugs, therefore no title with an apostrophe or a pipe in it quietly
 * splitting a record in half.
 *
 * Titles rather than IMDb ids, despite ids being four times smaller. Every user
 * brings their own metadata key, so a recipient without one would resolve an id
 * to nothing and see an empty page — failing for exactly the person this exists
 * to reach. A third of the starter library has no id at all.
 */

const PREFIX = '#l=1.';

/* A link nobody can send is not a share. 100 titles is roughly 2,000 characters
   after compression, which is inside every published URL limit and well inside
   the unpublished ones in messaging apps. */
export const MAX_TITLES = 100;

const RS = '\x1e';
const US = '\x1f';

export function canShare() {
  return typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
}

async function squeeze(text, mode) {
  const Stream = mode === 'in' ? CompressionStream : DecompressionStream;
  const stream = new Blob([text]).stream().pipeThrough(new Stream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const toB64Url = (bytes) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const fromB64Url = (s) => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

/** Build the shareable URL for a set of items. */
export async function encodeShelf(items, { origin = location.href } = {}) {
  const rows = items
    .slice(0, MAX_TITLES)
    .map((i) =>
      [
        String(i.title || '').replace(/[\x1e\x1f]/g, ' '),
        i.year || '',
        i.quality || '',
        i.watched ? '1' : '',
      ].join(US)
    )
    .join(RS);

  const packed = toB64Url(await squeeze(rows, 'in'));
  /* Everything before the fragment, so the link works from a project subpath as
     well as a domain root. */
  const base = origin.split('#')[0];
  return `${base}${PREFIX}${packed}`;
}

/**
 * Read a shelf out of a URL fragment. Returns null when there is not one, and
 * throws only on a fragment that claims to be a shelf and is not — a corrupt
 * link should say so rather than open an empty page that looks like a bug.
 */
export async function decodeShelf(hash = location.hash) {
  if (!hash || !hash.startsWith(PREFIX)) return null;
  const packed = hash.slice(PREFIX.length);
  if (!packed) return [];

  const text = new TextDecoder().decode(await squeeze(fromB64Url(packed), 'out'));
  return text
    .split(RS)
    .map((row) => {
      const [title, year, quality, watched] = row.split(US);
      if (!title) return null;
      return {
        title,
        year: year ? parseInt(year, 10) : null,
        quality: quality || null,
        watched: watched === '1',
        type: 'movie',
      };
    })
    .filter(Boolean);
}

/** Is this page currently showing somebody else's shelf? */
export function isSharedShelf(hash = location.hash) {
  return typeof hash === 'string' && hash.startsWith(PREFIX);
}

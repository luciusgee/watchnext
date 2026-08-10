/*
 * Your shelf, counted.
 *
 * Two jobs, and only one of them is the numbers.
 *
 * The first is the pile: how many films you bought and never put on, and how
 * long it would take to clear. That is the thing collectors say out loud —
 * "I do have something like 500 titles that haven't been viewed since buying" —
 * and no app in this category tells them. Counting it is the honest version of
 * a feature every other app turns into a streak.
 *
 * The second is a card worth showing someone. This app has no marketing budget
 * and no store listing, so the only way anyone hears about it is a person
 * sending a picture of their own shelf to a friend. That makes the card a
 * distribution channel rather than a flourish, which is why it is free and why
 * it renders to a real PNG you can share rather than asking for a screenshot.
 */

import * as store from '../store.js';
import { el, clear, toast } from '../ui.js';
import { icon } from '../icons.js';

let root = null;
let bodyEl = null;
let navigate = null;

export function initStats({ navigate: nav }) {
  navigate = nav;
  root = document.getElementById('screen-stats');
  bodyEl = root.querySelector('[data-region="body"]');
}

export function showStats() {
  render();
}

function render() {
  clear(bodyEl);

  const s = store.stats();
  if (!s.total) {
    bodyEl.appendChild(
      el('div', {
        style: 'padding:40px 20px;text-align:center;color:var(--ash);font-size:14px',
        text: 'Add some titles and this will have something to say.',
      })
    );
    return;
  }

  const { decades, genres } = store.breakdown();

  /* The pile first, because it is the point. */
  bodyEl.appendChild(
    headline(
      String(s.pile),
      s.pile === 1 ? 'film you own and have never watched' : 'films you own and have never watched',
      s.hoursUnwatched ? `${s.hoursUnwatched} hours of it` : null
    )
  );

  bodyEl.appendChild(
    grid([
      [s.total, 'titles'],
      [s.owned, 'on your shelf'],
      [s.watched, 'watched'],
      [`${s.pctWatched}%`, 'of the way through'],
      [s.hoursWatched, 'hours watched'],
      [s.fourK, 'in 4K'],
    ])
  );

  const longest = store
    .items()
    .filter((i) => i.owned && !i.watched && i.addedAt)
    .sort((a, b) => a.addedAt - b.addedAt)[0];
  if (longest) {
    bodyEl.appendChild(
      note(`Longest untouched: ${longest.title}${longest.year ? ` (${longest.year})` : ''}.`)
    );
  }

  if (decades.length > 1) bodyEl.appendChild(bars('By decade', decades));
  if (genres.length > 1) bodyEl.appendChild(bars('By genre', genres.slice(0, 8)));

  /* Share */
  const actions = el('div', { style: 'padding:24px 16px 8px;display:flex;gap:8px;flex-wrap:wrap' });
  const shareBtn = el('button', {
    class: 'btn btn-primary',
    type: 'button',
    style: 'flex:1',
    onclick: () => shareCard(s),
  });
  shareBtn.appendChild(el('span', { html: icon('upload', 17) }).firstChild);
  shareBtn.appendChild(el('span', { text: 'Make a card' }));
  actions.appendChild(shareBtn);
  bodyEl.appendChild(actions);
  bodyEl.appendChild(
    note('A picture of your shelf, to keep or to send to someone. Nothing is uploaded — it is drawn on your phone.')
  );

  bodyEl.appendChild(el('div', { style: 'height:32px' }));
}

/* ── pieces ── */

function headline(big, label, sub) {
  const box = el('div', { style: 'padding:28px 16px 8px;text-align:center' });
  box.appendChild(
    el('div', {
      style: 'font-size:56px;font-weight:650;letter-spacing:-0.03em;color:var(--amber);line-height:1',
      text: big,
    })
  );
  box.appendChild(el('div', { style: 'font-size:14px;color:var(--silver);margin-top:8px', text: label }));
  if (sub) box.appendChild(el('div', { style: 'font-size:13px;color:var(--ash);margin-top:4px', text: sub }));
  return box;
}

function grid(pairs) {
  const wrap = el('div', {
    style:
      'display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--hairline);' +
      'border-top:1px solid var(--hairline);border-bottom:1px solid var(--hairline);margin-top:24px',
  });
  for (const [value, label] of pairs) {
    const cell = el('div', { style: 'background:var(--ink);padding:14px 10px;text-align:center' });
    cell.appendChild(
      el('div', {
        style: 'font-size:20px;font-weight:600;font-variant-numeric:tabular-nums',
        text: String(value),
      })
    );
    cell.appendChild(el('div', { style: 'font-size:11px;color:var(--ash);margin-top:3px', text: label }));
    wrap.appendChild(cell);
  }
  return wrap;
}

function note(text) {
  return el('div', {
    style: 'padding:14px 16px 0;font-size:12px;color:var(--ash);line-height:1.55;text-align:center',
    text,
  });
}

function bars(title, pairs) {
  const sec = el('section', { style: 'padding:28px 16px 0' });
  sec.appendChild(el('h2', { class: 'eyebrow', style: 'margin-bottom:12px', text: title }));
  const max = Math.max(...pairs.map(([, n]) => n), 1);
  for (const [label, n] of pairs) {
    const row = el('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:7px' });
    row.appendChild(
      el('div', { style: 'width:56px;font-size:12px;color:var(--silver);flex:none', text: label })
    );
    const track = el('div', {
      style: 'flex:1;height:8px;background:var(--raised);border-radius:4px;overflow:hidden',
    });
    track.appendChild(
      el('div', { style: `width:${(n / max) * 100}%;height:100%;background:var(--amber);border-radius:4px` })
    );
    row.appendChild(track);
    row.appendChild(
      el('div', {
        style: 'width:34px;text-align:right;font-size:12px;color:var(--ash);font-variant-numeric:tabular-nums',
        text: String(n),
      })
    );
    sec.appendChild(row);
  }
  return sec;
}

/* ── the card ── */

/**
 * Draw the card and hand it to the share sheet, or download it.
 *
 * Canvas rather than a screenshot: a screenshot carries whatever the status bar
 * happened to say and comes out at the phone's aspect ratio. Drawn at 2x and
 * scaled down so it is not soft on a retina screen.
 *
 * Web Share is tried first because on a phone it puts the image straight into
 * Messages, and falls back to a download everywhere else. Both paths are local;
 * nothing leaves the device.
 */
async function shareCard(s) {
  const W = 1080;
  const H = 1350;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');

  const ink = '#0b0a09';
  const bone = '#f7f4ef';
  const amber = '#e8a33d';
  const ash = '#8f887f';

  g.fillStyle = ink;
  g.fillRect(0, 0, W, H);

  /* A quiet amber wash off the top corner, echoing the app's hero. */
  const wash = g.createRadialGradient(W * 0.78, H * 0.12, 0, W * 0.78, H * 0.12, W * 0.9);
  wash.addColorStop(0, 'rgba(232,163,61,0.16)');
  wash.addColorStop(1, 'rgba(232,163,61,0)');
  g.fillStyle = wash;
  g.fillRect(0, 0, W, H);

  const sans = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, system-ui, sans-serif';
  const line = (text, { size, weight = 400, colour = bone, y, spacing = 0, align = 'left' }) => {
    g.font = `${weight} ${size}px ${sans}`;
    g.fillStyle = colour;
    g.textAlign = align;
    g.letterSpacing = `${spacing}px`;
    g.fillText(text, align === 'center' ? W / 2 : 84, y);
    g.letterSpacing = '0px';
  };

  line('WATCH.NEXT', { size: 30, weight: 620, colour: ash, y: 120, spacing: 8 });

  const year = new Date().getFullYear();
  /* Deliberately "My shelf" and not "My 2026".
     Every watch date is written when someone tells the app they have seen
     something, so a library imported and triaged over a weekend carries five
     hundred dates from that weekend — and a year-in-review built on that is a
     number the data cannot support. The pile is the honest headline, it is the
     thing this app is about, and it is the one nobody else counts. The
     this-year line joins in only once the dates actually span a year. */
  line('My shelf', { size: 96, weight: 650, y: 268 });

  line(String(s.pile), { size: 210, weight: 680, colour: amber, y: 520 });
  line(s.pile === 1 ? 'film I own and have never watched' : 'films I own and have never watched', {
    size: 38,
    colour: bone,
    y: 590,
  });
  if (s.hoursUnwatched) {
    line(`about ${s.hoursUnwatched} hours of it`, { size: 34, colour: ash, y: 654 });
  }

  const rows = [
    [String(s.total), 'in the library'],
    [String(s.watched), 'watched'],
    [String(s.hoursWatched), 'hours, all time'],
    [`${s.pctWatched}%`, 'of the way through'],
    [String(s.fourK), 'owned in 4K'],
    ...(s.datesAreHistory ? [[String(s.watchedThisYear), `watched in ${year}`]] : []),
  ].filter(([v]) => v !== '0');

  let y = 830;
  for (const [value, label] of rows) {
    g.font = `600 54px ${sans}`;
    g.fillStyle = bone;
    g.textAlign = 'left';
    g.fillText(value, 84, y);
    const w = g.measureText(value).width;
    g.font = `400 34px ${sans}`;
    g.fillStyle = ash;
    g.fillText(label, 84 + w + 18, y);
    y += 84;
  }

  g.strokeStyle = 'rgba(247,244,239,0.12)';
  g.beginPath();
  g.moveTo(84, H - 150);
  g.lineTo(W - 84, H - 150);
  g.stroke();
  line('Films I already own, sorted out', { size: 30, colour: ash, y: H - 90 });

  const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/png'));
  if (!blob) {
    toast('Could not make the card');
    return;
  }
  const file = new File([blob], `watchnext-${year}.png`, { type: 'image/png' });

  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (err) {
      /* Cancelling the share sheet is not a failure, and must not fall through
         to a surprise download. */
      if (err?.name === 'AbortError') return;
    }
  }

  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: file.name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Card saved');
}

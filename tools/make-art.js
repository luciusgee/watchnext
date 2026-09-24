/*
 * The icon and the launch images, generated rather than hand-drawn.
 *
 *   node tools/make-art.js
 *
 * Everything is derived from one mark, so the home-screen icon and the screen
 * iOS shows while the app boots are the same drawing at two sizes — the launch
 * image should look like the icon growing into the app, not like a second piece
 * of artwork someone else made.
 *
 * Rendered through headless Chromium because this environment has no image
 * tooling at all: no pngquant, no ImageMagick, not even Pillow. That absence
 * also explains the banded glow below.
 */
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const AMBER = '#e8a33d';

/*
 * Four spines standing on a shelf, one drawn up out of the row.
 *
 * Equal heights, deliberately. The first version graded them — tallest in the
 * middle — and at 60px the whole thing read as a bar chart, because that is
 * what varying heights mean. Spines on a real shelf are the same height, and
 * that one change is the difference between a collection and a graph.
 */
function mark({ scale = 1, cy = 0 } = {}) {
  const w = 70 * scale, gap = 26 * scale, h = 196 * scale, lift = 72 * scale;
  const base = 366 * scale + cy, n = 4, pick = 2;
  const total = n * w + (n - 1) * gap;
  let x = 256 - total / 2;
  let out = `<rect x="${(x - 20).toFixed(1)}" y="${(base + 5).toFixed(1)}" width="${(total + 40).toFixed(1)}" height="${(14 * scale).toFixed(1)}" rx="${(7 * scale).toFixed(1)}" fill="#4a423a"/>`;
  for (let i = 0; i < n; i++) {
    const up = i === pick ? lift : 0;
    const fill = i === pick ? AMBER : i % 2 ? '#5e564c' : '#4c453d';
    out += `<rect x="${x.toFixed(1)}" y="${(base - h - up).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="${(15 * scale).toFixed(1)}" fill="${fill}"/>`;
    x += w + gap;
  }
  return out;
}

const DEFS = `<defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#17140f"/><stop offset="1" stop-color="#0b0a09"/></linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.54" r="0.56"><stop offset="0" stop-color="${AMBER}" stop-opacity="0.18"/><stop offset="1" stop-color="${AMBER}" stop-opacity="0"/></radialGradient>
  </defs>`;

function icon({ rounded = true, scale = 1, cy = 0 } = {}) {
  const r = rounded ? ' rx="114"' : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  ${DEFS}
  <rect width="512" height="512"${r} fill="url(#bg)"/>
  <rect width="512" height="512"${r} fill="url(#glow)"/>
  ${mark({ scale, cy })}
</svg>`;
}

/* Every iPhone that can install this, portrait only. iOS does not scale a
   near-miss: a device size with no exact match gets a blank launch screen. */
const DEVICES = [
  { w: 375, h: 667, r: 2, id: 'iphone-se' },
  { w: 414, h: 736, r: 3, id: 'iphone-8-plus' },
  { w: 375, h: 812, r: 3, id: 'iphone-x' },
  { w: 414, h: 896, r: 2, id: 'iphone-xr' },
  { w: 414, h: 896, r: 3, id: 'iphone-xs-max' },
  { w: 390, h: 844, r: 3, id: 'iphone-12' },
  { w: 428, h: 926, r: 3, id: 'iphone-12-pro-max' },
  { w: 393, h: 852, r: 3, id: 'iphone-15' },
  { w: 430, h: 932, r: 3, id: 'iphone-15-pro-max' },
  { w: 402, h: 874, r: 3, id: 'iphone-16-pro' },
  { w: 440, h: 956, r: 3, id: 'iphone-16-pro-max' },
  { w: 420, h: 912, r: 3, id: 'iphone-air' },
];

(async () => {
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  });

  /* ── icons ── */
  const iconSvg = icon({ rounded: true });
  fs.writeFileSync(path.join(ROOT, 'assets/icon.svg'), iconSvg);
  /* Maskable is cropped to the inner 80% by the launcher, so the mark shrinks
     and the background goes full-bleed square. */
  const maskableSvg = icon({ rounded: false, scale: 0.72, cy: 48 });

  const page = await browser.newPage();
  const png = async (svg, size, out) => {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
    await page.screenshot({ path: path.join(ROOT, out), omitBackground: true });
  };
  for (const s of [180, 192, 512]) await png(iconSvg, s, `assets/icon-${s}.png`);
  await png(maskableSvg, 512, 'assets/icon-maskable-512.png');
  await page.close();

  /* ── launch images ── */
  const dir = path.join(ROOT, 'assets/splash');
  fs.mkdirSync(dir, { recursive: true });
  const links = [];
  for (const d of DEVICES) {
    const p = await browser.newPage({ viewport: { width: d.w, height: d.h }, deviceScaleFactor: d.r });
    const size = Math.round(Math.min(d.w, d.h) * 0.34);
    const markOnly = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${size}" height="${size}">${mark()}</svg>`;
    await p.setContent(`<!doctype html><meta charset="utf-8"><style>
      html,body{margin:0;height:100%;background:#0b0a09;overflow:hidden}
      body{display:flex;flex-direction:column;align-items:center;justify-content:center;
           font-family:-apple-system,'SF Pro Text','Helvetica Neue',Arial,sans-serif}
      /* Banded, not a smooth radial. A true gradient put each of these past
         400KB — five megabytes of launch artwork — and there is no quantiser
         in this environment to fix it afterwards. At this contrast the steps
         are invisible and the files come in around 40KB. */
      .glow{position:fixed;left:50%;top:46%;width:${Math.round(d.w * 1.6)}px;height:${Math.round(d.w * 1.6)}px;
            transform:translate(-50%,-50%);border-radius:50%;
            background:radial-gradient(circle,
              #100e0b 0%, #100e0b 22%, #0f0d0a 22%, #0f0d0a 38%,
              #0e0c0a 38%, #0e0c0a 52%, #0d0b09 52%, #0d0b09 66%, #0b0a09 66%)}
      .mark{position:relative;margin-bottom:${Math.round(size * 0.30)}px}
      .word{position:relative;font-size:${Math.round(d.w * 0.048)}px;font-weight:620;
            letter-spacing:.14em;text-transform:uppercase;color:#f7f4ef}
      .word i{color:${AMBER};font-style:normal}
    </style><div class="glow"></div><div class="mark">${markOnly}</div>
    <div class="word">Watch<i>.</i>Next</div>`);
    await p.screenshot({ path: path.join(dir, `${d.id}.png`) });
    await p.close();
    links.push(
      `<link rel="apple-touch-startup-image" media="(device-width:${d.w}px) and (device-height:${d.h}px) and (-webkit-device-pixel-ratio:${d.r}) and (orientation:portrait)" href="assets/splash/${d.id}.png">`
    );
  }
  await browser.close();

  /* Rewrite the block in index.html rather than leaving it to be hand-synced:
     a device list that drifts from the files on disk is a blank launch screen
     nobody notices until they buy a new phone. */
  const indexPath = path.join(ROOT, 'index.html');
  let html = fs.readFileSync(indexPath, 'utf8');
  const START = '<!-- Launch images.';
  const END = '<link rel="manifest"';
  const from = html.indexOf(START);
  const to = html.indexOf(END);
  if (from >= 0 && to > from) {
    const head = html.slice(0, from);
    const comment = html.slice(from, html.indexOf('-->', from) + 4);
    html = head + comment + links.join('\n') + '\n' + html.slice(to);
    fs.writeFileSync(indexPath, html);
  }

  /* The same drawing, in the page. iOS removes the launch image the moment the
     web view has painted anything, and the shell is still fading in then — so
     the logo used to vanish to flat ink before the app appeared. This block
     sits exactly where the launch image drew it (same flex centring, same
     vmin/vw sizes) and cross-fades out as the shell fades in. */
  const BOOT_START = '<!-- boot:start -->';
  const BOOT_END = '<!-- boot:end -->';
  html = fs.readFileSync(indexPath, 'utf8');
  const boot =
    `${BOOT_START}\n<div id="boot" aria-hidden="true"><div class="boot-glow"></div>` +
    `<svg class="boot-mark" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${mark()}</svg>` +
    `<div class="boot-word">Watch<i>.</i>Next</div></div>\n${BOOT_END}`;
  const b0 = html.indexOf(BOOT_START);
  const b1 = html.indexOf(BOOT_END);
  if (b0 >= 0 && b1 > b0) html = html.slice(0, b0) + boot + html.slice(b1 + BOOT_END.length);
  else html = html.replace('<body>\n', `<body>\n${boot}\n`);
  fs.writeFileSync(indexPath, html);

  console.log(`icons + ${DEVICES.length} launch images; index.html links and boot mark rewritten`);
})();

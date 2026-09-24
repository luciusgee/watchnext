/*
 * Setting up another phone from one file.
 *
 * Two phones: the one already set up makes the file through the share sheet,
 * the new one opens it from Restore from a backup. The second must end up
 * with the library, both keys and sync switched on — and a file that tries to
 * slip anything else in must not get it.
 */
const { chromium, devices } = require('/opt/node22/lib/node_modules/playwright');
const fs = require('fs');
const path = require('path');

const APP_URL = 'http://127.0.0.1:8899/index.html';
const TMP = path.join(require('os').tmpdir(), `wn-setup-${process.pid}.json`);

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  const block = /image\.tmdb\.org|m\.media-amazon\.com|api\.themoviedb\.org|omdbapi\.com|api\.anthropic\.com|api\.github\.com/;
  const errors = [];
  const phone = async () => {
    const ctx = await browser.newContext({ ...devices['iPhone 13 Pro'] });
    await ctx.route(block, (r) => r.abort());
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(APP_URL, { waitUntil: 'networkidle' });
    await page.waitForSelector('body.is-ready');
    return { ctx, page };
  };
  const openSettings = (page) => page.evaluate(() => document.querySelector('.screen.is-active [data-nav="settings"]').click());
  const row = (page, title) =>
    page.evaluate((t) => [...document.querySelectorAll('#screen-settings .group-item')].find((r) => r.textContent.includes(t))?.click(), title);
  const sheetButton = (page, label) =>
    page.evaluate((l) => [...document.querySelectorAll('.sheet.is-open button')].find((b) => b.textContent.trim() === l)?.click(), label);

  console.log('\n─── making the file ───');
  const a = await phone();
  await a.page.evaluate(() => {
    window.__test.loadSample();
    const st = JSON.parse(localStorage.getItem('wn.state.v3'));
    st.settings.provider = 'tmdb';
    st.settings.dataKeys = { tmdb: '0123456789abcdef0123456789abcdef' };
    st.settings.keyStatus = { tmdb: { ok: true, message: 'Connected', at: 1 } };
    st.settings.aiKey = 'sk-ant-test-key';
    st.settings.aiModel = 'claude-sonnet-5';
    st.settings.sync = { repo: 'someone/watchnext-data', token: 'github_pat_TEST', path: 'library.json', enabled: true };
    localStorage.setItem('wn.state.v3', JSON.stringify(st));
  });
  await a.page.reload({ waitUntil: 'networkidle' });
  await a.page.waitForSelector('body.is-ready');
  /* The share sheet, as an iPhone offers it — recorded instead of shown. */
  await a.page.evaluate(() => {
    navigator.canShare = () => true;
    navigator.share = async ({ files }) => { window.__shared = { name: files[0].name, text: await files[0].text() }; };
  });
  const count = await a.page.evaluate(() => window.__test.count());
  await openSettings(a.page);
  await a.page.waitForTimeout(500);
  await row(a.page, 'Set up another phone');
  await a.page.waitForTimeout(400);
  const warn = await a.page.evaluate(() => document.querySelector('.sheet.is-open')?.textContent || '');
  check('it says the file holds your keys, and to delete it after', /keys/.test(warn) && /delete it/.test(warn), warn);
  await sheetButton(a.page, 'Make the file');
  await a.page.waitForTimeout(500);
  const shared = await a.page.evaluate(() => window.__shared);
  check('it goes to the share sheet, so AirDrop is one tap', !!shared && /^watchnext-setup-\d{4}-\d{2}-\d{2}\.json$/.test(shared.name), JSON.stringify(shared?.name));
  const file = JSON.parse(shared.text);
  check('with the library', file.items.length === count, `${file.items.length} of ${count}`);
  check('the film database key', file.setup.dataKeys.tmdb === '0123456789abcdef0123456789abcdef' && file.setup.provider === 'tmdb');
  check('the Claude key and model', file.setup.aiKey === 'sk-ant-test-key' && file.setup.aiModel === 'claude-sonnet-5');
  check('and the sync repo and token', file.setup.sync.repo === 'someone/watchnext-data' && file.setup.sync.token === 'github_pat_TEST');
  /* A plain backup still carries none of it. */
  const backup = await a.page.evaluate(async () => (await import('./src/store.js')).exportPayload());
  check('an ordinary backup still carries no keys', !JSON.stringify(backup).includes('sk-ant-test-key') && !JSON.stringify(backup).includes('github_pat_TEST'));

  /* Someone editing the file to plant something else. */
  file.setup.extra = 'planted';
  file.settings = { ...file.settings, name: 'Planted', viewer: 'x' };
  file.setup.sync.enabled = false;
  fs.writeFileSync(TMP, JSON.stringify(file));
  await a.ctx.close();

  console.log('\n─── opening it on the new phone ───');
  const b = await phone();
  check('the new phone starts empty', (await b.page.evaluate(() => window.__test.count())) === 0);
  await openSettings(b.page);
  await b.page.waitForTimeout(500);
  const restoreSub = await b.page.evaluate(() => [...document.querySelectorAll('#screen-settings .group-item')].find((r) => r.textContent.includes('Restore from a backup'))?.textContent || '');
  check('Restore says it takes the setup file too', /setup file/.test(restoreSub), restoreSub);
  await b.page.setInputFiles('#screen-settings input[type="file"]', TMP);
  await b.page.waitForTimeout(500);
  const ask = await b.page.evaluate(() => document.querySelector('.sheet.is-open')?.textContent || '');
  check('it says what the file brings before doing anything', /Set up this phone\?/.test(ask) && new RegExp(`${count} titles`).test(ask) && /TMDB key/.test(ask) && /Claude key/.test(ask) && /someone\/watchnext-data/.test(ask), ask);
  check('nothing has changed yet', (await b.page.evaluate(() => window.__test.count())) === 0);
  await sheetButton(b.page, 'Set up this phone');
  await b.page.waitForTimeout(800);
  const st = await b.page.evaluate(() => JSON.parse(localStorage.getItem('wn.state.v3')));
  check('the library arrives', st.items.length === count, `${st.items.length} of ${count}`);
  check('the film database key and choice', st.settings.provider === 'tmdb' && st.settings.dataKeys.tmdb === '0123456789abcdef0123456789abcdef');
  check('and it reads as connected', st.settings.keyStatus?.tmdb?.ok === true);
  check('the Claude key and model', st.settings.aiKey === 'sk-ant-test-key' && st.settings.aiModel === 'claude-sonnet-5');
  check('sync is on, with the repo and token', st.settings.sync.enabled === true && st.settings.sync.repo === 'someone/watchnext-data' && st.settings.sync.token === 'github_pat_TEST');
  check('nothing outside the list is taken from the file', !('extra' in st.settings) && st.settings.name !== 'Planted' && st.settings.viewer !== 'x');
  const toastText = await b.page.evaluate(() => document.querySelector('.toast.is-open')?.textContent || '');
  check('and it says to delete the file', /Delete the file/.test(toastText), toastText);

  /* A second time is harmless: the library is merged, not doubled. */
  await b.page.setInputFiles('#screen-settings input[type="file"]', TMP);
  await b.page.waitForTimeout(500);
  await sheetButton(b.page, 'Set up this phone');
  await b.page.waitForTimeout(600);
  check('opening it twice does not double the library', (await b.page.evaluate(() => window.__test.count())) === count);
  await b.ctx.close();
  fs.unlinkSync(TMP);

  console.log('\n─── no errors ───');
  const real = errors.filter((e) => !/Failed to fetch|NetworkError|Load failed/.test(e));
  check('no JavaScript errors', real.length === 0, real.join(' | '));
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) { console.log('\nFailures:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.log('SUITE CRASHED:', e.message); process.exit(1); });

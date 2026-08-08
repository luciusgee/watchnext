/*
 * API key verification.
 *
 * The bug this exists to prevent: a key was stored, the UI said "Connected"
 * because the box was non-empty, and the first real signal that it never worked
 * arrived part-way through a several-hundred-title sweep.
 *
 * The distinction that matters most here is between "this key is bad" and "we
 * could not tell". OMDb returns the identical `Invalid API key!` for a made-up
 * key and for a real key whose activation link was never clicked, so the
 * message has to name that cause; and a failed request on a train must never be
 * recorded as a bad key.
 */
const { chromium, devices } = require('/opt/node22/lib/node_modules/playwright');

let pass = 0, fail = 0; const failures = [];
const check = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ok    ${n}`); }
  else { fail++; failures.push(n + (d ? ` — ${d}` : '')); console.log(`  FAIL  ${n}${d ? ' — ' + d : ''}`); }
};

const URL = 'http://127.0.0.1:8899/index.html';
const BLANK = Buffer.from('R0lGODlhAQABAAAAACw=', 'base64');

/* What OMDb actually returns, verified against the live API. */
const OMDB = {
  ok: { Response: 'True', Title: 'The Shawshank Redemption', Year: '1994', imdbID: 'tt0111161', Type: 'movie' },
  invalid: { Response: 'False', Error: 'Invalid API key!' },
  limit: { Response: 'False', Error: 'Request limit reached!' },
  missing: { Response: 'False', Error: 'No API key provided.' },
};

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ ...devices['iPhone 13 Pro'] });
  await ctx.route('**://image.tmdb.org/**', (r) => r.fulfill({ status: 200, contentType: 'image/gif', body: BLANK }));
  await ctx.route('**://m.media-amazon.com/**', (r) => r.fulfill({ status: 200, contentType: 'image/gif', body: BLANK }));

  /* Every provider request is served from these, so a suite run never touches
     the real APIs and never spends a request from a real quota. */
  let omdbMode = 'ok';
  let tmdbStatus = 200;
  const seen = [];

  await ctx.route('**://www.omdbapi.com/**', (r) => {
    seen.push(r.request().url());
    if (omdbMode === 'offline') return r.abort('failed');
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(OMDB[omdbMode]) });
  });
  await ctx.route('**://api.themoviedb.org/**', (r) => {
    seen.push(r.request().url());
    if (tmdbStatus === 0) return r.abort('failed');
    return r.fulfill({
      status: tmdbStatus,
      contentType: 'application/json',
      body: tmdbStatus === 200
        ? JSON.stringify({ images: { secure_base_url: 'https://image.tmdb.org/t/p/' } })
        : JSON.stringify({ status_code: 7, status_message: 'Invalid API key: You must be granted a valid key.' }),
    });
  });

  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('body.is-ready');

  const verify = (providerId, key) =>
    page.evaluate(
      async ([id, k]) => {
        const { getProvider } = await import('./src/providers/index.js');
        return getProvider(id).verifyKey(k);
      },
      [providerId, key]
    );

  console.log('\n─── OMDb: telling the three failures apart ───');

  omdbMode = 'ok';
  const good = await verify('omdb', 'goodkey1');
  check('a working key verifies', good.ok === true, JSON.stringify(good));

  omdbMode = 'invalid';
  const bad = await verify('omdb', 'deadbeef');
  check('a rejected key reports ok:false', bad.ok === false, JSON.stringify(bad));
  check('the message names activation as the likely cause',
    /activat/i.test(bad.message || ''), bad.message);

  omdbMode = 'limit';
  const capped = await verify('omdb', 'goodkey1');
  check('a rate-limited key counts as working, not rejected', capped.ok === true, JSON.stringify(capped));
  check('and says so rather than claiming a clean bill of health',
    /limit/i.test(capped.message || ''), capped.message);

  omdbMode = 'offline';
  const offline = await verify('omdb', 'goodkey1');
  check('an unreachable provider is "cannot tell", never "bad key"',
    offline.ok === null, JSON.stringify(offline));

  console.log('\n─── TMDB ───');
  tmdbStatus = 200;
  const tGood = await verify('tmdb', 'tmdbkey');
  check('a working TMDB key verifies', tGood.ok === true, JSON.stringify(tGood));

  tmdbStatus = 401;
  const tBad = await verify('tmdb', 'nope');
  check('a 401 is reported as a bad key', tBad.ok === false, JSON.stringify(tBad));

  tmdbStatus = 0;
  const tOff = await verify('tmdb', 'tmdbkey');
  check('an unreachable TMDB is "cannot tell"', tOff.ok === null, JSON.stringify(tOff));

  console.log('\n─── verification costs exactly one request ───');
  seen.length = 0;
  omdbMode = 'ok';
  await verify('omdb', 'goodkey1');
  check('one request per check', seen.length === 1, `${seen.length} requests`);

  console.log('\n─── the key never leaks to the other provider ───');
  seen.length = 0;
  tmdbStatus = 200;
  await verify('tmdb', 'SECRET_TMDB_KEY');
  await verify('omdb', 'SECRET_OMDB_KEY');
  check('the TMDB key is only ever sent to TMDB',
    !seen.some((u) => u.includes('omdbapi.com') && u.includes('SECRET_TMDB_KEY')));
  check('the OMDb key is only ever sent to OMDb',
    !seen.some((u) => u.includes('themoviedb.org') && u.includes('SECRET_OMDB_KEY')));

  console.log('\n─── Settings never claims "Connected" for a key that does not work ───');

  const openSettings = async () => {
    await page.click('[data-tab="tonight"]');
    await page.waitForTimeout(250);
    await page.click('#screen-tonight [data-nav="settings"]');
    await page.waitForTimeout(600);
  };

  /* Select OMDb so the key box belongs to the provider being mocked. */
  await page.evaluate(async () => {
    const store = await import('./src/store.js');
    store.updateSettings({ provider: 'omdb', dataKeys: {}, keyStatus: {} });
    store.saveNow();
  });
  await openSettings();

  omdbMode = 'invalid';
  await page.fill('#data-key', 'deadbeef');
  await page.click('#screen-settings button:has-text("Save")');
  await page.waitForTimeout(900);

  const afterBad = await page.evaluate(() => {
    const box = document.getElementById('data-key')?.closest('.group-pad');
    return box ? box.innerText : '';
  });
  check('a rejected key does not show "Connected"', !/Connected/i.test(afterBad), afterBad.slice(0, 120));
  check('it shows the activation hint instead', /activat/i.test(afterBad), afterBad.slice(0, 160));

  const storedBad = await page.evaluate(async () => {
    const store = await import('./src/store.js');
    return store.settings().keyStatus?.omdb || null;
  });
  check('the failure is recorded in settings', storedBad?.ok === false, JSON.stringify(storedBad));

  omdbMode = 'ok';
  await page.fill('#data-key', 'goodkey1');
  await page.click('#screen-settings button:has-text("Save")');
  await page.waitForTimeout(900);

  const afterGood = await page.evaluate(() => {
    const box = document.getElementById('data-key')?.closest('.group-pad');
    return box ? box.innerText : '';
  });
  check('a working key shows "Connected"', /Connected/i.test(afterGood), afterGood.slice(0, 160));

  console.log('\n─── the verdict survives a reload ───');
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('body.is-ready');
  const persisted = await page.evaluate(async () => {
    const store = await import('./src/store.js');
    return store.settings().keyStatus?.omdb || null;
  });
  check('a verified key is still verified after a reload', persisted?.ok === true, JSON.stringify(persisted));

  console.log('\n─── clearing the box clears the verdict ───');
  await openSettings();
  await page.fill('#data-key', '');
  await page.click('#screen-settings button:has-text("Save")');
  await page.waitForTimeout(700);
  const cleared = await page.evaluate(async () => {
    const store = await import('./src/store.js');
    const s = store.settings();
    return { key: s.dataKeys?.omdb || '', status: s.keyStatus?.omdb ?? null };
  });
  check('the key is gone', cleared.key === '');
  check('and the stale "working" verdict went with it', cleared.status === null, JSON.stringify(cleared.status));

  console.log('\n─── a backup still carries no secrets ───');
  const payload = await page.evaluate(async () => {
    const store = await import('./src/store.js');
    store.updateSettings({ dataKeys: { omdb: 'SECRET_OMDB_KEY' } });
    return JSON.stringify(store.exportPayload());
  });
  check('the export contains no API key', !payload.includes('SECRET_OMDB_KEY'));

  console.log('\n─── no errors ───');
  check('no uncaught JS errors', errs.length === 0, errs.slice(0, 3).join(' | '));

  console.log(`\n══════════  ${pass} passed, ${fail} failed  ══════════`);
  if (failures.length) { console.log('\nFailures:'); failures.forEach((f) => console.log('  · ' + f)); }
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASHED:', e.message, '\n', e.stack); process.exit(2); });

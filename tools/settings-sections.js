/*
 * Settings is folded into sections, closed until their header is tapped, and
 * Playwright's click/tap/fill wait for a visible element. Opens one by its
 * data-section key, the way a finger does; a no-op if it is already open.
 * Safe to call after anything that re-renders Settings.
 */
async function openSection(page, key) {
  const head = `#screen-settings [data-section="${key}"] > button[aria-expanded]`;
  await page.waitForSelector(head, { state: 'attached' });
  if ((await page.getAttribute(head, 'aria-expanded')) !== 'true') await page.click(head);
  await page.waitForSelector(`${head}[aria-expanded="true"]`, { state: 'attached' });
}

/** Every section key currently rendered, in order. */
const sectionKeys = (page) =>
  page.evaluate(() => [...document.querySelectorAll('#screen-settings [data-section]')].map((s) => s.dataset.section));

module.exports = { openSection, sectionKeys };

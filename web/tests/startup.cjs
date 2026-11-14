// Run against a staged GitHub Pages build or the deployed site.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.EXPEDITION73_PLAYWRIGHT || 'playwright');
const base = process.env.EXPEDITION73_PREVIEW_URL || 'http://127.0.0.1:8873/';
const versionedEntry = /\/assets\/[a-f0-9]{20}\/app\.js$/;
const isVersioned = (url) => versionedEntry.test(url.pathname);

(async () => {
  const browser = await chromium.launch({ headless: true, channel: process.env.EXPEDITION73_BROWSER || 'chrome' });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let legacyRequests = 0;
    await page.route((url) => url.pathname === new URL('app.js', base).pathname, (route) => {
      legacyRequests++;
      return route.fulfill({ contentType: 'text/javascript', body: 'document.getElementById("scene-yaw").addEventListener("input", () => {});' });
    });
    const entry = page.waitForRequest((request) => isVersioned(new URL(request.url())));
    await page.goto(base);
    const appPath = new URL((await entry).url()).pathname;
    const css = await page.locator('link[rel=stylesheet]').getAttribute('href');
    assert.equal(new URL(css, base).pathname, appPath.replace(/app\.js$/, 'styles.css'));
    await page.locator('#results').waitFor({ state: 'visible' });
    assert.equal(legacyRequests, 0);
    assert.deepEqual(errors, []);
    console.log(`Versioned startup showed results in ${Math.round(await page.evaluate(() => performance.now()))} ms.`);

    const legacy = await browser.newPage();
    await legacy.route((url) => url.pathname === new URL(base).pathname && !url.searchParams.has('refresh'), (route) =>
      route.fulfill({ contentType: 'text/html', body: '<p id="loading">Loading…</p><script type="module" src="./app.js"></script>' }));
    await legacy.goto(base, { waitUntil: 'commit' });
    await legacy.locator('#results').waitFor({ state: 'visible' });
    assert.ok(new URL(legacy.url()).searchParams.has('refresh'));

    const failed = await browser.newPage();
    const blockEntry = (route) => route.abort();
    await failed.route(isVersioned, blockEntry);
    await failed.goto(base, { waitUntil: 'commit' });
    await failed.locator('#startup-error').waitFor({ state: 'visible' });
    assert.ok(new URL(failed.url()).searchParams.has('refresh'));
    assert.equal(await failed.locator('#loading').isVisible(), false);
    await failed.unroute(isVersioned, blockEntry);
    await failed.locator('#startup-retry').click();
    await failed.locator('#results').waitFor({ state: 'visible' });

    const slow = await browser.newPage();
    await slow.clock.install();
    await slow.addInitScript(() => {
      const realFetch = window.fetch;
      window.fetch = (url, options) => {
        if (url !== './data/results.json' || window.catalogStalled) return realFetch(url, options);
        window.catalogStalled = true;
        return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason)));
      };
    });
    await slow.goto(base);
    await slow.waitForFunction(() => window.catalogStalled);
    await slow.clock.fastForward(30_100);
    await slow.locator('#error').waitFor({ state: 'visible' });
    assert.equal(await slow.locator('#loading').isVisible(), false);
    await slow.locator('#retry').click();
    await slow.locator('#results').waitFor({ state: 'visible' });
    console.log('Stale entry isolation, module failure recovery and catalog timeout/retry passed.');
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });

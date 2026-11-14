/* User tasks for the compact workspace; no scientific calculation is added. */
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(process.env.EXPEDITION73_PLAYWRIGHT || 'playwright');
const base = process.env.EXPEDITION73_PREVIEW_URL || 'http://127.0.0.1:8873/';

(async () => {
  const browser = await chromium.launch({ headless: true, channel: process.env.EXPEDITION73_BROWSER || 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], requests = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => requests.push(r.url()));
  let checks = 0;
  const tab = async (id) => page.locator(`#tab-${id}`).click();
  const visible = async (id) => page.locator(`#${id}`).isVisible();
  try {
    await page.goto(base); await page.locator('#results').waitFor({state:'visible'});
    assert.equal(await visible('workspace-compare'), true);
    assert.equal(await visible('workspace-region'), false);
    assert.equal(await visible('workspace-sources'), false);
    assert.equal(await visible('view-history'), false);
    assert.equal(await visible('view-annual'), false); checks++;
    // Main temperature and difference charts are adjacent and discoverable
    // before the desktop user needs to scan another page of details.
    const [chart, pair] = await Promise.all(['#chart', '#pair-chart'].map((s) => page.locator(s).boundingBox()));
    assert.ok(pair.x > chart.x + chart.width);
    assert.ok(chart.y + chart.height < 1000 && pair.y + pair.height < 1000);
    assert.equal(await page.locator('.review-panel').evaluate((n) => n.open), false);
    await page.screenshot({path:path.join(__dirname,'../artifacts/workspace-desktop.png'),fullPage:true}); checks++;

    await page.locator('#year').selectOption('2012');
    await page.locator('#month').fill('5');
    await page.locator('#policy').selectOption('land');
    await page.locator('#pair-swap').click();
    const selected = await page.locator('#metrics').innerText();
    await tab('region');
    await page.locator('#spatial-region').selectOption('B');
    await page.locator('#cell-grid [data-cell="9"]').click();
    const cell = await page.locator('#cell-detail').innerText();
    assert.equal(await visible('chart'), false); checks++;
    await tab('sources');
    await page.locator('#provenance > summary').click();
    await page.keyboard.press('Escape');
    await tab('weight-workflow');
    await page.locator('#trace-graph [data-node="Fractions"]').click();
    const trace = await page.locator('#trace-detail').innerText();
    assert.equal(await visible('cell-grid'), false);
    await tab('region');
    assert.equal(await page.locator('#cell-detail').innerText(),cell);
    assert.equal(await page.locator('#cell-grid [data-cell="9"]').getAttribute('aria-pressed'),'true');
    await tab('sources');
    assert.equal(await visible('view-weight-workflow'),true);
    assert.equal(await page.locator('#trace-detail').innerText(),trace); checks++;
    await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));
    await tab('compare');
    const controlBounds = await page.locator('.controls').boundingBox();
    assert.ok(controlBounds.y>=-1,JSON.stringify(controlBounds));
    assert.equal(await page.locator('#metrics').innerText(),selected);
    assert.equal(await page.locator('#year').inputValue(),'2012');
    assert.equal(await page.locator('#month').inputValue(),'5');
    assert.equal(await page.locator('#policy').inputValue(),'land'); checks++;

    // Arrow keys activate tabs, wrap at the ends, and retain focus.
    await page.locator('#tab-compare').focus(); await page.keyboard.press('ArrowLeft');
    assert.equal(await visible('workspace-sources'),true);
    assert.equal(await page.locator('#tab-sources').evaluate((n)=>n===document.activeElement),true);
    await page.keyboard.press('Home'); assert.equal(await visible('workspace-compare'),true);
    await page.keyboard.press('End'); assert.equal(await visible('workspace-sources'),true);
    await page.keyboard.press('ArrowRight'); assert.equal(await visible('workspace-compare'),true);
    assert.equal(await page.locator('.workspace-nav [tabindex="0"]').count(),1); checks++;
    await page.locator('#tab-monthly').focus(); await page.keyboard.press('ArrowRight');
    assert.equal(await visible('history-chart'),true); assert.equal(await visible('chart'),false);
    assert.equal(await page.locator('#history-month').inputValue(),'137');
    await tab('region'); await tab('compare');
    assert.equal(await visible('view-history'),true); checks++;
    await page.locator('#tab-history').focus(); await page.keyboard.press('End');
    assert.equal(await visible('view-annual'),true);
    await page.locator('#policy').selectOption('unmasked');
    await page.waitForFunction(()=>document.querySelectorAll('.annual-workflow').length===2);
    await page.locator('.annual-card[data-region="A"] .annual-workflow > summary').click();
    await tab('sources'); await tab('compare');
    assert.equal(await page.locator('.annual-card[data-region="A"] .annual-workflow').evaluate((n)=>n.open),false); checks++;

    for (const width of [1280,768,390,320]) {
      await page.setViewportSize({width,height:844});
      await tab('monthly');
      for (const area of ['compare','region','sources']) {
        await tab(area);
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${width}px ${area}`);
        if (width <= 850) await page.locator('#toggle-filters').click();
        assert.equal(await page.locator('#year').isVisible(),true);
        if (width <= 850) await page.locator('#close-filters').click();
      }
      await tab('compare');
      // Controls are also keyboard reachable on a narrow display.
      await page.locator('#tab-compare').focus(); await page.keyboard.press('ArrowRight');
      assert.equal(await visible('workspace-indicators'),true);
      await page.keyboard.press('ArrowLeft'); assert.equal(await visible('workspace-compare'),true);
      if(width===390) await page.screenshot({path:path.join(__dirname,'../artifacts/workspace-mobile.png'),fullPage:true});
      checks++;
    }
    assert.deepEqual(errors,[]);
    assert.ok(requests.every((url)=>new URL(url).origin===new URL(base).origin)); checks++;
    console.log(JSON.stringify({status:'passed',checks,browser:'Chrome headless',javascript_errors:errors,external_runtime_requests:0}));
  } finally { await browser.close(); }
})().catch((error)=>{console.error(error);process.exitCode=1;});

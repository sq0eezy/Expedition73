/* Selected pair, display direction and honest missing/rounded-value language. */
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const { chromium } = require(process.env.EXPEDITION73_PLAYWRIGHT || 'playwright');
const base = process.env.EXPEDITION73_PREVIEW_URL || 'http://127.0.0.1:8873/';
const formatted = (n) => n.toLocaleString('en-US',{minimumFractionDigits:3,maximumFractionDigits:3});
(async () => {
  const browser = await chromium.launch({headless:true,channel:process.env.EXPEDITION73_BROWSER || 'chrome'});
  const errors=[],requests=[];
  let checks=0;
  const page = await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});
  const listen = (p) => {p.on('pageerror',(e)=>errors.push(e.message));p.on('request',(r)=>requests.push(r.url()));};
  listen(page);
  try {
    await page.goto(base); await page.locator('#results').waitFor({state:'visible'});
    const catalog=await (await page.request.get(new URL('data/results.json',base).href)).json();
    const source=JSON.parse(catalog.snapshots.find((s)=>s.year===2024).data_json);
    const verify=async(year,month,policy)=>{
      const snapshot=JSON.parse(catalog.snapshots.find((s)=>s.year===year).data_json);
      const left=await page.locator('#pair-left').inputValue(),right=await page.locator('#pair-right').inputValue();
      const a=snapshot.regions.find((r)=>r.id===left).series[month][policy],b=snapshot.regions.find((r)=>r.id===right).series[month][policy];
      assert.deepEqual(await page.locator('#metrics .metric strong').allTextContents(),[a,b,a-b].map((v)=>formatted(v)+'°C'));
      assert.match(await page.locator('#metrics .difference .metric-head').innerText(),new RegExp(`${left} − ${right}`));
      assert.equal(await page.locator('#pair-metrics strong').first().textContent(),formatted(a-b)+' °C');
      assert.match(await page.locator('#pair-reading').innerText(),new RegExp(`${year}: ${left} was .* than ${right}`));
      assert.match(await page.locator('#pair-reading').innerText(),a>b?/warmer/:/cooler/);
    };
    await verify(2024,0,'unmasked');
    assert.equal(await page.locator('.pair-summary').evaluate((n)=>n.open),false); checks++;
    await page.locator('#pair-swap').click(); await verify(2024,0,'unmasked');
    assert.match(await page.locator('#metrics-context').innerText(),/B − A/); checks++;
    await page.locator('#year').selectOption('2012');await page.locator('#month').fill('5');await page.locator('#policy').selectOption('land');
    await verify(2012,5,'land');
    await page.locator('.pair-summary > summary').click();
    await page.locator('#month').fill('6');await verify(2012,6,'land');
    assert.equal(await page.locator('.pair-summary').evaluate((n)=>n.open),true); checks++;
    await page.locator('#tab-sources').click();await page.locator('#tab-compare').click();await verify(2012,6,'land'); checks++;
    await page.locator('.review-panel > summary').click();
    const downloading=page.waitForEvent('download');await page.locator('#review-download').click();
    const reportPath=await (await downloading).path();
    const report=JSON.parse(await fs.readFile(reportPath,'utf8'));
    assert.deepEqual(report.selection,{left_id:'B',right_id:'A',month:'2012-07',policy:'land'});
    await page.locator('#pair-swap').click(); await page.locator('#review-file').setInputFiles(reportPath);
    await page.waitForFunction(()=>document.getElementById('review-message').textContent.includes('recomputed and verified'));
    await verify(2012,6,'land'); checks++;
    await page.keyboard.press('Escape');
    await page.locator('.pair-summary > summary').click();
    await page.keyboard.press('Escape');
    await page.locator('.review-panel > summary').click();
    await page.evaluate(()=>window.scrollTo(0,0));
    await page.screenshot({path:path.join(__dirname,'../artifacts/selected-month-desktop.png'),fullPage:true});
    await page.keyboard.press('Escape');
    await page.setViewportSize({width:320,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    for(const strong of await page.locator('#metrics strong').all()) assert.ok(await strong.evaluate((n)=>n.getBoundingClientRect().right<=innerWidth));
    await page.setViewportSize({width:390,height:844});
    await page.evaluate(()=>window.scrollTo(0,0));
    await page.screenshot({path:path.join(__dirname,'../artifacts/selected-month-mobile.png'),fullPage:true}); checks++;

    await page.setViewportSize({width:1440,height:1000});
    for (const kind of ['missing','zero','tiny','incompatible','third']) {
      const p=await browser.newPage();listen(p);
      await p.route('**/data/results.json',(route)=>{
        const data=structuredClone(source);
        if(kind==='missing') {data.regions[0].series[0].unmasked=null;data.regions[0].spatial.cells[0].series[0].value=null;}
        if(kind==='zero'||kind==='tiny'||kind==='third') {
          const copy=structuredClone(data.regions[0]);copy.id=copy.region.id='C';copy.display_name='UI test copy only';
          if(kind==='tiny') copy.series[0].unmasked+=0.0001;
          data.regions.push(copy);
        }
        if(kind==='incompatible') data.regions[1].workflow_trace.nodes.find((n)=>n.id==='Land').operation_version='0.2.0';
        return route.fulfill({json:data});
      });
      await p.goto(base);await p.locator('#results').waitFor({state:'visible'});
      if(kind==='missing') {
        assert.equal(await p.locator('#metrics .difference strong').innerText(),'No data');
        assert.match(await p.locator('#pair-reading').innerText(),/temperature value is missing/);
      } else if(kind==='incompatible') {
        await p.locator('#policy').selectOption('land');
        assert.equal(await p.locator('#metrics .difference strong').innerText(),'No data');
        assert.match(await p.locator('#pair-status').innerText(),/compatibility check failed/);
        assert.equal(await p.locator('#pair-reading').isVisible(),false);
        assert.equal(await p.locator('#pair-values').isVisible(),false);
      } else {
        await p.locator('#pair-left').selectOption('C');await p.locator('#pair-right').selectOption('A');
        assert.equal(await p.locator('#metrics .metric').count(),3);
        assert.match(await p.locator('#metrics-context').innerText(),/3 regions on the chart/);
        assert.match(await p.locator('#metrics .metric-head').first().innerText(),/^C ·/);
        if(kind==='zero') assert.match(await p.locator('#pair-reading').innerText(),/same recorded monthly mean/);
        if(kind==='tiny') {assert.equal(await p.locator('#metrics .difference strong').innerText(),'0.000°C');assert.match(await p.locator('#pair-reading').innerText(),/nonzero .* difference rounds to 0\.000 °C/);}
        if(kind==='third') {await p.locator('#region-options input[value="C"]').uncheck();assert.match(await p.locator('#metrics .difference .metric-head').innerText(),/A − B/);}
      }
      await p.close();checks++;
    }
    await page.locator('#region-options input[value="A"]').uncheck();
    assert.equal(await page.locator('#metrics .metric').count(),1);assert.match(await page.locator('#metrics-context').innerText(),/One region/);
    assert.equal(await page.locator('#pair-content').isVisible(),false);
    await page.locator('#region-options input[value="B"]').uncheck();assert.equal(await page.locator('#metrics .metric').count(),0);checks++;
    assert.deepEqual(errors,[]);assert.ok(requests.every((u)=>new URL(u).origin===new URL(base).origin));
    console.log(JSON.stringify({status:'passed',checks,browser:'Chrome headless',javascript_errors:errors,external_runtime_requests:0}));
  } finally {await browser.close();}
})().catch((e)=>{console.error(e);process.exitCode=1;});

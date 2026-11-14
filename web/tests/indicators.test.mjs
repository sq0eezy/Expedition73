import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {webcrypto,createHash} from 'node:crypto';
import path from 'node:path';
import {existsSync} from 'node:fs';
import {seasonalProfilesByYear,summarizePrecipitationTrends,summarizeSeasonalProfile,validateIndicatorPreview} from '../src/indicators.mjs';
globalThis.crypto??=webcrypto;
const root=path.resolve('analysis'),venv=path.join(root,'.venv',process.platform==='win32'?'Scripts':'bin',process.platform==='win32'?'python.exe':'python');
const python=process.env.EXPEDITION73_PYTHON || (existsSync(venv)?venv:process.platform==='win32'?'python':'python3');
const program=`import json\nfrom expedition73 import web_preview,indicator_web\nfrom expedition73.power import ROOT,loads\nw=ROOT.parent/'web'\na=web_preview.payload(ROOT,loads((w/'regions.json').read_bytes()))\nb=json.dumps(a,ensure_ascii=False).encode()\nd=indicator_web.payload(ROOT,loads((w/'indicator-regions.json').read_bytes()),b)\nprint(json.dumps(dict(data=d,annual=a)))`;
const fixture=JSON.parse(execFileSync(python,['-X','utf8','-c',program],{cwd:root,maxBuffer:2000000}).toString());
const periods=new Map([[2024,{data:fixture.annual}]]),hash=fixture.data.source_catalog_sha256;
const clone=()=>structuredClone(fixture.data);
test('real A/B common identities and two distinct units verify',async()=>{const d=await validateIndicatorPreview(fixture.data,hash,periods);assert.equal(d.regions.length,2);assert.equal(d.regions[1].input_check.paired_valid_months,12);assert.equal(d.regions[0].precipitation.variable.unit,'mm/day');});
test('wrong catalog identity rejects the whole indicator envelope',async()=>{await assert.rejects(validateIndicatorPreview(fixture.data,'0'.repeat(64),periods));});
test('byte-level common text changes cannot reuse its content identity',async()=>{const d=clone();d.regions[0].precipitation_json=d.regions[0].precipitation_json.replace('mm/day','mm');await assert.rejects(validateIndicatorPreview(d,hash,periods));});
test('even an updated text checksum cannot hide a stale result identity',async()=>{const d=clone(),e=d.regions[0];e.precipitation_json=e.precipitation_json.replace('mm/day','mm');e.precipitation_sha256=createHash('sha256').update(e.precipitation_json).digest('hex');await assert.rejects(validateIndicatorPreview(d,hash,periods));});
test('a wrong named input identity cannot pass technical coindexing',async()=>{const d=clone();d.regions[0].input_check.input_result_ids.temperature='sha256:'+'0'.repeat(64);await assert.rejects(validateIndicatorPreview(d,hash,periods));});
test('a modified workflow edge or fingerprint is rejected',async()=>{const d=clone();d.regions[0].workflow.trace.nodes[2].inputs[0].node='Temperature';await assert.rejects(validateIndicatorPreview(d,hash,periods));});
test('unknown context data is rejected before it can be rendered',async()=>{const d=clone(),e=d.regions[0];const c=JSON.parse(e.workflow.context_json);c.private_note='PRIVATE';e.workflow.context_json=JSON.stringify(c);await assert.rejects(validateIndicatorPreview(d,hash,periods));});
test('another region source or duplicated region cannot be substituted',async()=>{const d=clone();d.regions[0]=d.regions[1];await assert.rejects(validateIndicatorPreview(d,hash,periods));});
test('scientific acceptance and relation flags stay explicit',async()=>{const d=clone();d.regions[0].input_check.relationship_calculated=true;await assert.rejects(validateIndicatorPreview(d,hash,periods));});
test('unavailable optional data is valid and contains no invented records',async()=>{const d=clone();d.regions=[];d.status='not_available';assert.deepEqual((await validateIndicatorPreview(d,hash,periods)).regions,[]);});
test('a missing 2024 temperature reference cannot validate another year',async()=>{await assert.rejects(validateIndicatorPreview(fixture.data,hash,new Map()));});

test('seasonal summaries reproduce the recorded A/B warm-month profiles', async () => {
  const { regions } = await validateIndicatorPreview(fixture.data, hash, periods);
  const [a, b] = regions.map(summarizeSeasonalProfile);
  assert.equal(a.points.length, 12);
  assert.equal(b.points.length, 12);
  assert.deepEqual(a.summary.warmestMonths, [5, 6, 7]);
  assert.deepEqual(b.summary.warmestMonths, [5, 6, 7]);
  assert.equal(a.summary.meanPrecipitation.toFixed(2), '1.02');
  assert.equal(b.summary.meanPrecipitation.toFixed(2), '3.30');
  assert.deepEqual(a.summary.peakPrecipitationMonths, [7]);
  assert.deepEqual(b.summary.peakPrecipitationMonths, [6]);
});

test('the seasonal summary requires every paired month and a compatible input check', async () => {
  const { regions: [entry] } = await validateIndicatorPreview(clone(), hash, periods);
  entry.precipitation.series[2].value = null;
  entry.input_check.paired_valid_months = 11;
  assert.equal(summarizeSeasonalProfile(entry).points.length, 11);
  assert.equal(summarizeSeasonalProfile(entry).summary, null);
  entry.input_check.technical_status = 'incompatible';
  assert.deepEqual(summarizeSeasonalProfile(entry), { points: [], summary: null });
});

test('temperature ties use earlier months, leap February has 29 days and zero rain is valid', async () => {
  const { regions: [entry] } = await validateIndicatorPreview(clone(), hash, periods);
  entry.temperature.series.forEach((row) => { row.value = 2; });
  entry.precipitation.series.forEach((row, index) => { row.value = index === 1 ? 3 : 0; });
  const { points, summary } = summarizeSeasonalProfile(entry);
  assert.equal(points[0].precipitation, 0);
  assert.deepEqual(summary.warmestMonths, [0, 1, 2]);
  assert.equal(summary.meanPrecipitation, 87 / 91);
  assert.equal(summary.peakTemperatureMonths.length, 12);
  assert.deepEqual(summary.peakPrecipitationMonths, [1]);
});

test('seasonal weights use the selected year and refuse mismatched month slots', () => {
  const temperature = { series: Array.from({ length: 12 }, (_, i) => ({ date: `2001-${String(i + 1).padStart(2, '0')}`, value: 2 })) };
  const precipitation = { series: temperature.series.map(({ date }, i) => ({ date, value: i === 1 ? 3 : 0 })) };
  const entry = { temperature, precipitation };
  assert.equal(summarizeSeasonalProfile(entry).summary.meanPrecipitation, 84 / 90);
  precipitation.series[1].date = '2002-02';
  const result = summarizeSeasonalProfile(entry);
  assert.equal(result.points.length, 11);
  assert.equal(result.summary, null);
});

test('precipitation trend requires a complete calendar, weights leap February and retains zero', () => {
  const series = Array.from({ length: 288 }, (_, i) => ({
    date: `${2001 + Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, '0')}`,
    status: 'complete',
    value: i % 12 === 1 ? 1 : 0,
  }));
  const history = { regions: [{ id: 'A', series }] };
  const [a, missing] = summarizePrecipitationTrends(history, ['A', 'B']);
  assert.equal(a.rows[0].value, 28 / 365);
  assert.equal(a.rows[3].value, 29 / 366);
  assert.equal(a.result.years, 24);
  assert.equal(missing.result, null);
  series[1].value = null;
  series[1].status = 'incomplete';
  assert.equal(summarizePrecipitationTrends(history, ['A'])[0].result, null);
});

test('annual profiles select the matching unmasked temperature, rain year and 2024 trace', async () => {
  const model = await validateIndicatorPreview(clone(), hash, periods);
  assert.deepEqual([...seasonalProfilesByYear(model, periods).keys()], [2024]);
  const legacy = model.regions[0];
  const annuals = new Map([[2024, periods.get(2024)]]);
  const series = [];
  for (const year of [2001, 2002]) {
    const dates = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
    const first = year === 2001;
    annuals.set(year, { data: { regions: [{ id: legacy.id, display_name: legacy.display_name,
      series: dates.map((date, i) => ({ date, unmasked: first ? i : -i, land: first ? -i : i })),
    }] } });
    series.push(...dates.map((date) => ({ date, value: first ? 3 : 4 })));
  }
  model.precipitationHistory = { time: { start: '2001-01' }, regions: [{ id: legacy.id, series }] };
  const result = seasonalProfilesByYear(model, annuals);
  assert.deepEqual([...result.keys()], [2001, 2002, 2024]);
  const [first] = result.get(2001), [second] = result.get(2002);
  assert.deepEqual(first.profile.summary.warmestMonths, [9, 10, 11]);
  assert.equal(first.profile.summary.meanPrecipitation, 3);
  assert.deepEqual(second.profile.summary.warmestMonths, [0, 1, 2]);
  assert.equal(second.profile.summary.meanPrecipitation, 4);
  assert.equal(result.get(2024)[0].workflow, legacy.workflow);
  assert.equal(result.get(2024)[0].profile.summary.meanPrecipitation.toFixed(2), '1.02');
});

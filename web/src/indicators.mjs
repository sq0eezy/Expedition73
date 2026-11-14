import { datasetDigest, fitAnnualTrend } from './comparison.mjs';
import { traceGraph } from './trace.mjs';
const canonical = (x) => JSON.stringify(Array.isArray(x) ? x.map(v=>JSON.parse(canonical(v))) : x && typeof x==='object' ? Object.fromEntries(Object.keys(x).sort().map(k=>[k,JSON.parse(canonical(x[k]))])) : x);
const hash = s => typeof s==='string' && /^[a-f0-9]{64}$/.test(s);
const sha = text => datasetDigest(new TextEncoder().encode(text));
const equal = (a,b) => canonical(a)===canonical(b);
const close = (a,b) => a===null || b===null ? a===b : Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=Math.max(1,Math.abs(b))*1e-12;
const fail = () => { throw Error('Indicator preview differs from recorded context, sources or workflow'); };
const daysInMonth = (year, month) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

// Consume the verified precipitation history. The unit remains mm/day.
export function summarizePrecipitationTrends(history, ids) {
  return ids.map((id) => {
    const series = history.regions.find((region) => region.id === id)?.series;
    const rows = series?.length === 288 ? Array.from({ length: 24 }, (_, index) => {
      const year = 2001 + index;
      const months = series.slice(index * 12, (index + 1) * 12);
      if (!months.every(({ date, status, value }, month) =>
        date === `${year}-${String(month + 1).padStart(2, '0')}` &&
        status === 'complete' && Number.isFinite(value) && value >= 0)) return { year, value: null };
      const days = months.map((_, month) => daysInMonth(year, month));
      const weightedSum = months.reduce((sum, { value }, month) => sum + value * days[month], 0);
      return { year, value: weightedSum / days.reduce((sum, days) => sum + days, 0) };
    }) : [];
    return { id, rows, result: fitAnnualTrend(rows) };
  });
}

// Accept the paired records after validateIndicatorPreview has checked their sources and units.
export function summarizeSeasonalProfile({ temperature, precipitation, input_check: check }) {
  const points = [];
  const firstDate = temperature.series[0]?.date;
  if ((check && check.technical_status !== 'compatible') || !/^\d{4}-01$/.test(firstDate)) {
    return { points, summary: null };
  }
  const year = Number(firstDate.slice(0, 4));

  temperature.series.slice(0, 12).forEach((row, month) => {
    const rain = precipitation.series[month];
    const date = `${year}-${String(month + 1).padStart(2, '0')}`;
    if (row.date === date && rain?.date === date && Number.isFinite(row.value) && Number.isFinite(rain.value) && rain.value >= 0) {
      points.push({ month, temperature: row.value, precipitation: rain.value });
    }
  });
  if (points.length !== 12 || temperature.series.length !== 12 || precipitation.series.length !== 12
      || (check && check.paired_valid_months !== 12)) return { points, summary: null };

  const ranked = [...points].sort((a, b) => b.temperature - a.temperature || a.month - b.month);
  const warmest = ranked.slice(0, 3);
  let days = 0;
  let precipitationSum = 0;
  for (const point of warmest) {
    const monthDays = daysInMonth(year, point.month);
    days += monthDays;
    precipitationSum += point.precipitation * monthDays;
  }
  const meanPrecipitation = precipitationSum / days;
  if (!Number.isFinite(meanPrecipitation)) return { points, summary: null };

  const peakRate = Math.max(...points.map((point) => point.precipitation));
  return { points, summary: {
    warmestMonths: warmest.map((point) => point.month).sort((a, b) => a - b),
    meanPrecipitation,
    peakTemperatureMonths: points.filter((point) => point.temperature === ranked[0].temperature).map((point) => point.month),
    peakPrecipitationMonths: points.filter((point) => point.precipitation === peakRate).map((point) => point.month),
  } };
}

// The history validator has already checked the two catalogs' date and spatial
// support. Use their unmasked rates directly and keep the recorded 2024 trace.
export function seasonalProfilesByYear(model, periods) {
  const withProfile = (entry) => ({ ...entry, profile: summarizeSeasonalProfile(entry) });
  const legacy = [2024, model.regions.map(withProfile)];
  const history = model.precipitationHistory;
  if (!history) return new Map([legacy]);

  const startYear = Number(history.time.start.slice(0, 4));
  return new Map([...periods].sort(([a], [b]) => a - b).map(([year, { data }]) => {
    if (year === 2024) return legacy;
    const offset = (year - startYear) * 12;
    const entries = history.regions.map(({ id, series }) => {
      const region = data.regions.find((candidate) => candidate.id === id);
      const temperature = region.series.map(({ date, unmasked }) => ({ date, value: unmasked }));
      return withProfile({ id, display_name: region.display_name, temperature: { series: temperature },
        precipitation: { series: series.slice(offset, offset + 12) } });
    });
    return [year, entries];
  }));
}

export async function validateIndicatorPreview(data, catalogHash, periods) {
  if (data?.schema_version === '0.2.0') {
    const { precipitation_history: historical, ...legacy } = data;
    const model = await validateIndicatorPreview({ ...legacy, schema_version: '0.1.0' }, catalogHash, periods);
    try {
      return { ...model, precipitationHistory: await validatePrecipitationHistory(historical, model.regions, periods) };
    } catch {
      return { ...model, precipitationHistoryError: true };
    }
  }
  if (!data || data.schema_version!=='0.1.0' || data.output_type!=='recorded_indicator_web_preview' || data.data_mode!=='recorded_offline_replay' || data.selection_status!=='candidate' || data.inference_performed!==false || data.source_catalog_sha256!==catalogHash || data.year!==2024 || !Array.isArray(data.regions) || data.regions.length>8 || data.status!==(data.regions.length?'available':'not_available')) fail();
  const baseline=periods.get(2024)?.data, ids=new Set(), result=[];
  for (const entry of data.regions) {
    const old=baseline?.regions.find(r=>r.id===entry.id);
    if (!old || ids.has(entry.id) || entry.display_name!==old.display_name) fail(); ids.add(entry.id);
    const values=[];
    for (const [name,id,unit,param] of [['temperature','air_temperature_2m','degC','T2M'],['precipitation','precipitation_rate','mm/day','PRECTOTCORR']]) {
      const text=entry[name+'_json'];
      if (typeof text!=='string' || text.length>100000 || !hash(entry[name+'_sha256']) || await sha(text)!==entry[name+'_sha256']) fail();
      const v=JSON.parse(text), s=v.spatial_support, q=v.quality;
      // Remove only the canonical top-level identity field from the original
      // text, preserving Python's exact float spelling for its content digest.
      const identityField=`"result_id":"${v.result_id}",`;
      if(text.split(identityField).length!==2 || await sha(text.replace(identityField,''))!==v.result_id?.slice(7)) fail();
      if (v.schema_version!=='0.1.0' || v.output_type!=='candidate_monthly_indicator_result' || !/^sha256:[a-f0-9]{64}$/.test(v.result_id) || v.module.id!==id || v.variable.id!==id || v.variable.unit!==unit || v.variable.provider_parameter!==param || v.region.id!==entry.id || v.region.selection_status!=='candidate' || !equal(v.time,old.time) || s.kind!=='unmasked_rectangular_window' || s.mask!=='none' || !hash(s.cell_geometry_sha256) || !Number.isInteger(s.cell_count) || s.cell_count<1 || q.scientific_acceptance!=='not_performed' || q.inference!=='not_performed' || !Array.isArray(q.warnings) || !v.provenance || !hash(v.provenance.source_result_sha256) || !Array.isArray(v.series) || v.series.length!==12 || q.expected_months!==12) fail();
      let complete=0;
      v.series.forEach((r,i)=>{
        const full=r.valid_cells===s.cell_count;
        if (r.date!==`2024-${String(i+1).padStart(2,'0')}` || !Number.isInteger(r.valid_cells) || r.valid_cells<0 || r.valid_cells>s.cell_count || !Number.isFinite(r.valid_area_fraction) || r.valid_area_fraction<0 || r.valid_area_fraction>1 || (r.status==='complete')!==full || !['complete','incomplete'].includes(r.status) || (r.value!==null)!==full || full&&(!Number.isFinite(r.value)||!close(r.valid_area_fraction,1)) || !full&&r.valid_area_fraction>=1 || name==='precipitation'&&r.value!==null&&r.value<0) fail();
        if(full) complete++;
      });
      if (q.complete_months!==complete || v.method.missing_policy!=='require_all_intersecting_cells' || v.method.geometry!=='spherical_midpoint_cell_intersection' || v.method.geometry_version!=='0.1.0' || v.method.sphere_radius_m!==6371008.8) fail();
      values.push(v);
    }
    const [temperature,precipitation]=values, check=entry.input_check, ts=temperature.provenance, ps=precipitation.provenance;
    if (!equal(temperature.region,precipitation.region) || !equal(temperature.region.candidate_bbox,old.region.candidate_bbox) || !equal(temperature.time,precipitation.time) || !equal(temperature.spatial_support.grid_step_degrees,precipitation.spatial_support.grid_step_degrees) || temperature.spatial_support.cell_count!==precipitation.spatial_support.cell_count || !close(temperature.spatial_support.window_area_m2,precipitation.spatial_support.window_area_m2) || temperature.spatial_support.cell_geometry_sha256!==precipitation.spatial_support.cell_geometry_sha256 || !['api_version','sources','provider','product'].every(k=>equal(ts[k],ps[k])) || ts.source_result_sha256!==old.provenance.source_files_sha256.temperature['result.json'] || ts.source_result_sha256!==precipitation.module_details.temperature_control_result_sha256 || !temperature.series.every((r,i)=>close(r.value,old.series[i].unmasked))) fail();
    const missing=precipitation.module_details.missing_counts;
    if (!Array.isArray(missing)||missing.length!==12 || !missing.every((r,i)=>r.date===precipitation.series[i].date&&Number.isInteger(r.provider_fill_cells)&&r.provider_fill_cells>=0&&Number.isInteger(r.not_returned_cells)&&r.not_returned_cells>=0&&r.provider_fill_cells+r.not_returned_cells===precipitation.spatial_support.cell_count-precipitation.series[i].valid_cells) || precipitation.module_details.latitude_context?.observational_support_equivalence_accepted!==false || precipitation.module_details.provider_annual_summary_handling!=='not_consumed' || !precipitation.quality.warnings.includes('HIGH_LATITUDE_CORRECTION_REGIME_DIFFERS')) fail();
    const paired=temperature.series.filter((r,i)=>r.value!==null&&precipitation.series[i].value!==null).length;
    if (check.output_type!=='candidate_indicator_input_check' || check.schema_version!=='0.1.0' || check.technical_status!=='compatible' || !equal(check.reasons,[]) || check.paired_valid_months!==paired || check.scientific_acceptance!=='not_performed' || check.relationship_calculated!==false || !equal(check.input_result_ids,{temperature:temperature.result_id,precipitation:precipitation.result_id}) || !equal(check.units,{temperature:'degC',precipitation:'mm/day'}) || !equal([...new Set([...temperature.quality.warnings,...precipitation.quality.warnings])].sort(),check.warnings)) fail();
    await validateWorkflow(entry,temperature,precipitation);
    result.push({...entry,temperature,precipitation});
  }
  return {...data,regions:result};
}

async function validatePrecipitationHistory(record, controls, periods) {
  if (typeof record?.data_json !== 'string' || record.data_json.length > 300000
      || !hash(record.sha256) || await sha(record.data_json) !== record.sha256) fail();
  const history = JSON.parse(record.data_json);
  const years = Array.from({ length: 24 }, (_, i) => 2001 + i);
  const dates = years.flatMap((year) => Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`));
  const period = { calendar: 'gregorian', frequency: 'monthly', provider_time_standard: 'LST' };
  if (!equal(history.time, { ...period, start: dates[0], end: dates.at(-1) })
      || !equal(history.variable, { provider_parameter: 'PRECTOTCORR', unit: 'mm/day' })
      || !equal(Object.keys(history.source_files_sha256).sort(), ['a-tile-001.json', 'b-tile-001.json', 'b-tile-002.json', 'capture.json'])
      || !Object.values(history.source_files_sha256).every(hash)
      || !equal(history.regions.map(({ id }) => id), ['A', 'B'])
      || !equal([...periods.keys()].sort((a, b) => a - b), years)) fail();
  for (const { id, series, missing_counts: missing } of history.regions) {
    const control = controls.find((entry) => entry.id === id)?.precipitation;
    if (!control || !equal(series.map(({ date }) => date), dates) || !equal(missing.map(({ date }) => date), dates)
        || !equal(series.slice(-12), control.series) || !equal(missing.slice(-12), control.module_details.missing_counts)) fail();
    const count = control.spatial_support.cell_count;
    for (const [index, row] of series.entries()) {
      const valid = row.valid_cells, fraction = row.valid_area_fraction, value = row.value;
      const complete = valid === count;
      const gaps = [missing[index].provider_fill_cells, missing[index].not_returned_cells];
      if (!Number.isInteger(valid) || valid < 0 || valid > count || gaps.some((n) => !Number.isInteger(n) || n < 0)
          || gaps[0] + gaps[1] !== count - valid || row.status !== (complete ? 'complete' : 'incomplete')
          || (complete ? !close(fraction, 1) || !Number.isFinite(value) || value < 0
            : value !== null || !Number.isFinite(fraction) || fraction < 0 || fraction >= 1)
          || (valid === 0 && fraction !== 0)) fail();
    }
    for (const [index, year] of years.entries()) {
      const annual = periods.get(year).data;
      const region = annual.regions.find((entry) => entry.id === id);
      if (!region || !equal(annual.dates, dates.slice(index * 12, index * 12 + 12))
          || !equal(region.time, { ...period, start: dates[index * 12], end: dates[index * 12 + 11] })
          || !equal(region.region.candidate_bbox, control.region.candidate_bbox)
          || region.region.candidate_window_version !== control.region.candidate_window_version
          || region.support.cell_count !== count
          || !['provider', 'product', 'api_version', 'sources'].every(
            (key) => equal(region.provenance.temperature[key], control.provenance[key]))) fail();
    }
  }
  return history;
}

async function validateWorkflow(entry,temperature,precipitation) {
  const w=entry.workflow;
  if (!w || Object.keys(w).sort().join()!=='context_json,trace' || typeof w.context_json!=='string' || w.context_json.length>30000) fail();
  const c=JSON.parse(w.context_json), s=c.source_files_sha256, p=s?.precipitation;
  if (Object.keys(c).sort().join()!=='region_id,scope,source_files_sha256' || c.scope!=='candidate_coindexed_indicators' || c.region_id!==entry.id || !s || Object.keys(s).sort().join()!=='precipitation,temperature' || !p || Object.keys(p).sort().join()!=='audit,grid,temperature_controls' || Object.keys(p.temperature_controls).sort().join()!=='A,B') fail();
  for(const map of [s.temperature,p.grid,p.audit,...Object.values(p.temperature_controls)]) {
    if(!map||!Object.keys(map).length||!Object.entries(map).every(([k,v])=>/^(?:(?:[ab]-)?tile-\d{3}\.json|request\.json|response\.json|result\.json|manifest\.json|capture\.json|report\.json)$/.test(k)&&hash(v))) fail();
  }
  if (!equal(s.temperature,temperature.provenance.input_files_sha256.temperature) || !equal(p.grid,precipitation.provenance.input_files_sha256.grid) || !equal(p.audit,precipitation.provenance.input_files_sha256.audit) || p.temperature_controls[entry.id]['result.json']!==temperature.provenance.source_result_sha256) fail();
  const graph=traceGraph(w.trace), trace=w.trace;
  if(trace.target!=='InputCheck'||graph.nodes.length!==3||graph.edges.length!==2||trace.context_sha256!==await sha(w.context_json)) fail();
  const t={type:'candidate_monthly_indicator_result',schema_version:'0.1.0',unit:'degC'},r={...t,unit:'mm/day'},k={type:'candidate_indicator_input_check',schema_version:'0.1.0',unit:'1'};
  const link=(node,contract)=>({node,output:'result',contract});
  const definitions=[{id:'Precipitation',operation:'AdaptRecordedPrecipitation',version:'0.1.0',parameters:{},inputs:{},output_contract:r},
    {id:'Temperature',operation:'AdaptRecordedTemperature',version:'0.1.0',parameters:{},inputs:{},output_contract:t},
    {id:'InputCheck',operation:'CheckCoindexedIndicators',version:'0.1.0',parameters:{},inputs:{temperature:link('Temperature',t),precipitation:link('Precipitation',r)},output_contract:k}];
  const hashes={};
  for(const [i,d] of definitions.entries()) {
    const dependencies=Object.fromEntries(Object.entries(d.inputs).map(([a,v])=>[a,hashes[v.node]]));
    hashes[d.id]=await sha(`{"context":${w.context_json},"dependencies":${canonical(dependencies)},"node":${canonical(d)}}`);
    const n=trace.nodes[i];
    if(n.id!==d.id||n.operation!==d.operation||n.operation_version!==d.version||!equal(n.output_contract,d.output_contract)||n.definition_fingerprint!==hashes[d.id]) fail();
  }
}

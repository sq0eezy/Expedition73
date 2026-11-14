import { ANOMALY_REFERENCE_PERIOD, summarizePolicyDifferences, summarizeRegionDifferences, datasetDigest, createComparisonReview, verifyComparisonReview, recordedMonthlyHistory, validateAnnualPreview, summarizeTemperatureAnomalies, summarizeTemperatureTrends } from "./comparison.mjs";
import { traceGraph, validateAnnualWorkflow } from "./trace.mjs";
import { seasonalProfilesByYear, summarizePrecipitationTrends, validateIndicatorPreview } from "./indicators.mjs";
import { createWeatherGlobe } from "./globe.mjs";

const $ = (id) => document.getElementById(id);
async function fetchRecordedData(url) {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw Error("Recorded data unavailable");
    return new Uint8Array(await response.arrayBuffer());
  } finally {
    clearTimeout(deadline);
  }
}
const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const shortMonths = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const colors = ["#c77543", "#247c78", "#7466a1", "#777c39", "#a3536b", "#3878a6", "#8c6238", "#626c6a"];
const labels = { unmasked: "Whole region · unmasked", land: "Land fraction · FRLAND (candidate)", land_and_ice: "Land + land ice (candidate)" };
const state = { data: null, selected: new Set(), month: 0, policy: "unmasked", spatialRegion: null, cell: 0, traceRegion: null, traceNode: null, pairLeft: null, pairRight: null, datasetSha256: null, reviewRequest: 0, periods: new Map(), year: null, historyDates: [], annual: null, annualStatus: "loading", annualRequest: 0, annualTables: new Set(), annualSources: new Set(), annualWorkflows: new Set(), annualTraceNodes: new Map(), annualTraces: new Map() };
const number = (value, digits = 2) => value === null ? "No data" : value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
Object.assign(state,{indicators:null,seasonalYears:new Map(),indicatorStatus:'loading',indicatorTraceRegion:null,indicatorTraceNode:'InputCheck'});
const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
const color = (region) => colors[state.data.regions.indexOf(region) % colors.length];
// The recorded catalog predates the English interface and is bound to saved reports by hash.
const recordedNames = new Map([
  ["Colorado çevresi", "Colorado area"],
  ["Kuzey Alaska", "Northern Alaska"],
]);
const recordedDescriptions = new Map([
  ["Colorado çevresi aday dikdörtgeni: maskesiz teknik alan denemesi", "Candidate rectangle in the Colorado area used for the unmasked regional pilot."],
  ["Kuzey Alaska aday dikdörtgeni: parçalı erişim teknik modül denemesi", "Candidate rectangle in Northern Alaska used for the tiled retrieval pilot."],
]);
const named = (region) => recordedNames.get(region.display_name) ?? region.display_name;
const regionDescription = (region) => recordedDescriptions.get(region.label) ?? region.label;
const active = () => state.data.regions.filter((region) => state.selected.has(region.id));
const value = (region, index) => region.series[index][state.policy];
const svg = (tag, attributes, text) => { const node = document.createElementNS("http://www.w3.org/2000/svg", tag); for (const [key, v] of Object.entries(attributes)) node.setAttribute(key, v); if (text !== undefined) node.textContent = text; return node; };

function syncScreen() {
  const workspace = document.querySelector("[data-workspace][aria-selected=true]").dataset.workspace;
  const view = $(`views-${workspace}`).querySelector("[aria-selected=true]").dataset.view;
  document.body.dataset.screen = view;
  for (const bar of document.querySelectorAll(".view-bar [role=tablist]")) bar.hidden = bar.id !== `views-${workspace}`;
  for (const block of document.querySelectorAll("[data-screens]")) {
    block.hidden = !block.dataset.screens.split(" ").includes(view)
      || block.id === "indicator-workflow-filters" && state.year !== 2024;
  }
  document.querySelector("[data-outside-indicators]").hidden = workspace === "indicators" || view === "trend";
  if (state.data && view === "trend") renderTrend(active());
  if (state.data) syncWeatherView(view);
}

function connectTabs(list) {
  const tabs = [...list.querySelectorAll("[role=tab]")];
  const activate = (tab, focus = false) => {
    for (const item of tabs) {
      const selected = item === tab;
      item.setAttribute("aria-selected", String(selected));
      item.tabIndex = selected ? 0 : -1;
      $(item.getAttribute("aria-controls")).hidden = !selected;
    }
    if (focus) tab.focus({ preventScroll: true });
    if (tab.offsetLeft < list.scrollLeft) list.scrollLeft = tab.offsetLeft;
    if (tab.offsetLeft + tab.offsetWidth > list.scrollLeft + list.clientWidth) {
      list.scrollLeft = tab.offsetLeft + tab.offsetWidth - list.clientWidth;
    }
    for (const sheet of document.querySelectorAll(".with-sheet[open]")) sheet.open = false;
    setFilters(false);
    syncScreen();
  };
  for (const tab of tabs) {
    tab.addEventListener("click", () => activate(tab));
    tab.addEventListener("keydown", (event) => {
      const index = tabs.indexOf(tab);
      const target = { ArrowRight: (index + 1) % tabs.length, ArrowLeft: (index + tabs.length - 1) % tabs.length, Home: 0, End: tabs.length - 1 }[event.key];
      if (target !== undefined) { event.preventDefault(); activate(tabs[target], true); }
    });
  }
}
for (const tablist of document.querySelectorAll("[role=tablist]")) connectTabs(tablist);

function setFilters(open) {
  $("results").classList.toggle("filters-open", open);
  $("toggle-filters").setAttribute("aria-expanded", String(open));
}
$("toggle-filters").addEventListener("click", () => {
  const open = !$("results").classList.contains("filters-open");
  setFilters(open);
  if (open) $("close-filters").focus();
});
$("close-filters").addEventListener("click", () => { setFilters(false); $("toggle-filters").focus(); });
for (const [id, key] of [["compare-chart-choice", "compareChart"], ["indicator-chart-choice", "indicatorChart"]]) {
  $(id).addEventListener("change", () => { document.body.dataset[key] = $(id).value; });
}

function attachDetailSheets(parent) {
  for (const details of parent.querySelectorAll("details:not(.with-sheet)")) {
    const summary = details.firstElementChild;
    const sheet = el("div", undefined, "detail-sheet");
    const body = el("div", undefined, "detail-sheet-body");
    const close = el("button", "Close");
    close.type = "button";
    close.addEventListener("click", () => { details.open = false; summary.focus(); });
    const heading = el("div", undefined, "detail-sheet-heading");
    heading.append(el("strong", summary.textContent), close);
    body.append(...[...details.children].slice(1));
    sheet.append(heading, body);
    details.append(sheet);
    details.classList.add("with-sheet");
    summary.addEventListener("click", () => {
      if (details.open) return;
      for (const other of document.querySelectorAll(".with-sheet[open]")) other.open = false;
      requestAnimationFrame(() => { if (details.open) close.focus({ preventScroll: true }); });
    });
  }
}
attachDetailSheets($("workspace-canvas"));
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  const sheet = [...document.querySelectorAll(".with-sheet[open]")].find((item) => item.getClientRects().length);
  if (sheet) { sheet.open = false; sheet.firstElementChild.focus(); }
  else if ($("results").classList.contains("filters-open")) { setFilters(false); $("toggle-filters").focus(); }
});

function validate(data) {
  if (data.schema_version !== "0.3.0" || data.output_type !== "recorded_temperature_web_preview" || data.data_mode !== "recorded_offline_replay" || data.selection_status !== "candidate" || data.inference_performed !== false) throw Error("Unsupported preview contract");
  if (!Array.isArray(data.dates) || data.dates.length !== 12 || !data.dates.every((d, i) => d === `${data.dates[0].slice(0, 4)}-${String(i + 1).padStart(2, "0")}`)) throw Error("Unsupported period");
  if (!Array.isArray(data.regions) || !data.regions.length || data.regions.length > 8 || new Set(data.regions.map((r) => r.id)).size !== data.regions.length) throw Error("Unsupported regions");
  let context;
  for (const region of data.regions) {
    if (typeof region.id !== "string" || typeof region.display_name !== "string" || !region.display_name.trim() || region.region.id !== region.id || region.region.selection_status !== "candidate" || region.variable.unit !== "degC" || region.variable.height_m !== 2 || region.variable.id !== "air_temperature_2m") throw Error("Unsupported indicator");
    if (region.series.length !== 12 || !region.series.every((row, i) => row.date === data.dates[i] && Object.keys(labels).every((key) => row[key] === null || typeof row[key] === "number" && Number.isFinite(row[key])))) throw Error("Invalid series");
    if (region.source_area.comparison_performed !== false || region.source_area.numeric_values_retrieved !== false) throw Error("Unexpected AREA claim");
    const provider = region.provenance.temperature;
    const signature = JSON.stringify([region.variable.id, region.variable.unit, region.variable.height_m, ...["frequency", "start", "end", "calendar", "provider_time_standard"].map((key) => region.time[key]), provider.provider, provider.product, provider.api_version, [...provider.sources].sort()]);
    if (context !== undefined && signature !== context) throw Error("Incompatible comparison context");
    context = signature;
    summarizePolicyDifferences(region.series);
    validateSpatial(region, data.dates);
    traceGraph(region.workflow_trace);
    for (const key of ["land", "land_and_ice"]) {
      const support = region.support.policies[key];
      if (![support.lower_fraction_of_window, support.uniform_fraction_of_window, support.upper_fraction_of_window].every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1)) throw Error("Invalid area support");
      if (support.lower_fraction_of_window > support.uniform_fraction_of_window || support.uniform_fraction_of_window > support.upper_fraction_of_window) throw Error("Invalid area bounds");
    }
  }
  // Check every selectable pair/policy now, so invalid arithmetic cannot surface
  // later only after a user changes a selector.
  for (let a = 0; a < data.regions.length; a++) for (let b = a + 1; b < data.regions.length; b++)
    for (const policy of Object.keys(labels)) summarizeRegionDifferences(data.regions[a], data.regions[b], policy);
}

function validateSpatial(region, dates) {
  const s = region.spatial, bbox = region.region.candidate_bbox;
  const finite = (v) => typeof v === "number" && Number.isFinite(v);
  const bounds = (b) => Array.isArray(b) && b.length === 4 && b.every(finite) && b[0] < b[2] && b[1] < b[3] && b[0] >= -180 && b[2] <= 180 && b[1] >= -90 && b[3] <= 90;
  const close = (a, b) => Math.abs(a - b) <= Math.max(1, Math.abs(b)) * 1e-9;
  if (!s || s.geometry !== "reconstructed_midpoint_rectangles" || s.fraction_placement !== "uniform_within_full_cell_assumption" || s.longitude_step_deg !== 0.625 || s.latitude_step_deg !== 0.5 || s.area_radius_m !== 6371008.8 || !bounds(bbox) || !Array.isArray(s.cells) || !s.cells.length || s.cells.length !== region.support.cell_count) throw Error("Invalid spatial context");
  const keys = new Set(), sums = { unmasked: 0, land: 0, land_and_ice: 0 };
  for (const c of s.cells) {
    const key = `${c.longitude},${c.latitude}`, f = c.fractions, part = c.intersection_bbox;
    if (!finite(c.longitude) || !finite(c.latitude) || keys.has(key) || !bounds(c.full_cell_bbox) || !bounds(part)) throw Error("Invalid cell geometry");
    keys.add(key);
    const full = [c.longitude - 0.3125, c.latitude - 0.25, c.longitude + 0.3125, c.latitude + 0.25];
    const intersection = [Math.max(full[0], bbox[0]), Math.max(full[1], bbox[1]), Math.min(full[2], bbox[2]), Math.min(full[3], bbox[3])];
    if (!full.every((v, i) => close(v, c.full_cell_bbox[i])) || !intersection.every((v, i) => close(v, part[i])) || c.clipped !== full.some((v, i) => !close(v, part[i]))) throw Error("Invalid cell intersection");
    const area = s.area_radius_m ** 2 * (part[2] - part[0]) * Math.PI / 180 * (Math.sin(part[3] * Math.PI / 180) - Math.sin(part[1] * Math.PI / 180));
    if (!finite(c.intersection_area_m2) || !close(c.intersection_area_m2, area) || !f || !["FRLAND", "FRLANDICE", "FRLAKE", "FROCEAN"].every((k) => finite(f[k]) && f[k] >= 0 && f[k] <= 1) || Math.abs(f.FRLAND + f.FRLANDICE + f.FRLAKE + f.FROCEAN - 1) > 1e-6) throw Error("Invalid cell fractions or area");
    const factors = { unmasked: 1, land: f.FRLAND, land_and_ice: f.FRLAND + f.FRLANDICE };
    for (const policy of Object.keys(labels)) {
      if (!finite(c.weights_m2[policy]) || !close(c.weights_m2[policy], c.intersection_area_m2 * factors[policy])) throw Error("Invalid cell weight");
      sums[policy] += c.weights_m2[policy];
    }
    if (!Array.isArray(c.series) || c.series.length !== 12 || !c.series.every((r, i) => r.date === dates[i] && (r.value === null || finite(r.value)))) throw Error("Invalid cell series");
  }
  if (!close(sums.unmasked, region.support.window_area_m2) || !["land", "land_and_ice"].every((p) => close(sums[p], region.support.policies[p].uniform_estimate_m2))) throw Error("Cell coverage disagrees with aggregate");
}

function metric(title, temperature, note, region, difference = false) {
  const box = el("article", undefined, `metric${difference ? " difference" : ""}`);
  const head = el("div", undefined, "metric-head");
  if (region) { const dot = el("span", undefined, "swatch"); dot.style.setProperty("--region-color", color(region)); head.append(dot); }
  head.append(el("span", title));
  const big = el("strong", number(temperature, 3)); if (temperature !== null) big.append(el("span", "°C"));
  box.append(head, big, el("small", note)); return box;
}

function renderMetrics(regions) {
  const fragment = document.createDocumentFragment();
  const left = regions.find((r) => r.id === state.pairLeft);
  const right = regions.find((r) => r.id === state.pairRight);
  const shown = left && right ? [left, right] : regions;
  for (const region of shown) fragment.append(metric(`${region.id} · ${named(region)}`, value(region, state.month), "Monthly mean for the candidate region", region));
  if (left && right) {
    const paired = summarizeRegionDifferences(left, right, state.policy);
    fragment.append(metric(`${left.id} − ${right.id} · selected month difference`, paired.compatible ? paired.values[state.month].delta : null, paired.compatible ? "Descriptive spatial difference" : "Data compatibility check failed", null, true));
  }
  $("metrics-context").textContent = `${months[state.month]} ${state.year} · ${left && right ? `${left.id} − ${right.id} comparison` : regions.length ? "One region" : "Select a region"}${regions.length > 2 ? ` · ${regions.length} regions on the chart` : ""}`;
  $("metrics").replaceChildren(fragment);
  $("metrics").style.gridTemplateColumns = `repeat(${left && right ? 3 : Math.max(1, shown.length)},minmax(0,1fr))`;
}

function renderChart(regions) {
  const chart = $("chart"); chart.replaceChildren(svg("title", { id: "chart-title" }, `${state.data.dates[0].slice(0, 4)} monthly air temperature at 2 m`), svg("desc", { id: "chart-desc" }, "Monthly series for the selected candidate regions. The table lists the recorded values. Gaps show missing months."));
  $("empty").hidden = regions.length > 0; $("chart-wrap").hidden = regions.length === 0;
  const values = regions.flatMap((r) => r.series.map((_, i) => value(r, i))).filter((v) => v !== null);
  const min = Math.floor((Math.min(0, ...values) - 2) / 10) * 10;
  const max = Math.ceil((Math.max(0, ...values) + 2) / 10) * 10;
  const compact = window.matchMedia("(max-width:740px)").matches;
  const width = compact ? 400 : 640;
  const left = compact ? 34 : 45, right = width - (compact ? 14 : 25), top = 18, bottom = compact ? 220 : 251;
  chart.setAttribute("viewBox", `0 0 ${width} ${bottom + 39}`);
  const x = (i) => left + i / 11 * (right - left), y = (v) => bottom - (v - min) / (max - min) * (bottom - top);
  for (let tick = min; tick <= max; tick += 10) {
    chart.append(svg("line", { x1: left, y1: y(tick), x2: right, y2: y(tick), class: tick === 0 ? "chart-grid chart-zero" : "chart-grid" }), svg("text", { x: left - 13, y: y(tick) + 3, "text-anchor": "end", class: "chart-text" }, String(tick)));
  }
  for (let i = 0; i < 12; i++) if (!compact || [0, 2, 4, 6, 8, 11].includes(i)) chart.append(svg("text", { x: x(i), y: bottom + 24, "text-anchor": "middle", class: "chart-text" }, shortMonths[i]));
  chart.append(svg("line", { x1: x(state.month), y1: top, x2: x(state.month), y2: bottom, class: "chart-focus" }));
  for (const region of regions) {
    let path = "", connected = false;
    region.series.forEach((_, i) => { const v = value(region, i); if (v === null) { connected = false; return; } path += `${connected ? "L" : "M"}${x(i)},${y(v)} `; connected = true; });
    const line = svg("path", { d: path, class: "chart-path", "data-region": region.id }); line.style.setProperty("--region-color", color(region)); chart.append(line);
    const current = value(region, state.month);
    if (current !== null) { const point = svg("circle", { cx: x(state.month), cy: y(current), r: 5, class: "chart-point" }); point.style.setProperty("--region-color", color(region)); point.append(svg("title", {}, `${region.id} · ${months[state.month]}: ${number(current)} °C`)); chart.append(point); }
  }
  $("legend").replaceChildren(...regions.map((r) => { const item = el("span", undefined, "legend-item"); item.style.setProperty("--region-color", color(r)); item.append(el("span", undefined, "legend-line"), el("span", `${r.id} · ${named(r)}`)); return item; }));
  $("chart-caption").textContent = `${labels[state.policy]}. Recorded monthly grid temperatures. Gaps show missing months. The vertical scale follows the visible series.`;
}

function renderHistory(regions) {
  state.historyDates = [];
  const hide = () => { $("history-content").hidden = true; $("history-month").disabled = true; };
  for (const id of ["history-chart", "history-table", "history-legend"]) $(id).replaceChildren();
  $("history-status").className = "detail-note";
  if (!regions.length) { hide(); $("history-status").textContent = "Select at least one candidate region to view the full record."; return; }
  let history;
  try { history = recordedMonthlyHistory([...state.periods.values()].map((p) => p.data), regions.map((r) => r.id), state.policy); }
  catch {
    hide();
    $("history-status").className = "pair-blocked";
    $("history-status").textContent = "Annual records have different sources, boundaries, grids, weights or calculation contracts. Use the Selected year tab to view them individually.";
    return;
  }
  state.historyDates = history.dates;
  const count = history.dates.length, selected = history.dates.indexOf(state.data.dates[state.month]);
  $("history-content").hidden = false; $("history-month").disabled = false;
  $("history-month").max = String(count - 1); $("history-month").value = String(selected);
  const date = history.dates[selected], shown = `${months[Number(date.slice(-2)) - 1]} ${date.slice(0, 4)}`;
  $("history-month-label").textContent = shown; $("history-month").setAttribute("aria-valuetext", shown);
  $("history-status").textContent = `${history.dates[0]}–${history.dates.at(-1)} · ${count} monthly records · ${labels[state.policy]}. ${history.series.map((r) => `${r.id}: ${r.valid_months}/${count} valid months`).join(" · ")}`;
  const chart = $("history-chart"), compact = window.matchMedia("(max-width:740px)").matches;
  const width = compact ? 400 : 920, left = compact ? 34 : 45, right = width - 20, top = 18, bottom = 236;
  chart.setAttribute("viewBox", `0 0 ${width} 277`);
  chart.append(svg("title", { id: "history-chart-title" }, `${history.years[0]}–${history.years.at(-1)} recorded monthly air temperature`),
    svg("desc", { id: "history-chart-desc" }, "Each recorded month appears in sequence. Gaps show missing values. The month control opens the matching year and month details. The table lists the recorded values."));
  const values = history.series.flatMap((r) => r.values.map((v) => v.value)).filter((v) => v !== null);
  const min = Math.floor((Math.min(0, ...values) - 2) / 10) * 10, max = Math.ceil((Math.max(0, ...values) + 2) / 10) * 10;
  const x = (i) => left + i / (count - 1) * (right - left), y = (v) => bottom - (v - min) / (max - min) * (bottom - top);
  for (let tick = min; tick <= max; tick += 10) chart.append(svg("line", { x1: left, x2: right, y1: y(tick), y2: y(tick), class: tick === 0 ? "chart-grid chart-zero" : "chart-grid" }), svg("text", { x: left - 9, y: y(tick) + 3, "text-anchor": "end", class: "chart-text" }, String(tick)));
  const ticks = [...new Set([0, ...history.years.map((_, i) => i * 12).filter((i) => i > 0 && i < count - 12 && (i / 12) % (compact ? 8 : 4) === 0), count - 1])];
  for (const i of ticks) chart.append(svg("text", { x: x(i), y: bottom + 25, "text-anchor": i === 0 ? "start" : i === count - 1 ? "end" : "middle", class: "chart-text" }, history.dates[i].slice(0, 4)));
  chart.append(svg("line", { x1: x(selected), x2: x(selected), y1: top, y2: bottom, class: "chart-focus" }));
  for (const row of history.series) {
    const region = regions.find((r) => r.id === row.id); let path = "", connected = false;
    row.values.forEach(({ value: v }, i) => { if (v === null) { connected = false; return; } path += `${connected ? "L" : "M"}${x(i)},${y(v)} `; connected = true; });
    const line = svg("path", { d: path, class: "chart-path history-path", "data-region": row.id, "data-records": count, "data-valid": row.valid_months }); line.style.setProperty("--region-color", color(region)); chart.append(line);
    const temperature = row.values[selected].value;
    if (temperature !== null) { const point = svg("circle", { cx: x(selected), cy: y(temperature), r: 4, class: "chart-point" }); point.style.setProperty("--region-color", color(region)); point.append(svg("title", {}, `${row.id} · ${shown}: ${number(temperature)} °C`)); chart.append(point); }
  }
  $("history-legend").replaceChildren(...regions.map((r) => { const item = el("span", undefined, "legend-item"); item.style.setProperty("--region-color", color(r)); item.append(el("span", undefined, "legend-line"), el("span", `${r.id} · ${named(r)}`)); return item; }));
  const head = el("thead"), header = el("tr"); header.append(el("th", "Month")); for (const row of history.series) header.append(el("th", `${row.id} · °C`)); head.append(header);
  const body = el("tbody");
  history.dates.forEach((date, i) => { const tr = el("tr"); tr.dataset.date = date; tr.append(el("th", date)); for (const row of history.series) tr.append(el("td", number(row.values[i].value, 6))); body.append(tr); });
  $("history-table").append(el("caption", `${labels[state.policy]} · ${count} recorded months · °C`), head, body);
}

function renderAnnual(regions) {
  const regionSelect = $("annual-region");
  const priorRegion = regionSelect.value;
  regionSelect.replaceChildren(...regions.map((region) => {
    const option = el("option", `${region.id} · ${named(region)}`);
    option.value = region.id;
    return option;
  }));
  regionSelect.value = regions.some(({ id }) => id === priorRegion) ? priorRegion : regions[0]?.id ?? "";
  for (const card of $("annual-cards").children) {
    for (const [selector,set] of [[".annual-values",state.annualTables],[".annual-source",state.annualSources],[".annual-workflow",state.annualWorkflows]]) {
      if (card.querySelector(selector)?.open) set.add(card.dataset.region); else set.delete(card.dataset.region);
    }
  }
  $("annual-cards").replaceChildren();
  $("annual-year").textContent = String(state.year);
  if (state.policy !== "unmasked") { $("annual-status").textContent = "Select Whole region · unmasked to view annual summaries. Annual values are available for the full region."; return; }
  if (!regions.length) { $("annual-status").textContent = "Select at least one region to view annual summaries."; return; }
  if (state.annualStatus === "loading") { $("annual-status").textContent = "Verifying annual summaries against the monthly dataset…"; return; }
  if (!state.annual || state.annual.status !== "available") { $("annual-status").textContent = "Annual summaries are unavailable for this monthly dataset. Rebuild the preview from the same source and open it in a browser with Web Crypto. You can still view the monthly charts."; return; }
  $("annual-status").textContent = "Candidate annual means for the whole unmasked region. Both weighting methods are under review.";
  const signed = (v) => v === null ? "No data" : `${v >= 0.0000005 ? "+" : ""}${number(Math.abs(v) < 0.0000005 ? 0 : v,6)} °C`;
  for (const [index,region] of regions.entries()) {
    const audit = state.annual.regions.find((r) => r.id === region.id).audit, row = audit.series.find((r) => r.year === state.year);
    const card = el("article",undefined,"annual-card"); card.dataset.region = region.id; card.style.setProperty("--region-color",color(region));
    card.append(el("h3",`${region.id} · ${named(region)} / ${state.year}`));
    const trace = state.annualTraces.get(region.id);
    if (trace) {
      const flow = el("details",undefined,"annual-workflow"), layout = el("div",undefined,"trace-layout"), graph = svg("svg",{class:"annual-trace-graph",role:"group","aria-label":`${region.id} · Annual calculation dependencies`}), detail = el("div",undefined,"annual-trace-detail");
      flow.open = state.annualWorkflows.has(region.id);
      flow.append(el("summary","Annual workflow · 2 steps · 1 data dependency"),el("p",`${region.id} · ${audit.time.start}–${audit.time.end} record verified. This workflow produced the selected ${state.year} result. Select a step with the mouse or press Tab and Enter for details.`,"detail-note"));
      drawTrace(trace,graph,detail,state.annualTraceNodes.get(region.id),`annual-arrow-${region.id}`,(id)=>{
        state.annualTraceNodes.set(region.id,id); renderAnnual(active());
        [...$("annual-cards").children].find((c)=>c.dataset.region===region.id)?.querySelector(`.annual-trace-graph [data-node="${id}"]`)?.focus({preventScroll:true});
      });
      layout.append(graph,detail); flow.append(layout,el("p","Recorded workflow verified during the build. The step definition hash identifies the source and operation definition.","detail-note")); card.append(flow);
    } else card.append(el("p","The annual workflow trace is missing or could not be verified. Annual values and monthly charts remain available.","annual-trace-unavailable detail-note"));
    const values = el("div",undefined,"annual-metrics");
    for (const [key,label,v] of [["equal","Equal months · candidate",row.equal_month_mean_degC],["calendar","Calendar days · candidate",row.calendar_day_mean_degC],["provider","API annual grid summary",row.provider_annual.area_weighted_mean_degC]]) {
      const box = el("div"); box.dataset.annualValue = key; box.append(el("span",label),el("strong",v===null?"No data":`${number(v,6)} °C`)); values.append(box);
    }
    card.append(values,el("p",`Calendar days − equal months: ${signed(row.calendar_minus_equal_degC)}`,"annual-difference"),
      el("p",`${row.valid_months}/12 complete months · ${row.valid_calendar_days}/${row.calendar_days} calendar days. Both candidate means require all twelve months.`,"detail-note"));
    const source = el("details",undefined,"annual-source"), facts = el("div"); source.append(el("summary","View sources and calculation details"));
    source.open = state.annualSources.has(region.id);
    facts.append(el("p",`API summary − equal months: ${signed(row.provider_annual.provider_minus_equal_degC)}`),el("p",`API summary − calendar days: ${signed(row.provider_annual.provider_minus_calendar_degC)}`),
      el("p",`API annual reference: ${row.provider_annual.valid_cells}/${row.provider_annual.expected_cells} grid cells. The reference and the candidate means use the same provider.`),
      el("p",`Module ${audit.module.version} · output ${audit.schema_version} · ${audit.time.calendar} / ${audit.time.provider_time_standard}`),
      el("p",`Recorded history result SHA-256: ${audit.provenance.source_history_result_sha256}`,"hash")); source.append(facts); card.append(source);
    card.append(el("h4","Difference between annual weighting methods"),el("p","Calendar days − equal months · °C. Each value compares the two methods for the same year.","detail-note"));
    const plotWidth = window.matchMedia("(max-width:740px)").matches ? 400 : 920;
    const chart = svg("svg",{viewBox:`0 0 ${plotWidth} 190`,role:"img","aria-labelledby":`annual-title-${index} annual-desc-${index}`,class:"annual-chart"});
    chart.append(svg("title",{id:`annual-title-${index}`},`${region.id} annual weighting differences`),svg("desc",{id:`annual-desc-${index}`},"Difference between the two calculated annual means. Gaps show missing years. The table lists the values."));
    const extent = Math.max(0.001,...audit.series.map((r) => r.calendar_minus_equal_degC===null?0:Math.abs(r.calendar_minus_equal_degC))), left = 60, right = plotWidth-18;
    const x = (i) => left + i/Math.max(1,audit.series.length-1)*(right-left), y = (v) => 81-(v/extent)*62;
    for (const tick of [-extent,0,extent]) chart.append(svg("line",{x1:left,x2:right,y1:y(tick),y2:y(tick),class:tick===0?"chart-grid chart-zero":"chart-grid"}),svg("text",{x:left-10,y:y(tick)+3,"text-anchor":"end",class:"chart-text"},number(tick,3)));
    const ticks = [...new Set([0,Math.floor((audit.series.length-1)/2),audit.series.length-1])];
    for (const i of ticks) chart.append(svg("text",{x:x(i),y:172,"text-anchor":i===0?"start":i===audit.series.length-1?"end":"middle",class:"chart-text"},String(audit.series[i].year)));
    let path = "", connected = false;
    audit.series.forEach((r,i) => { if (r.calendar_minus_equal_degC===null) { connected=false; return; } path+=`${connected?"L":"M"}${x(i)},${y(r.calendar_minus_equal_degC)} `; connected=true; });
    chart.append(svg("path",{d:path,class:"annual-line","data-years":audit.series.length}));
    if (row.calendar_minus_equal_degC!==null) chart.append(svg("circle",{cx:x(audit.series.indexOf(row)),cy:y(row.calendar_minus_equal_degC),r:4,class:"annual-point"})); card.append(chart);
    const details = el("details",undefined,"annual-values"), scroll = el("div",undefined,"table-scroll"), table = el("table");
    details.open = state.annualTables.has(region.id);
    details.append(el("summary","View all years in a table")); table.append(el("caption","Candidate annual means for the unmasked region · °C · select a year for monthly details"));
    const head = el("thead"), header = el("tr"); for (const label of ["Year", "Complete months", "Equal months", "Calendar days", "API annual", "Days − months"]) header.append(el("th",label)); head.append(header); table.append(head);
    const body = el("tbody");
    for (const r of audit.series) {
      const tr = el("tr"); tr.dataset.year = r.year; if(r.year===state.year) tr.className="annual-chosen";
      const th = el("th"), button = el("button",String(r.year)); button.type="button"; button.setAttribute("aria-label",`Open ${region.id} monthly details for ${r.year}`);
      button.dataset.year = String(r.year);
      button.addEventListener("click",() => { mountYear(r.year); const chosen = [...$("annual-cards").children].find((c) => c.dataset.region === region.id); chosen?.querySelector(`button[data-year="${r.year}"]`)?.focus({preventScroll:true}); }); th.append(button); tr.append(th,el("td",`${r.valid_months}/12`));
      for (const v of [r.equal_month_mean_degC,r.calendar_day_mean_degC,r.provider_annual.area_weighted_mean_degC,r.calendar_minus_equal_degC]) tr.append(el("td",number(v,6)));
      body.append(tr);
    }
    table.append(body); scroll.append(table); details.append(scroll); card.append(details);
    attachDetailSheets(card);
    $("annual-cards").append(card);
  }
  showAnnualRegion();
}

function renderTrendSeries(entries, unit, anomaly = false) {
  const chart = $("trend-chart"), legend = $("trend-legend");
  chart.replaceChildren();
  legend.replaceChildren();
  const complete = entries.filter(({ result }) => result).map((entry) => {
    const mean = entry.rows.reduce((sum, { value }) => sum + value, 0) / entry.rows.length;
    const halfChange = entry.result.slope * 11.5 / 10;
    return { ...entry, start: mean - halfChange, end: mean + halfChange };
  });
  $("trend-series").hidden = !complete.length;
  if (!complete.length) return;

  const values = complete.flatMap(({ rows, start, end }) => [...rows.map(({ value }) => value), start, end, ...(anomaly ? [0] : [])]);
  const min = Math.min(...values), max = Math.max(...values);
  const padding = (max - min || 1) * 0.08;
  const low = min - padding, high = max + padding;
  const x = (year) => 60 + (year - 2001) * 558 / 23;
  const y = (value) => 183 - (value - low) * 159 / (high - low);
  chart.setAttribute("aria-label", anomaly
    ? `Temperature anomalies, 2001–2024, ${unit}. Relative to each region’s ${ANOMALY_REFERENCE_PERIOD.label} mean. Solid lines show annual anomalies. Dashed lines show fitted trends.`
    : `Annual means, 2001–2024, ${unit}. Solid lines show recorded annual means. Dashed lines show fitted trends.`);
  const ticks = Array.from({ length: 5 }, (_, i) => low + (high - low) * i / 4);
  for (const tick of ticks) {
    const isZero = anomaly && Math.abs(tick) < 1e-9;
    chart.append(svg("line", { x1: 60, x2: 618, y1: y(tick), y2: y(tick), class: isZero ? "chart-grid chart-zero" : "chart-grid" }),
      svg("text", { x: 51, y: y(tick) + 4, "text-anchor": "end", class: "chart-text" }, number(tick)));
  }
  if (anomaly && ticks.every((tick) => Math.abs(tick) >= 1e-9)) {
    chart.append(svg("line", { x1: 60, x2: 618, y1: y(0), y2: y(0), class: "chart-grid chart-zero", "data-zero-line": "0" }));
    if (ticks.every((tick) => Math.abs(y(tick) - y(0)) > 12)) {
      chart.append(svg("text", { x: 51, y: y(0) + 4, "text-anchor": "end", class: "chart-text" }, number(0)));
    }
  }
  for (const year of [2001, 2006, 2012, 2018, 2024]) {
    chart.append(svg("text", { x: x(year), y: 207, "text-anchor": "middle", class: "chart-text" }, String(year)));
  }
  for (const { id, region, rows, start, end } of complete) {
    const stroke = color(region);
    chart.append(svg("polyline", { points: rows.map(({ year, value }) => `${x(year)},${y(value)}`).join(" "),
      fill: "none", stroke, "stroke-width": 2, "data-region": id, "data-records": rows.length }),
      svg("line", { x1: x(2001), x2: x(2024), y1: y(start), y2: y(end), stroke, "stroke-width": 2, "stroke-dasharray": "5 4" }));
    const label = el("span", named(region));
    label.style.color = stroke;
    legend.append(label);
  }
  legend.append(el("span", anomaly
    ? `${unit} · Relative to each region’s ${ANOMALY_REFERENCE_PERIOD.label} mean · dashed lines show fitted trends`
    : `${unit} · dashed lines show fitted trends`));
}

function renderTrendTable(entries, unit, indicator, anomaly = false) {
  const details = $("trend-table-panel"), table = $("trend-table"), download = $("trend-csv");
  const columns = entries.filter(({ result }) => result);
  details.hidden = !columns.length;
  download.disabled = !columns.length;
  download.textContent = anomaly ? "Download temperature anomalies as CSV" : "Download annual values as CSV";
  if (!columns.length) {
    details.open = false;
    table.replaceChildren();
    download.onclick = null;
    return;
  }

  const head = el("thead"), header = el("tr");
  for (const label of ["Year", ...columns.map(({ id, region }) => anomaly
    ? `${id} · ${named(region)} anomaly vs ${ANOMALY_REFERENCE_PERIOD.label} (${unit})`
    : `${id} · ${named(region)} (${unit})`)]) {
    const cell = el("th", label);
    cell.scope = "col";
    header.append(cell);
  }
  head.append(header);

  const unitCode = indicator === "temperature" ? "degC" : "mm_per_day";
  const csvHeader = anomaly
    ? ["year", ...columns.map(({ id }) => `"region_${id.replaceAll('"', '""')}_anomaly_${ANOMALY_REFERENCE_PERIOD.start}_${ANOMALY_REFERENCE_PERIOD.end}_${unitCode}"`)]
    : ["year", ...columns.map(({ id }) => `"region_${id.replaceAll('"', '""')}_${unitCode}"`)];
  const csv = [csvHeader.join(",")];
  const body = el("tbody");
  columns[0].rows.forEach(({ year }, index) => {
    const values = columns.map(({ rows }) => rows[index].value);
    const row = el("tr"), label = el("th", String(year));
    label.scope = "row";
    row.append(label, ...values.map((value) => el("td", number(value, 6))));
    body.append(row);
    csv.push([year, ...values].join(","));
  });
  const caption = anomaly
    ? `NASA POWER annual temperature anomalies, 2001–2024 · Relative to each region’s ${ANOMALY_REFERENCE_PERIOD.label} mean (${unit})`
    : `NASA POWER annual means, 2001–2024 · ${unit}`;
  table.replaceChildren(el("caption", caption), head, body);
  const filename = anomaly
    ? `expedition73-temperature-anomalies-2001-2024-ref-${ANOMALY_REFERENCE_PERIOD.start}-${ANOMALY_REFERENCE_PERIOD.end}.csv`
    : `expedition73-${indicator}-annual-means-2001-2024.csv`;
  download.onclick = () => downloadFile(csv.join("\r\n") + "\r\n", "text/csv;charset=utf-8", filename);
}

function renderTrend(regions) {
  const status = $("trend-status"), panel = $("trend-results");
  const indicator = $("trend-indicator").value;
  const precipitation = indicator === "precipitation";
  $("trend-mode-picker").hidden = precipitation;
  const anomaly = !precipitation && $("trend-mode").value === "anomalies";
  const unit = precipitation ? "mm/day" : "°C";
  $("trend-heading").textContent = precipitation ? "Precipitation trend" : "Temperature trend";
  $("trend-description").textContent = precipitation
    ? "NASA POWER · Annual mean daily precipitation"
    : anomaly
      ? `NASA POWER · Annual 2 m air temperature anomalies (${unit}) · Relative to each region’s ${ANOMALY_REFERENCE_PERIOD.label} mean`
      : "NASA POWER · Annual mean 2 m air temperature";
  $("trend-coverage").hidden = !precipitation;
  $("trend-coverage-method").hidden = !precipitation;
  $("trend-series").hidden = true;
  panel.replaceChildren();
  if (!regions.length) {
    renderTrendTable([]);
    status.textContent = "Select at least one region.";
    return;
  }
  if ((precipitation ? state.indicatorStatus : state.annualStatus) === "loading") {
    renderTrendTable([]);
    status.textContent = "Verifying the recorded source data…"; return;
  }
  const history = state.indicators?.precipitationHistory;
  if (precipitation ? !history : state.annual?.status !== "available") {
    renderTrendTable([]);
    status.textContent = "Verified source data for this trend are unavailable."; return;
  }
  const ids = regions.map(({ id }) => id);
  const fits = precipitation ? { regions: summarizePrecipitationTrends(history, ids) }
    : summarizeTemperatureTrends(state.annual, [...state.periods.values()].map(({ data }) => data), ids);
  const seriesRegions = anomaly ? summarizeTemperatureAnomalies(fits.regions) : fits.regions;
  const entries = seriesRegions.map((entry, i) => ({ ...entry, region: regions[i] }));
  const rows = fits.regions.map(({ id, result }, i) => ({ id, label: named(regions[i]), result }));
  if (!precipitation && rows.length === 2) {
    rows.push({ id: "difference", label: `${ids[0]} − ${ids[1]} · paired trend difference`, result: fits.difference });
  }
  renderTrendSeries(entries, unit, anomaly);
  renderTrendTable(entries, unit, indicator, anomaly);
  const bound = Math.max(.1, ...rows.flatMap(({ result }) => result
    ? [Math.abs(result.slope), ...(result.interval ?? []).map(Math.abs)] : []));
  const position = (value) => `${50 + 50 * value / bound}%`;
  const digits = precipitation ? 3 : 2;
  const rounding = 0.5 * 10 ** -digits;
  const signed = (value) => `${value >= rounding ? "+" : ""}${number(Math.abs(value) < rounding ? 0 : value, digits)}`;
  const missingRef = anomaly ? entries.filter(({ status }) => status === "missing_reference") : [];
  status.textContent = missingRef.length
    ? `Temperature anomalies unavailable for ${missingRef.map(({ id }) => id).join(", ")}: complete ${ANOMALY_REFERENCE_PERIOD.label} reference years are required.`
    : anomaly
      ? `Relative to each region’s ${ANOMALY_REFERENCE_PERIOD.label} mean · Approximate 95% intervals · dashed line at zero`
      : "Approximate 95% intervals · dashed line at zero";
  for (const { id, label, result } of rows) {
    const card = el("article", undefined, "trend-row"); card.dataset.trend = id;
    card.append(el("h3", label));
    if (!result) {
      card.append(el("p", "Trend unavailable. This comparison requires 24 complete, compatible years."));
      panel.append(card);
      continue;
    }
    const { slope, interval } = result;
    const values = el("p", undefined, "trend-values");
    values.append(el("strong", `${signed(slope)} ${unit}/decade`), el("span", interval
      ? `95% CI ${signed(interval[0])} to ${signed(interval[1])}` : "Confidence interval unavailable"));
    const bar = el("div", undefined, "trend-track"); bar.setAttribute("aria-hidden", "true");
    const point = el("span", undefined, "trend-point"); point.style.left = position(slope);
    if (interval) {
      const range = el("span", undefined, "trend-interval");
      range.style.left = position(interval[0]); range.style.right = position(-interval[1]);
      bar.append(range);
    }
    bar.append(point);
    const assessment = !interval ? "Statistical significance unavailable."
      : interval[0] > 0 || interval[1] < 0 ? "Interval excludes zero." : "Interval includes zero.";
    card.append(values, bar, el("p", assessment, "detail-note"));
    panel.append(card);
  }
}
$("trend-indicator").addEventListener("change", () => { if (state.data) renderTrend(active()); });
$("trend-mode").addEventListener("change", () => { if (state.data) renderTrend(active()); });

function showAnnualRegion() {
  for (const card of $("annual-cards").children) {
    card.classList.toggle("is-annual-region", card.dataset.region === $("annual-region").value);
  }
}
$("annual-region").addEventListener("change", showAnnualRegion);

async function loadAnnual(bytes,periods,request) {
  try {
    const digest = await datasetDigest(bytes), raw = await fetchRecordedData("./data/annual.json");
    if(raw.length>2_000_000) throw Error("Annual data too large");
    const payload = validateAnnualPreview(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(raw)),digest,[...periods.values()].map((p)=>p.data));
    const traces = new Map();
    if (payload.schema_version === "0.2.0") await Promise.all(payload.regions.map(async(entry)=>{
      try { traces.set(entry.id,await validateAnnualWorkflow(entry)); } catch { /* Isolate trace errors from validated candidate values. */ }
    }));
    if (request!==state.annualRequest || state.periods!==periods) return;
    state.annual=payload; state.annualStatus="ready"; state.annualTraces=traces;
  } catch { if(request!==state.annualRequest || state.periods!==periods) return; state.annual=null; state.annualStatus="unavailable"; }
  renderAnnual(active());
  if (document.body.dataset.screen === "trend") renderTrend(active());
}

function renderSupport(regions) {
  $("support").replaceChildren(...regions.map((region) => {
    const row = el("div", undefined, "support-row"); row.style.setProperty("--region-color", color(region));
    const estimate = state.policy === "unmasked" ? 1 : region.support.policies[state.policy].uniform_fraction_of_window;
    const top = el("div", undefined, "support-top"); top.append(el("span", `${region.id} · ${named(region)}`), el("strong", state.policy === "unmasked" ? "Whole region" : `${number(estimate * 100, 3)}%`));
    const bar = el("div", undefined, "support-bar"); const fill = el("span"); fill.style.setProperty("--coverage", `${Math.min(100, Math.max(0, estimate * 100))}%`); bar.append(fill);
    let caption = `${region.support.cell_count} grid cells · ${region.support.clipped_cells} cells intersect the boundary`;
    if (state.policy !== "unmasked") { const p = region.support.policies[state.policy]; caption = `Conditional area range: ${number(p.lower_fraction_of_window * 100, 3)}%–${number(p.upper_fraction_of_window * 100, 3)}%`; }
    row.append(top, bar, el("p", caption, "support-caption")); return row;
  }));
  $("support-note").textContent = state.policy === "unmasked" ? "The area uses the intersection of the candidate rectangle with each grid cell and includes all surface types." : "The estimated fraction assumes a uniform surface within each grid cell. The range bounds the possible area inside the region given the full-cell fraction.";
}

function renderSources(regions) {
  if (!regions.length) { $("area-state").replaceChildren(el("span", "Source AREA comparison"), el("strong", "Select a region")); $("provenance-content").replaceChildren(); return; }
  const anyArea = regions.some((r) => r.source_area.numeric_declaration_present);
  $("area-state").replaceChildren(el("span", "Source AREA comparison"), el("strong", anyArea ? "Values pending verification" : "Source metadata does not include AREA"));
  $("provenance-content").replaceChildren(...regions.map((region) => {
    const p = region.provenance, box = el("div", undefined, "provenance-block");
    box.append(el("strong", `${region.id} · ${named(region)} · candidate`), el("p", regionDescription(region.region)), el("p", `Bounds [west, south, east, north]: ${region.region.candidate_bbox.join(", ")}°`), el("p", `Time: ${region.time.provider_time_standard} · ${region.time.calendar}`), el("p", `T2M retrieved: ${p.temperature.retrieved_at}`), el("p", `Surface fractions retrieved: ${p.surface_fractions.retrieved_at}`));
    const link = el("a", "NASA surface fraction source query ↗"); const uri = new URL(p.surface_fractions.uri); if (uri.protocol === "https:") { link.href = uri.href; link.target = "_blank"; link.rel = "noopener noreferrer"; box.append(link); }
    const sha = p.surface_fractions.response_sha256; box.append(el("p", `Raw surface fraction SHA-256: ${sha}`, "hash")); return box;
  }));
}

function renderTable(regions) {
  const head = el("thead"), header = el("tr"); header.append(el("th", "Month"));
  for (const region of regions) header.append(el("th", `${region.id} · °C`)); head.append(header);
  const body = el("tbody");
  state.data.dates.forEach((date, i) => { const tr = el("tr"); tr.append(el("td", `${months[i]} ${date.slice(0, 4)}`)); for (const r of regions) tr.append(el("td", number(value(r, i), 6))); body.append(tr); });
  $("data-table").replaceChildren(el("caption", `${labels[state.policy]} · recorded monthly temperatures`), head, body);
}

function renderComparison(regions) {
  $("comparison-month").textContent = `${months[state.month]} ${state.data.dates[state.month].slice(0, 4)}`;
  $("comparison-empty").hidden = regions.length > 0;
  const signed = (v) => v === null ? "No data" : `${v >= 0.0000005 ? "+" : ""}${number(Math.abs(v) < 0.0000005 ? 0 : v, 6)} °C`;
  $("comparison-cards").replaceChildren(...regions.map((region) => {
    const box = el("article", undefined, "comparison-card"); box.dataset.region = region.id;
    const head = el("h3", `${region.id} · ${named(region)}`); head.style.setProperty("--region-color", color(region));
    const table = el("table"); table.append(el("caption", "Selected month · three weighting options"));
    const body = el("tbody");
    for (const [policy, label] of Object.entries(labels)) {
      const row = el("tr"); row.dataset.policy = policy; if (policy === state.policy) row.className = "chosen-policy";
      const th = el("th", label); th.scope = "row"; if (policy === state.policy) th.append(el("span", "On chart", "comparison-tag"));
      const temperature = region.series[state.month][policy];
      row.append(th, el("td", temperature === null ? "No data" : `${number(temperature, 6)} °C`)); body.append(row);
    }
    table.append(body); box.append(head, table);
    for (const contrast of summarizePolicyDifferences(region.series)) {
      const row = el("div", undefined, "contrast-row"); row.dataset.contrast = contrast.id;
      const top = el("div", undefined, "contrast-top"); top.append(el("span", contrast.label), el("strong", signed(contrast.values[state.month].delta), "contrast-value"));
      let peak = "Maximum absolute difference: no data";
      if (contrast.max_abs_delta_degC !== null) {
        const dates = contrast.max_abs_dates.length === 12 ? "all 12 months tied" : contrast.max_abs_dates.map((date) => months[Number(date.slice(-2)) - 1]).join(", ");
        peak = `Maximum absolute difference: ${number(contrast.max_abs_delta_degC, 6)} °C · ${dates}`;
      }
      row.append(top, el("p", peak, "contrast-peak"), el("p", `${contrast.valid_months}/12 matched months for these two series`, "detail-note")); box.append(row);
    }
    return box;
  }));
}

function renderSpatial(regions) {
  $("spatial-empty").hidden = regions.length > 0;
  $("spatial-content").hidden = regions.length === 0;
  $("spatial-region").disabled = !regions.length;
  $("open-cell-details").disabled = !regions.length;
  $("spatial-region").replaceChildren(...regions.map((r) => { const option = el("option", `${r.id} · ${named(r)}`); option.value = r.id; return option; }));
  if (!regions.length) { state.spatialRegion = null; $("cell-grid").replaceChildren(); $("cell-detail").replaceChildren(); return; }
  if (!regions.some((r) => r.id === state.spatialRegion)) { state.spatialRegion = regions[0].id; state.cell = 0; }
  $("spatial-region").value = state.spatialRegion;
  const region = regions.find((r) => r.id === state.spatialRegion), cells = region.spatial.cells;
  state.cell = Math.min(state.cell, cells.length - 1);
  const temperatures = state.data.regions.flatMap((r) => r.spatial.cells.flatMap((c) => c.series.map((row) => row.value))).filter((v) => v !== null);
  const low = temperatures.length ? Math.floor(Math.min(...temperatures) / 10) * 10 : 0;
  const high = temperatures.length ? Math.max(low + 10, Math.ceil(Math.max(...temperatures) / 10) * 10) : 10;
  const fill = (v) => {
    if (v === null) return "#d7dcd4";
    const t = (v - low) / (high - low), a = t < .5 ? [53, 110, 159] : [244, 245, 239], b = t < .5 ? [244, 245, 239] : [199, 117, 67], f = t < .5 ? t * 2 : (t - .5) * 2;
    return `rgb(${a.map((n, i) => Math.round(n + (b[i] - n) * f)).join(",")})`;
  };
  $("scale-low").textContent = number(low, 0); $("scale-high").textContent = number(high, 0);
  $("spatial-context").textContent = `${region.id} · ${months[state.month]} ${state.data.dates[0].slice(0, 4)} · ${cells.length} grid cells · 0.625° longitude × 0.5° latitude. Bounds [W, S, E, N]: ${region.region.candidate_bbox.join(", ")}°.`;
  const minX = Math.min(...cells.map((c) => c.full_cell_bbox[0])), maxX = Math.max(...cells.map((c) => c.full_cell_bbox[2]));
  const minY = Math.min(...cells.map((c) => c.full_cell_bbox[1])), maxY = Math.max(...cells.map((c) => c.full_cell_bbox[3]));
  const x = (lon) => 57 + (lon - minX) / (maxX - minX) * 440, y = (lat) => 290 - (lat - minY) / (maxY - minY) * 267;
  const box = (b) => ({ x: x(b[0]), y: y(b[3]), width: x(b[2]) - x(b[0]), height: y(b[1]) - y(b[3]) });
  const grid = $("cell-grid"); grid.replaceChildren(svg("title", {}, `${named(region)} · recorded grid cells`));
  cells.forEach((c, i) => {
    grid.append(svg("rect", { ...box(c.full_cell_bbox), class: "full-cell", "aria-hidden": "true" }));
    const v = c.series[state.month].value, selected = i === state.cell;
    const rect = svg("rect", { ...box(c.intersection_bbox), fill: fill(v), class: "grid-cell", role: "button", tabindex: selected ? "0" : "-1", "aria-pressed": String(selected), "data-cell": i, "aria-label": `Cell center ${c.longitude}°, ${c.latitude}°; ${months[state.month]}: ${v === null ? "no data" : number(v) + " °C"}` });
    const select = (index, focus) => { state.cell = index; renderSpatial(regions); if (focus) grid.querySelector(`[data-cell="${index}"]`).focus({ preventScroll: true }); };
    rect.addEventListener("click", () => select(i, true));
    rect.addEventListener("keydown", (event) => {
      if (["Enter", " "].includes(event.key)) { event.preventDefault(); select(i, true); return; }
      const offset = { ArrowRight: [0.625, 0], ArrowLeft: [-0.625, 0], ArrowUp: [0, 0.5], ArrowDown: [0, -0.5] }[event.key];
      if (!offset) return; event.preventDefault();
      const next = cells.findIndex((other) => other.longitude === c.longitude + offset[0] && other.latitude === c.latitude + offset[1]);
      if (next >= 0) select(next, true);
    });
    rect.append(svg("title", {}, rect.getAttribute("aria-label"))); grid.append(rect);
  });
  grid.append(svg("rect", { ...box(region.region.candidate_bbox), class: "candidate-outline", "aria-hidden": "true" }));
  const chosen = cells[state.cell], center = [(chosen.intersection_bbox[0] + chosen.intersection_bbox[2]) / 2, (chosen.intersection_bbox[1] + chosen.intersection_bbox[3]) / 2];
  grid.append(svg("circle", { cx: x(center[0]), cy: y(center[1]), r: 5, class: "selected-cell-mark", "aria-hidden": "true" }));
  for (const lon of [minX, maxX]) grid.append(svg("text", { x: x(lon), y: 310, "text-anchor": lon === minX ? "start" : "end", class: "spatial-axis" }, `${number(lon, 3)}°`));
  for (const lat of [minY, maxY]) grid.append(svg("text", { x: 50, y: y(lat) + 4, "text-anchor": "end", class: "spatial-axis" }, `${number(lat, 2)}°`));
  grid.append(svg("text", { x: 277, y: 333, "text-anchor": "middle", class: "spatial-axis" }, "Longitude → · Latitude ↑"));
  const detail = $("cell-detail"), temperature = chosen.series[state.month].value;
  const total = cells.reduce((sum, c) => sum + (c.series[state.month].value === null ? 0 : c.weights_m2[state.policy]), 0);
  const effective = temperature === null ? 0 : chosen.weights_m2[state.policy];
  const table = el("dl", undefined, "cell-facts");
  const fact = (name, text) => table.append(el("dt", name), el("dd", text));
  fact("Cell center (longitude, latitude)", `${chosen.longitude}°, ${chosen.latitude}°`);
  fact("Boundary intersection", chosen.clipped ? "Part of a grid cell" : "Full grid cell");
  fact("Intersection area · spherical model", `${number(chosen.intersection_area_m2 / 1e6, 3)} km²`);
  fact("Effective area under selected weighting", `${number(effective / 1e6, 3)} km²${temperature === null ? " · temperature missing" : ""}`);
  fact("Share of this month's valid area", total > 0 ? `${number(effective / total * 100, 3)}%` : "No data");
  for (const [key, label] of Object.entries({ FRLAND: "Land", FRLANDICE: "Land ice", FRLAKE: "Lake", FROCEAN: "Ocean" })) fact(`${label} · full-cell fraction`, `${number(chosen.fractions[key] * 100, 4)}%`);
  detail.replaceChildren(el("span", "SELECTED CELL", "section-label"), el("h3", temperature === null ? "No data" : `${number(temperature)} °C`), el("p", `${months[state.month]} · grid T2M · ${labels[state.policy]}`, "detail-note"), table);
}
$("open-cell-details").addEventListener("click", () => {
  $("cell-dialog-body").replaceChildren(...[...$("cell-detail").children].map((node) => node.cloneNode(true)));
  $("cell-dialog").showModal();
});

const traceLabels = { Temperature: "Temperature input", Fractions: "Surface fractions", Land: "Land weighting", LandIce: "Land + ice weighting", Sensitivity: "Comparison", History: "Monthly source check", AnnualWeighting: "Annual weighting" };
Object.assign(traceLabels,{Precipitation:'Precipitation input',InputCheck:'Input alignment'});
function renderTrace(regions) {
  const select = $("trace-region"), graph = $("trace-graph"), detail = $("trace-detail");
  select.replaceChildren(...regions.map((r) => { const option = el("option", `${r.id} · ${named(r)}`); option.value = r.id; return option; }));
  const region = regions.find((r) => r.id === state.traceRegion) || regions[0];
  $("trace-empty").hidden = !!region; $("trace-content").hidden = !region; select.disabled = !region;
  graph.replaceChildren(); detail.replaceChildren();
  if (!region) { state.traceRegion = null; state.traceNode = null; return; }
  state.traceRegion = region.id; select.value = region.id;
  const layout = traceGraph(region.workflow_trace);
  $("trace-summary").textContent = `${region.id} · ${layout.nodes.length} steps · ${layout.edges.length} data dependencies · 1 run per step`;
  drawTrace(region.workflow_trace,graph,detail,state.traceNode,"trace-arrow",(id)=>{
    state.traceNode=id; renderTrace(regions); graph.querySelector(`[data-node="${id}"]`).focus({preventScroll:true});
  });
}

function drawTrace(trace,graph,detail,selectedId,markerId,onChoose) {
  const compact = window.matchMedia("(max-width:740px)").matches, layout = traceGraph(trace,compact);
  if (trace.target === "AnnualWeighting") {
    layout.nodes = layout.nodes.map((node)=>({...node,x:compact?50:node.x,y:compact?node.y:60}));
    layout.width=compact?260:410; layout.height=compact?250:120;
  }
  const selected = layout.nodes.find((n)=>n.id===selectedId) || layout.nodes.at(-1);
  let top = 0, bottom = layout.height;
  if (graph.id === "indicator-trace-graph" && !compact) {
    top = Math.min(...layout.nodes.map((node) => node.y)) - 45;
    bottom = Math.max(...layout.nodes.map((node) => node.y)) + 45;
  }
  graph.setAttribute("viewBox", `0 ${top} ${layout.width} ${bottom - top}`);
  const marker = svg("marker", { id: markerId, class:"trace-arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: "auto-start-reverse" }); marker.append(svg("path", { d: "M0,0 L10,5 L0,10 Z" }));
  const defs = svg("defs", {}); defs.append(marker); graph.append(defs);
  layout.edges.forEach((edge, i) => {
    const a = layout.nodes.find((n) => n.id === edge.from), b = layout.nodes.find((n) => n.id === edge.to);
    const x1 = a.x + 160, x2 = b.x, y1 = a.y, y2 = b.y;
    const d = compact ? (b.y - a.y > 160 ? `M${a.x + 80},${a.y + 33} L${a.x + 80},${a.y + 48} L${8 + i * 3},${a.y + 48} L${8 + i * 3},${b.y - 48} L${b.x + 80},${b.y - 48} L${b.x + 80},${b.y - 33}` : `M${a.x + 80},${a.y + 33} C${a.x + 80},${a.y + 80} ${b.x + 80},${b.y - 80} ${b.x + 80},${b.y - 33}`) : x2 - x1 > 100 ? `M${x1},${y1} L${x1 + 12},${y1} L${x1 + 12},${20 + i * 8} L${x2 - 14},${20 + i * 8} L${x2 - 14},${y2} L${x2},${y2}` : `M${x1},${y1} C${x1 + 25},${y1} ${x2 - 25},${y2} ${x2},${y2}`;
    const path = svg("path", { d, class: "trace-edge", "marker-end": `url(#${markerId})`, "data-from": edge.from, "data-to": edge.to }); path.append(svg("title", {}, `${edge.from} → ${edge.to} · ${edge.alias}`)); graph.append(path);
  });
  for (const node of layout.nodes) {
    const group = svg("g", { transform: `translate(${node.x},${node.y - 33})`, class: "trace-node", role: "button", tabindex: "0", "aria-pressed": String(node.id === selected.id), "aria-label": `${traceLabels[node.id] || node.id} · completed · 1 run`, "data-node": node.id });
    group.append(svg("rect", { width: 160, height: 66, rx: 10 }), svg("text", { x: 12, y: 25, class: "trace-label" }, traceLabels[node.id] || node.id), svg("text", { x: 12, y: 47, class: "trace-status" }, "✓ Completed · 1 run"));
    const choose = () => onChoose(node.id);
    group.addEventListener("click", choose); group.addEventListener("keydown", (event) => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); choose(); } }); graph.append(group);
  }
  const dl = el("dl", undefined, "trace-facts");
  const fact = (label, value) => dl.append(el("dt", label), el("dd", value));
  fact("Operation / version", `${selected.operation} / ${selected.operation_version}`);
  fact("Output contract", `${selected.output_contract.type} · ${selected.output_contract.schema_version} · ${selected.output_contract.unit}`);
  fact("Inputs", selected.inputs.length ? selected.inputs.map((i) => `${i.alias} ← ${traceLabels[i.node] || i.node}`).join("; ") : "Verifies recorded source data directly.");
  fact("Step definition SHA-256", selected.definition_fingerprint);
  detail.append(el("span", "SELECTED STEP", "section-label"), el("h3", traceLabels[selected.id] || selected.id), dl);
}

function renderPair(regions) {
  const leftSelect = $("pair-left"), rightSelect = $("pair-right");
  const left = regions.find((r) => r.id === state.pairLeft) || regions[0];
  const others = regions.filter((r) => r !== left);
  const right = others.find((r) => r.id === state.pairRight) || others[0];
  const options = (select, rows, chosen) => { select.replaceChildren(...rows.map((r) => { const o = el("option", `${r.id} · ${named(r)}`); o.value = r.id; return o; })); if (chosen) select.value = chosen.id; select.disabled = !right; };
  options(leftSelect, regions, left); options(rightSelect, others, right);
  state.pairLeft = left?.id || null; state.pairRight = right?.id || null;
  $("pair-empty").hidden = !!right; $("pair-content").hidden = !right; $("pair-swap").disabled = !right;
  $("pair-checks").hidden = !right;
  for (const id of ["pair-metrics", "pair-chart", "pair-table", "pair-check-table"]) $(id).replaceChildren();
  $("pair-status").textContent = ""; $("pair-caption").textContent = ""; $("pair-reading").textContent = "";
  $("review-message").textContent = state.datasetSha256 ? "This browser processes reports locally." : "Opening or downloading comparison reports requires Web Crypto. You can still use the charts.";
  $("review-download").disabled = !right || !state.datasetSha256;
  $("review-file").disabled = !state.datasetSha256;
  $("review-open").disabled = !state.datasetSha256;
  for (const selector of [".pair-summary", ".pair-table"]) document.querySelector(selector).hidden = !right;
  if (!right) return;
  const result = summarizeRegionDifferences(left, right, state.policy);
  $("review-download").disabled = !result.compatible || !state.datasetSha256;
  $("pair-status").textContent = result.compatible ? `Data compatibility checks passed · ${labels[state.policy]} · Methods under review` : "Data compatibility check failed. Choose regions with matching source and calculation metadata.";
  $("pair-status").className = result.compatible ? "pair-ready" : "pair-blocked";
  const head = el("thead"), hr = el("tr"); for (const title of ["Check", "Status / scope"]) hr.append(el("th", title)); head.append(hr);
  const body = el("tbody");
  for (const c of result.checks) {
    const row = el("tr"), description = el("td");
    description.append(el("strong", { matched: "Matched", mismatch: "Mismatch or missing", not_used: "Unused" }[c.status]), el("small", c.status === "mismatch" ? "Metadata differs or is missing for this check." : c.detail));
    row.dataset.check = c.id; row.dataset.status = c.status; row.append(el("th", c.label), description); body.append(row);
  }
  $("pair-check-table").append(head, body); $("pair-values").hidden = !result.compatible;
  for (const selector of [".pair-summary", ".pair-table"]) document.querySelector(selector).hidden = !result.compatible;
  if (!result.compatible) { $("pair-reading").textContent = "A monthly difference requires matching source and calculation metadata."; $("pair-checks").open = true; return; }
  const current = result.values[state.month], metricBox = $("pair-metrics");
  const date = `${months[state.month]} ${state.year}`;
  $("pair-reading").textContent = current.delta === null ? `${date}: A temperature value is missing for at least one region.`
    : current.delta === 0 ? `${date}: ${left.id} and ${right.id} have the same recorded monthly mean (0.000 °C difference).`
    : Math.abs(current.delta) < 0.0005 ? `${date}: The nonzero ${left.id} − ${right.id} difference rounds to 0.000 °C at three decimal places.`
    : `${date}: ${left.id} was ${number(Math.abs(current.delta), 3)} °C ${current.delta > 0 ? "warmer" : "cooler"} than ${right.id}.`;
  const card = (label, value, note) => { const box = el("article"); box.append(el("span", label), el("strong", value), el("small", note)); return box; };
  const delta = (v) => v === null ? "No data" : `${number(v, 3)} °C`;
  const peakMonths = result.max_abs_dates.map((d) => months[Number(d.slice(-2)) - 1]).join(", ");
  metricBox.append(card(`${left.id} − ${right.id} · ${months[state.month]}`, delta(current.delta), "Positive means the left region was warmer"), card("Largest absolute difference in the year", delta(result.max_abs_delta_degC), peakMonths || "No valid paired months"), card("Valid paired months", `${result.valid_months}/12`, "Months with values in both regions"));
  const chart = $("pair-chart"), compact = window.matchMedia("(max-width:740px)").matches;
  const width = compact ? 400 : 640, x = (i) => 48 + i * (width - 70) / 11;
  const valid = result.values.filter((r) => r.delta !== null), extent = Math.max(1, ...valid.map((r) => Math.abs(r.delta))) * 1.12;
  const y = (v) => 105 - v / extent * 78;
  chart.setAttribute("viewBox", `0 0 ${width} 230`);
  chart.append(svg("title", { id: "pair-chart-title" }, `${left.id} minus ${right.id} monthly temperature difference`), svg("desc", { id: "pair-chart-desc" }, "Positive values mean the left region was warmer. Gaps show months with a missing value. The table lists the differences."));
  for (const tick of [-extent, 0, extent]) chart.append(svg("line", { x1: 48, x2: width - 22, y1: y(tick), y2: y(tick), class: tick === 0 ? "chart-grid chart-zero" : "chart-grid" }), svg("text", { x: 39, y: y(tick) + 4, "text-anchor": "end", class: "chart-text" }, number(tick, 1)));
  let path = "", connected = false;
  result.values.forEach((row, i) => { if (row.delta === null) { connected = false; return; } path += `${connected ? "L" : "M"}${x(i)},${y(row.delta)} `; connected = true; });
  chart.append(svg("path", { d: path, class: "pair-line" }), svg("line", { x1: x(state.month), x2: x(state.month), y1: 20, y2: 190, class: "chart-focus" }));
  if (current.delta !== null) chart.append(svg("circle", { cx: x(state.month), cy: y(current.delta), r: 5, class: "pair-point" }));
  for (let i = 0; i < 12; i++) if (!compact || [0, 2, 4, 6, 8, 11].includes(i)) chart.append(svg("text", { x: x(i), y: 218, "text-anchor": "middle", class: "chart-text" }, shortMonths[i]));
  $("pair-caption").textContent = `${left.id} · ${named(left)} − ${right.id} · ${named(right)}. Values are in °C. Swapping the regions reverses the sign. The vertical scale follows the selected pair.`;
  const tableHead = el("thead"), tableRow = el("tr");
  for (const title of ["Month", `${left.id} · °C`, `${right.id} · °C`, `${left.id} − ${right.id} · °C`]) tableRow.append(el("th", title)); tableHead.append(tableRow);
  const rows = el("tbody"); for (const r of result.values) { const row = el("tr"); row.append(el("th", months[Number(r.date.slice(-2)) - 1]), ...[r.left, r.right, r.delta].map((v) => el("td", v === null ? "No data" : number(v, 3)))); rows.append(row); }
  $("pair-table").append(tableHead, rows);
}

function addIndicatorPoint(graph, geometry, entry, month, label) {
  const point = svg("circle", { ...geometry, role: "button", tabindex: "0", "aria-label": label,
    "aria-pressed": String(month === state.month), "data-indicator-month": month, "data-region": entry.id });
  point.append(svg("title", {}, label));
  const choose = () => {
    state.month = month;
    $("month").value = String(month);
    render();
    [...graph.querySelectorAll("[data-indicator-month]")].find((item) =>
      item.dataset.region === entry.id && item.dataset.indicatorMonth === String(month))?.focus({ preventScroll: true });
  };
  point.addEventListener("click", choose);
  point.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(); }
  });
  graph.append(point);
}

function indicatorChart(entries,key,unit,target) {
  const compact=window.matchMedia('(max-width:740px)').matches, width=compact?460:690;
  const graph=$(target); graph.replaceChildren(); graph.setAttribute('viewBox',`0 0 ${width} 260`);
  graph.append(svg('title',{},`${state.year} monthly ${key === 'temperature' ? 'temperatures' : 'mean precipitation rate'}`));
  const values=entries.flatMap(r=>r[key].series.map(s=>s.value)).filter(v=>v!==null);
  if(!values.length) { graph.append(svg('text',{x:40,y:110},'No valid monthly data')); return; }
  let low=Math.min(...values),high=Math.max(...values); if(key==='precipitation') low=0;
  const pad=Math.max((high-low)*.1,.1); low-=key==='temperature'?pad:0; high+=pad;
  const x=i=>52+i*(width-96)/11, y=v=>218-(v-low)/(high-low)*175;
  for(let i=0;i<5;i++) { const v=low+(high-low)*i/4; graph.append(svg('line',{x1:50,y1:y(v),x2:width-40,y2:y(v),class:'grid-line'}),svg('text',{x:44,y:y(v)+4,'text-anchor':'end',class:'chart-text'},number(v,1))); }
  shortMonths.forEach((m,i)=>{if(!compact||i%2===0||i===11)graph.append(svg('text',{x:x(i),y:244,'text-anchor':'middle',class:'chart-text'},m));});
  graph.append(svg('line',{x1:x(state.month),x2:x(state.month),y1:35,y2:218,class:'month-guide'}));
  for(const entry of entries) {
    const stroke=color(state.data.regions.find(r=>r.id===entry.id)); let path=''; let valid=false;
    entry[key].series.forEach((row,i)=>{if(row.value===null){valid=false;return;} path+=`${valid?'L':'M'}${x(i)},${y(row.value)} `;valid=true;});
    graph.append(svg('path',{d:path,fill:'none',stroke,'stroke-width':2}));
    entry[key].series.forEach((row,i)=>{
      if(row.value===null)return;
      addIndicatorPoint(graph, { cx:x(i), cy:y(row.value), r:i===state.month?5:3, fill:stroke },
        entry, i, `${named(entry)} · ${months[i]} · ${number(row.value,3)} ${unit}`);
    });
  }
}

const seasonMonths = (indices) => indices.map((index) => months[index]).join(", ");

function renderSeasonalProfile(entries) {
  $("seasonal-profile").hidden = !entries.length;
  if (!entries.length) return;

  $("seasonal-profile-title").textContent = `${state.year} Seasonal Profile`;
  $("seasonal-legend").replaceChildren(...entries.map((entry) => {
    const item = el("span", `${entry.id} · ${named(entry)}`);
    item.style.color = color(state.data.regions.find((region) => region.id === entry.id));
    return item;
  }));
  $("seasonal-summary").replaceChildren(...entries.map((entry) => {
    const { points, summary } = entry.profile;
    const card = el("article", undefined, "seasonal-card");
    card.dataset.region = entry.id;
    card.append(el("h5", `${entry.id} · ${named(entry)}`));
    if (summary) {
      card.append(el("p", seasonMonths(summary.warmestMonths)),
        el("strong", `${number(summary.meanPrecipitation, 2)} mm/day`),
        el("p", `Peak temperature · ${seasonMonths(summary.peakTemperatureMonths)}`),
        el("p", `Peak precipitation · ${seasonMonths(summary.peakPrecipitationMonths)}`));
    } else {
      card.append(el("p", `The summary requires 12 matched months. ${points.length} available.`));
    }
    return card;
  }));

  const points = entries.flatMap(({ profile }) => profile.points);
  const graph = $("seasonal-chart");
  graph.replaceChildren();
  graph.classList.toggle("no-points", !points.length);
  $("seasonal-empty").hidden = !!points.length;
  if (!points.length) return;

  const width = window.matchMedia("(max-width:740px)").matches ? 400 : 620;
  const left = 63, right = width - 21, top = 21, bottom = 221;
  const temperatures = points.map((point) => point.temperature);
  const min = Math.min(...temperatures), max = Math.max(...temperatures);
  const padding = Math.max((max - min) * 0.08, 2);
  const xMin = min - padding, xMax = max + padding;
  const yMax = Math.max(0.1, ...points.map((point) => point.precipitation)) * 1.1;
  const x = (value) => left + (value - xMin) * (right - left) / (xMax - xMin);
  const y = (value) => bottom - value * (bottom - top) / yMax;
  graph.setAttribute("viewBox", `0 0 ${width} 273`);
  graph.append(svg("title", {}, `${state.year} monthly temperature and precipitation`));
  for (let tick = 0; tick <= 4; tick++) {
    const tx = xMin + (xMax - xMin) * tick / 4;
    const ty = yMax * tick / 4;
    graph.append(svg("line", { x1: left, x2: right, y1: y(ty), y2: y(ty), class: "grid-line" }),
      svg("line", { x1: x(tx), x2: x(tx), y1: top, y2: bottom, class: "grid-line" }),
      svg("text", { x: x(tx), y: bottom + 19, "text-anchor": "middle", class: "chart-text" }, number(tx, 0)),
      svg("text", { x: left - 8, y: y(ty) + 4, "text-anchor": "end", class: "chart-text" }, number(ty, yMax < 1 ? 2 : 1)));
  }
  graph.append(svg("text", { x: (left + right) / 2, y: 264, "text-anchor": "middle", class: "chart-text" }, "2 m air temperature (°C)"),
    svg("text", { transform: `translate(15 ${(top + bottom) / 2}) rotate(-90)`, "text-anchor": "middle", class: "chart-text" }, "Precipitation rate (mm/day)"));

  for (const entry of entries) {
    const fill = color(state.data.regions.find((region) => region.id === entry.id));
    for (const { month, temperature, precipitation } of entry.profile.points) {
      addIndicatorPoint(graph, { cx: x(temperature), cy: y(precipitation), r: month === state.month ? 7 : 4, fill }, entry, month,
        `${named(entry)} · ${months[month]} · ${number(temperature, 3)} °C · ${number(precipitation, 3)} mm/day`);
    }
  }
}

function drawPrecipitationTimeline(graph, entries, selected, tickIndices, title) {
  const count = entries[0].series.length, width = window.matchMedia("(max-width:740px)").matches ? 400 : 920;
  const left = 45, right = width - 22, top = 18, bottom = 211;
  const maximum = Math.max(0.1, ...entries.flatMap(({ series }) => series.map(({ value }) => value ?? 0))) * 1.1;
  const x = (i) => left + i * (right - left) / (count - 1);
  const y = (value) => bottom - value * (bottom - top) / maximum;
  graph.setAttribute("viewBox", `0 0 ${width} 247`);
  graph.replaceChildren(svg("title", {}, title));
  for (let tick = 0; tick <= 4; tick++) {
    const rate = maximum * tick / 4;
    graph.append(svg("line", { x1: left, x2: right, y1: y(rate), y2: y(rate), class: "chart-grid" }),
      svg("text", { x: left - 8, y: y(rate) + 4, "text-anchor": "end", class: "chart-text" }, number(rate, 1)));
  }
  for (const i of tickIndices) {
    graph.append(svg("text", { x: x(i), y: 235, "text-anchor": i === 0 ? "start" : i === count - 1 ? "end" : "middle", class: "chart-text" },
      String(entries[0].series[i].year ?? entries[0].series[i].date.slice(0, 4))));
  }
  graph.append(svg("line", { x1: x(selected), x2: x(selected), y1: top, y2: bottom, class: "chart-focus" }));
  for (const { region, series } of entries) {
    let path = "", connected = false;
    for (const [i, { value }] of series.entries()) {
      if (value === null) { connected = false; continue; }
      path += `${connected ? "L" : "M"}${x(i)},${y(value)} `;
      connected = true;
    }
    const stroke = color(region);
    graph.append(svg("path", { d: path, fill: "none", stroke, "stroke-width": 1.4, "data-region": region.id, "data-records": count }));
    const { value } = series[selected];
    if (value !== null) graph.append(svg("circle", { cx: x(selected), cy: y(value), r: 4, fill: stroke }));
  }
}

function precipitationLegend(entries, target) {
  $(target).replaceChildren(...entries.map(({ region }) => {
    const label = el("span", `${region.id} · ${named(region)}`);
    label.style.color = color(region);
    return label;
  }));
}

function renderPrecipitationHistory(history, regions) {
  $("precipitation-history").hidden = !history || !regions.length;
  if (!history || !regions.length) return;

  const entries = regions.map((region) => ({ region, series: history.regions.find(({ id }) => id === region.id)?.series }))
    .filter(({ series }) => series);
  $("precipitation-history").hidden = !entries.length;
  if (!entries.length) return;
  const selected = (state.year - Number(history.time.start.slice(0, 4))) * 12 + state.month;
  const count = entries[0].series.length;
  drawPrecipitationTimeline($("precipitation-history-chart"), entries, selected, [0, 60, 120, 180, 240, count - 1],
    "2001–2024 monthly precipitation rate in mm/day");
  precipitationLegend(entries, "precipitation-history-legend");
  $("precipitation-timeline-status").textContent = `${count} monthly slots · mm/day · ${entries.map(({ region, series }) =>
    `${region.id}: ${series.filter(({ value }) => value !== null).length}/${count} valid months`).join(" · ")}. Selected: ${months[state.month]} ${state.year}.`;
}

function renderSeasonalHistory(regions) {
  const years = [...state.seasonalYears.keys()];
  $("seasonal-history").hidden = years.length < 2 || !regions.length;
  if (years.length < 2 || !regions.length) return;

  const entries = regions.map((region) => ({ region, series: years.map((year) => {
    const summary = state.seasonalYears.get(year).find(({ id }) => id === region.id)?.profile.summary;
    return { year, value: summary?.meanPrecipitation ?? null, summary };
  }) }));
  drawPrecipitationTimeline($("seasonal-history-chart"), entries, years.indexOf(state.year),
    [0, 5, 10, 15, 20, years.length - 1], "Annual warm-month precipitation rates in mm/day");
  precipitationLegend(entries, "seasonal-history-legend");
  $("seasonal-history-status").textContent = entries.map(({ region, series }) =>
    `${region.id}: ${series.filter(({ value }) => value !== null).length}/${years.length} complete years`).join(" · ");

  const head = el("thead"), header = el("tr"), body = el("tbody");
  header.append(el("th", "Year"), ...regions.map((region) => el("th", `${region.id} · ${named(region)} · mm/day`)));
  head.append(header);
  years.forEach((year, i) => {
    const row = el("tr");
    row.dataset.year = String(year);
    if (year === state.year) row.setAttribute("aria-current", "true");
    row.append(el("th", String(year)), ...entries.map(({ series }) => {
      const { value, summary } = series[i];
      const cell = el("td", number(value, 2));
      if (summary) cell.append(el("small", seasonMonths(summary.warmestMonths)));
      return cell;
    }));
    body.append(row);
  });
  $("seasonal-history-table").replaceChildren(head, body);
}

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const weatherColors = [[36, 74, 135], [113, 174, 203], [245, 230, 176], [200, 110, 54], [144, 48, 53]];
const weatherNote = "Color shows monthly regional air temperature. Moving streaks illustrate mean precipitation rates.";
const weather = { timer: null, scale: null, globe: null };

function weatherScale() {
  let min = 0, max = 0, rain = 0;
  for (const entries of state.seasonalYears.values()) {
    for (const { profile } of entries) {
      for (const { temperature, precipitation } of profile.points) {
        min = Math.min(min, temperature);
        max = Math.max(max, temperature);
        rain = Math.max(rain, precipitation);
      }
    }
  }
  return { min: Math.floor(min / 5) * 5, max: Math.max(5, Math.ceil(max / 5) * 5), rain: Math.ceil(rain) };
}

function weatherColor(value, { min, max }) {
  if (value === null) return "#d0d7dc";
  const position = Math.min(4, Math.max(0, 4 * (value - min) / (max - min)));
  const lower = Math.min(3, Math.floor(position)), fraction = position - lower;
  const rgb = weatherColors[lower].map((channel, i) => Math.round(channel + fraction * (weatherColors[lower + 1][i] - channel)));
  return `rgb(${rgb.join(" ")})`;
}

function weatherCard(region, record, mapRegion) {
  const card = el("article", undefined, "weather-card");
  card.dataset.region = region.id;
  const focus = el("button", `${region.id} · ${named(region)}`, "weather-focus");
  focus.type = "button";
  focus.title = `Zoom the globe to ${named(region)}`;
  focus.addEventListener("click", () => { if (weather.globe) weather.globe.focus(mapRegion.bounds); });
  card.append(focus);
  if (!record) {
    card.append(el("p", "Paired values unavailable", "weather-readings"));
    return card;
  }
  const values = el("dl", undefined, "weather-readings");
  const temperature = el("dd", `${number(record.temperature, 2)} °C`, "weather-temperature");
  temperature.style.setProperty("--temperature", mapRegion.fill);
  values.append(el("dt", "2 m air temperature"), temperature,
    el("dt", "Mean precipitation rate"), el("dd", `${number(record.precipitation, 2)} mm/day`));
  const track = el("div", undefined, "weather-rate");
  track.setAttribute("aria-hidden", "true");
  const fill = el("span");
  fill.style.width = `${mapRegion.intensity * 100}%`;
  track.append(fill);
  card.append(values, track);
  return card;
}

function stopWeatherPlayback() {
  clearInterval(weather.timer);
  weather.timer = null;
  $("weather-play").setAttribute("aria-pressed", "false");
  $("weather-play").textContent = "Play months";
}

function selectMonth(month) {
  state.month = month;
  $("month").value = String(month);
  render();
}

$("weather-particles").checked = !reducedMotion.matches;
$("weather-particles").addEventListener("change", renderWeatherScene);
reducedMotion.addEventListener("change", () => {
  if (reducedMotion.matches) {
    $("weather-particles").checked = false;
    if (document.body.dataset.screen === "weather-3d") renderWeatherScene();
  }
});
$("weather-month").addEventListener("input", (event) => selectMonth(Number(event.target.value)));
$("weather-play").addEventListener("click", () => {
  if (weather.timer !== null) { stopWeatherPlayback(); return; }
  $("weather-play").setAttribute("aria-pressed", "true");
  $("weather-play").textContent = "Pause months";
  weather.timer = setInterval(() => selectMonth((state.month + 1) % 12), 1200);
});
$("globe-reset").addEventListener("click", () => { if (weather.globe) weather.globe.reset(); });
document.addEventListener("visibilitychange", () => { if (document.hidden) stopWeatherPlayback(); });
$("nasa-video").addEventListener("error", () => { $("nasa-video-error").hidden = false; });

function renderWeatherScene() {
  const date = `${months[state.month]} ${state.year}`;
  $("weather-date").textContent = date;
  $("weather-month").value = String(state.month);
  $("weather-month").setAttribute("aria-valuetext", date);
  const regions = active(), entries = state.seasonalYears.get(state.year) ?? [];
  const available = entries.some((entry) => entry.profile.points.length && state.selected.has(entry.id));
  $("weather-play").disabled = $("weather-month").disabled = $("weather-particles").disabled = !available;
  $("weather-legend").hidden = !available;
  $("weather-status").textContent = available ? weatherNote : regions.length
    ? "Paired temperature and precipitation records are unavailable for this selection." : "Select a region to show its monthly weather.";
  if (!available) stopWeatherPlayback();
  // A failed or still loading indicator file must not lock in an empty scale.
  const scale = available ? (weather.scale ??= weatherScale()) : null;
  if (scale) {
    $("weather-cold").textContent = `${scale.min} °C`;
    $("weather-warm").textContent = `${scale.max} °C`;
    $("weather-rain-scale").textContent = `Precipitation 0–${scale.rain} mm/day`;
  }
  const focusedCard = document.activeElement.closest(".weather-focus")?.parentElement.dataset.region;
  const mapRegions = [];
  const cards = regions.map((region) => {
    const record = entries.find(({ id }) => id === region.id)?.profile.points.find(({ month }) => month === state.month);
    const mapRegion = { id: region.id, bounds: region.region.candidate_bbox,
      fill: record ? weatherColor(record.temperature, scale) : "#d0d7dc",
      intensity: record && scale.rain > 0 ? record.precipitation / scale.rain : 0 };
    mapRegions.push(mapRegion);
    const card = weatherCard(region, record, mapRegion);
    if (!weather.globe) card.firstElementChild.disabled = true;
    return card;
  });
  $("weather-scenes").replaceChildren(...cards);
  cards.find(({ dataset }) => dataset.region === focusedCard)?.firstElementChild.focus({ preventScroll: true });
  if (weather.globe) weather.globe.update(mapRegions, $("weather-particles").checked);
}

function syncWeatherView(view) {
  const activeGlobe = view === "weather-3d";
  if (activeGlobe) {
    if (weather.globe === null) {
      weather.globe = createWeatherGlobe($("weather-globe"), $("globe-status")) ?? false;
      $("globe-reset").disabled = !weather.globe;
    }
    renderWeatherScene();
  } else if (weather.timer !== null) stopWeatherPlayback();
  if (weather.globe) weather.globe.show(activeGlobe);
  const video = $("nasa-video");
  if (view === "nasa-replay") {
    if (!video.getAttribute("src")) {
      video.poster = "./hurricane-arthur.jpg";
      video.src = "./hurricane-arthur.webm";
    }
  } else if (!video.paused) video.pause();
}

function renderIndicators(regions) {
  const model = state.indicators, yearly = state.seasonalYears.get(state.year);
  const available = state.indicatorStatus === "available" && !!yearly?.length;
  const hasRecordedWorkflow = state.year === 2024;
  renderPrecipitationHistory(model?.precipitationHistory, regions);
  $("indicator-use2024").hidden = !model?.regions.length || hasRecordedWorkflow;
  $("indicator-content").hidden = !available;
  $("indicator-status").textContent = available ? `${state.year} · 12 monthly records · whole region, unmasked`
    : state.indicatorStatus === "loading" ? "Verifying the indicator records…"
    : state.indicatorStatus === "error" ? "The indicator records could not be verified. Rebuild the preview to restore them. You can still use the temperature comparison."
    : !model?.regions.length ? "This package has no combined indicator records."
    : model.precipitationHistoryError ? "The precipitation history could not be verified. The 2024 indicator records are available."
    : "This package contains combined indicator records for 2024.";
  const entries = available ? yearly.filter((entry) => regions.some((region) => region.id === entry.id)) : [];
  for (const id of ["indicator-workflow-details", "indicator-source-details", "indicator-download"]) {
    $(id).hidden = !hasRecordedWorkflow || !entries.length;
  }
  if (!available) return;
  $('indicator-empty').hidden=!!entries.length; $('indicator-values').hidden=!entries.length;
  $('indicator-month-heading').textContent=`${months[state.month]} ${state.year} · selected regions`;
  const table=$('indicator-monthly-values'); table.replaceChildren();
  const head=el('tr'); ['Candidate region','2 m air temperature · °C','Precipitation rate · mm/day','Valid paired months'].forEach(t=>head.append(el('th',t)));table.append(head);
  for(const r of entries){const tr=el('tr');[`${r.id} · ${named(r)}`,number(r.temperature.series[state.month].value,3),number(r.precipitation.series[state.month].value,3),`${r.profile.points.length}/12`].forEach(t=>tr.append(el('td',t)));table.append(tr);}
  for(const name of ['temperature','precipitation']) {
    indicatorChart(entries,name,name==='temperature'?'°C':'mm/day',`indicator-${name}-chart`);
    $(`indicator-${name}-legend`).replaceChildren(...entries.map(r=>{const item=el('span',`${r.id} · ${named(r)}`);item.style.color=color(state.data.regions.find(v=>v.id===r.id));return item;}));
  }
  renderSeasonalProfile(entries);
  renderSeasonalHistory(regions.filter((region) => entries.some(({ id }) => id === region.id)));
  const full=$('indicator-all-values'); full.replaceChildren(); const title=el('tr');title.append(el('th','Month'));
  entries.forEach(r=>[`${r.id} · °C`,`${r.id} · mm/day`].forEach(t=>title.append(el('th',t)))); full.append(title);
  for(let i=0;i<12;i++){const tr=el('tr');if(i===state.month)tr.setAttribute('aria-current','true');tr.append(el('th',months[i]));entries.forEach(r=>[r.temperature,r.precipitation].forEach(v=>tr.append(el('td',number(v.series[i].value,3)))));full.append(tr);}
  if (!hasRecordedWorkflow || !entries.length) return;
  $('indicator-sources').replaceChildren(...entries.map(r=>{
    const section=el('section');section.append(el('h3',`${r.id} · ${named(r)}`),el('p',`${r.precipitation.spatial_support.cell_count} grid cells · ${r.temperature.time.provider_time_standard} · NASA POWER / MERRA2 · API ${r.precipitation.provenance.api_version}`));
    for(const [name,label] of [['temperature','Temperature'],['precipitation','Precipitation']])section.append(el('p',`${label} · ${r[name].variable.provider_parameter} · source result SHA-256: ${r[name].provenance.source_result_sha256}`,'hash-note'));
    section.append(el('p',`Precipitation latitude range: ${r.precipitation.module_details.latitude_context.absolute_latitude_range_deg.map(v=>number(v,1)).join('–')}°.`));return section;
  }));
  const select=$('indicator-trace-region');
  if(!entries.some(r=>r.id===state.indicatorTraceRegion))state.indicatorTraceRegion=entries[0]?.id;
  select.replaceChildren(...entries.map(r=>{const o=el('option',`${r.id} · ${named(r)}`);o.value=r.id;return o;}));select.value=state.indicatorTraceRegion||'';
  const graph=$('indicator-trace-graph'),detail=$('indicator-trace-detail');graph.replaceChildren();detail.replaceChildren();
  const chosen=entries.find(r=>r.id===state.indicatorTraceRegion);
  if(chosen)drawTrace(chosen.workflow.trace,graph,detail,state.indicatorTraceNode,'indicator-arrow',id=>{state.indicatorTraceNode=id;renderIndicators(active());$('indicator-trace-graph').querySelector(`[data-node="${id}"]`)?.focus({preventScroll:true});});
}

async function loadIndicators(bytes,request) {
  try {
    const catalogHash = await datasetDigest(bytes), raw = await fetchRecordedData("./data/indicators.json");
    if(raw.length>500000)throw Error('Indicator data too large');
    const model=await validateIndicatorPreview(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)),catalogHash,state.periods);
    if(request!==state.annualRequest)return;
    state.seasonalYears = seasonalProfilesByYear(model, state.periods);
    state.indicators=model;state.indicatorStatus='available';
  } catch { if(request!==state.annualRequest)return; state.indicatorStatus='error';state.indicators=null;state.seasonalYears.clear(); }
  if (state.data) { renderIndicators(active()); syncScreen(); }
}

function render() {
  const regions = active();
  $("month-label").textContent = months[state.month]; $("month").setAttribute("aria-valuetext", `${months[state.month]} ${state.data.dates[0].slice(0, 4)}`);
  renderPair(regions); renderTrace(regions); renderMetrics(regions); renderChart(regions); renderHistory(regions); renderAnnual(regions); renderComparison(regions); renderSpatial(regions); renderSupport(regions); renderSources(regions); renderTable(regions);
  $("download").disabled = !regions.length;
  renderIndicators(regions);
  syncScreen();
}

async function readPeriods(bytes) {
  const source = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const entries = source.schema_version === "0.3.0" ? [{ year: Number(source.dates?.[0]?.slice(0, 4)), data: source, bytes }] : null;
  if (!entries) {
    if (source.schema_version !== "0.4.0" || source.output_type !== "recorded_temperature_year_catalog" || source.data_mode !== "recorded_offline_replay" || source.selection_status !== "candidate" || source.inference_performed !== false || !Number.isInteger(source.default_year) || !Array.isArray(source.snapshots) || !source.snapshots.length || source.snapshots.length > 50) throw Error("Unsupported year catalog");
  }
  const periods = new Map();
  for (const [i, row] of (entries || source.snapshots).entries()) {
    if (!Number.isInteger(row.year) || row.year < 1981 || row.year > 9999 || periods.has(row.year) || i && row.year !== [...periods.keys()].at(-1) + 1) throw Error("Invalid catalog year order");
    const raw = entries ? row.bytes : new TextEncoder().encode(row.data_json);
    if (!raw.length || raw.length > 8_000_000 || !entries && (typeof row.data_json !== "string" || !/^[a-f0-9]{64}$/.test(row.sha256))) throw Error("Invalid annual snapshot");
    const data = entries ? row.data : JSON.parse(row.data_json); validate(data);
    if (data.dates[0] !== `${row.year}-01`) throw Error("Snapshot belongs to another year");
    let digest = null;
    try { digest = await datasetDigest(raw); } catch { /* Keep graphs usable without Web Crypto. */ }
    if (digest && !entries && digest !== row.sha256) throw Error("Annual snapshot SHA-256 mismatch");
    periods.set(row.year, { data, digest });
  }
  const defaultYear = entries ? entries[0].year : source.default_year;
  if (!periods.has(defaultYear)) throw Error("Default year is unavailable");
  return { periods, defaultYear };
}

function mountYear(year, reset = false) {
  const snapshot = state.periods.get(year), data = snapshot.data;
  state.reviewRequest++; state.year = year; state.data = data; state.datasetSha256 = snapshot.digest;
  state.selected = new Set(data.regions.filter((r) => reset || state.selected.has(r.id)).map((r) => r.id));
  $("year").value = String(year);
  if (reset) { state.month = 0; state.policy = "unmasked"; state.spatialRegion = null; state.cell = 0; state.traceRegion = null; state.traceNode = null; state.pairLeft = null; state.pairRight = null; } $("policy").value = state.policy; $("month").value = String(state.month);
  $("region-options").replaceChildren(...data.regions.map((region) => {
    const label = el("label", undefined, "region-option"), checkbox = el("input"); checkbox.type = "checkbox"; checkbox.checked = state.selected.has(region.id); checkbox.value = region.id; checkbox.setAttribute("aria-label", `${region.id} · ${named(region)}`);
    checkbox.addEventListener("change", () => { if (checkbox.checked) state.selected.add(region.id); else state.selected.delete(region.id); render(); });
    const dot = el("span", undefined, "swatch"); dot.style.setProperty("--region-color", color(region)); label.append(checkbox, dot, el("span", `${region.id} · ${named(region)}`)); return label;
  }));
  render();
}

async function load() {
  state.indicators=null; state.indicatorStatus='loading'; state.seasonalYears.clear();
  weather.scale = null;
  stopWeatherPlayback();
  $("loading").hidden = false; $("results").hidden = true; $("error").hidden = true; state.datasetSha256 = null; state.reviewRequest++;
  const annualRequest = ++state.annualRequest; state.annual=null; state.annualStatus="loading"; state.annualTraces=new Map();
  try {
    const bytes = await fetchRecordedData("./data/results.json");
    if (bytes.length > 8_000_000) throw Error("Preview data too large");
    const catalog = await readPeriods(bytes); state.periods = catalog.periods;
    const years = [...state.periods.keys()];
    $("recorded-coverage").textContent = `Recorded period: ${years[0]}–${years.at(-1)} · ${years.length} years · ${years.length * 12} monthly records per region. The Selected year and Full record tabs show the corresponding monthly values.`;
    $("year").replaceChildren(...[...state.periods.keys()].map((year) => { const option = el("option", String(year)); option.value = String(year); return option; }));
    mountYear(catalog.defaultYear, true); $("results").hidden = false;
    void loadAnnual(bytes,state.periods,annualRequest);
    void loadIndicators(bytes,annualRequest);
  } catch { $("error").hidden = false; }
  finally { $("loading").hidden = true; }
}

$("year").addEventListener("change", () => mountYear(Number($("year").value)));
$("policy").addEventListener("change", () => { state.policy = $("policy").value; render(); });
$("indicator-use2024").addEventListener('click',()=>mountYear(2024));
$("indicator-trace-region").addEventListener('change',()=>{state.indicatorTraceRegion=$('indicator-trace-region').value;state.indicatorTraceNode='InputCheck';renderIndicators(active());});
$("indicator-download").addEventListener("click", () => {
  const regions = state.indicators.regions.filter((region) => state.selected.has(region.id))
    .map(({ temperature, precipitation, ...entry }) => ({ ...entry, display_name: named(entry) }));
  downloadJson({ schema_version: "0.1.0", output_type: "recorded_indicator_selection", year: 2024,
    month: state.month + 1, surface: "unmasked_candidate_rectangle", inference_performed: false,
    source_catalog_sha256: state.indicators.source_catalog_sha256, regions }, "expedition73-indicators-2024.json");
});
$("month").addEventListener("input", (event) => selectMonth(Number(event.target.value)));
$("history-month").addEventListener("input", () => {
  const date = state.historyDates[Number($("history-month").value)]; if (!date) return;
  state.month = Number(date.slice(-2)) - 1; $("month").value = String(state.month);
  const year = Number(date.slice(0, 4)); if (year !== state.year) mountYear(year); else render();
});
$("trace-region").addEventListener("change", () => { state.traceRegion = $("trace-region").value; state.traceNode = null; renderTrace(active()); });
const refreshPair = () => { const regions = active(); renderPair(regions); renderMetrics(regions); };
$("pair-left").addEventListener("change", () => { state.pairLeft = $("pair-left").value; refreshPair(); });
$("pair-right").addEventListener("change", () => { state.pairRight = $("pair-right").value; refreshPair(); });
$("pair-swap").addEventListener("click", () => { [state.pairLeft, state.pairRight] = [state.pairRight, state.pairLeft]; refreshPair(); });
$("retry").addEventListener("click", load);
$("spatial-region").addEventListener("change", () => { state.spatialRegion = $("spatial-region").value; state.cell = 0; renderSpatial(active()); });
window.matchMedia("(max-width:740px)").addEventListener("change", () => { if (state.data) { renderChart(active()); renderHistory(active()); renderAnnual(active()); renderTrace(active()); renderPair(active()); renderIndicators(active()); } });
function downloadFile(data, type, name) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = el("a"); link.href = url; link.download = name; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function downloadJson(data, name) {
  downloadFile(JSON.stringify(data, null, 2), "application/json", name);
}
$("review-download").addEventListener("click", () => {
  try {
    const report = createComparisonReview(state.data, state.datasetSha256, { left_id: state.pairLeft, right_id: state.pairRight, policy: state.policy, month: state.data.dates[state.month] });
    downloadJson(report, "expedition73-comparison-review.json");
    $("review-message").textContent = "Report ready. It includes the selection, results and dataset SHA-256.";
  } catch { $("review-message").textContent = "A report requires two regions with matching source and calculation metadata."; }
});
$("review-open").addEventListener("click", () => $("review-file").click());
$("review-file").addEventListener("change", async () => {
  const file = $("review-file").files[0], catalog = state.periods, request = ++state.reviewRequest;
  $("review-file").value = "";
  if (!file) return;
  try {
    if (file.size > 131072) throw Error("Unsupported review input");
    const parsed = JSON.parse(await file.text()), year = Number(parsed.selection?.month?.slice(0, 4));
    const snapshot = catalog.get(year);
    if (!snapshot?.digest) throw Error("Report year is unavailable");
    const source = snapshot.data, digest = snapshot.digest;
    const report = verifyComparisonReview(parsed, source, digest);
    if (request !== state.reviewRequest) return;
    if (state.periods !== catalog || $("results").hidden) throw Error("Snapshot changed during review load");
    // Apply nothing until every source and computed field has been checked.
    if (state.year !== year) mountYear(year);
    state.pairLeft = report.selection.left_id; state.pairRight = report.selection.right_id;
    state.policy = report.selection.policy; state.month = source.dates.indexOf(report.selection.month);
    state.selected.add(state.pairLeft); state.selected.add(state.pairRight);
    for (const checkbox of $("region-options").querySelectorAll("input")) checkbox.checked = state.selected.has(checkbox.value);
    $("policy").value = state.policy; $("month").value = String(state.month); render();
    $("review-message").textContent = "The report matched the dataset. Results were recomputed and verified, and the saved selection was restored.";
  } catch { if (request !== state.reviewRequest) return; $("review-message").textContent = "The report could not be verified. Check the dataset, report contents and file format."; }
});
$("download").addEventListener("click", () => {
  const regions = active().map((region) => ({ ...region, display_name: named(region),
    region: { ...region.region, label: regionDescription(region.region) } }));
  const selected = { schema_version: state.data.schema_version, selection_status: "candidate", data_mode: state.data.data_mode, inference_performed: false, selected_policy: state.policy, selected_month: state.data.dates[state.month], regions };
  downloadJson(selected, "expedition73-temperature-preview.json");
});
load();

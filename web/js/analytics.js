import { loadData } from "./data.js";
import { state, stageLabel, displayTitle, flagText } from "./util.js";
import { initI18n, t, tv, compareText } from "./i18n.js";
import { hbar, columns, stacked, scatter, line, table } from "./charts.js";
import { loadHistory, changes } from "./history.js";
import { drawGraph, typeInfo, edgeInfo, BANKRUPTCY, SUGGESTED, edgeText, graphIndex, developerChains, chainKind, sourceTitle } from "./graph.js";
import { drawTree } from "./tree.js";
import { enhanceLongSelects } from "./combobox.js";
import { extAnchor as link, appendLinkLegend } from "./links.js";

const $ = (id) => document.getElementById(id);
const STAGES = [
  { key: "finished", color: "var(--viz-s1)" },
  { key: "in progress", color: "var(--viz-s2)" },
  { key: "just started", color: "var(--viz-s3)" },
  { key: "not started", color: "var(--viz-s4)" },
  { key: "stalled", label: "stalled_short", color: "var(--viz-s5)" },
  { key: "unknown", color: "var(--viz-unknown)" },
];
const stageName = (s) => t(`stage.${s.label || s.key}`);
const areaName = (v) => tv("district", v);
const GRADES = ["A", "B", "C", "D", "E"];
const GRADE_COLORS = { A: "var(--viz-ord-5)", B: "var(--viz-ord-4)", C: "var(--viz-ord-3)", D: "var(--viz-ord-2)", E: "var(--viz-ord-1)" };
const app = { projects: [], meta: {}, connections: null, history: null, cnSelected: null, cnView: "tree", cnLayout: "network" };

// ---------------------------------------------------------------- numbers
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const quantile = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  const i = (s.length - 1) * q;
  return s[Math.floor(i)] + (s[Math.ceil(i)] - s[Math.floor(i)]) * (i % 1);
};
const perM2 = (usd, rate = state.rate) => (state.currency === "USD" ? usd : usd * rate);
/** Format a dollar amount in the chosen currency; `rate` overrides today's rate (history uses each snapshot's). */
function fmtMoney(usd, { compact = false, suffix = "", rate } = {}) {
  if (usd == null || Number.isNaN(usd)) return "-";
  return fmtAmount(perM2(usd, rate), { compact, suffix });
}
/** Format an amount already in the chosen currency. */
function fmtAmount(v, { compact = false, suffix = "" } = {}) {
  if (v == null || Number.isNaN(v)) return "-";
  const sym = state.currency === "USD" ? "$" : "֏";
  if (compact && v >= 1e6) return `${sym}${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M${suffix}`;
  if (compact && v >= 1e4) return `${sym}${Math.round(v / 1e3)}k${suffix}`;
  return `${sym}${Math.round(v).toLocaleString("en-US")}${suffix}`;
}
const fmtInt = (n) => Math.round(n).toLocaleString("en-US");
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "-");
const priced = (p) => p.kind === "Apartments" && p.usd_m2_min != null;
const openOnMap = (id) => () => { location.href = `index.html#p=${encodeURIComponent(id)}`; };
const mapLink = (p) => {
  const a = document.createElement("a");
  a.href = `index.html#p=${encodeURIComponent(p.id)}`;
  a.textContent = displayTitle(p);
  return a;
};

// ---------------------------------------------------------------- filters
function fillSelect(sel, values, allLabel, label = (v) => v) {
  const cur = sel.value;
  sel.replaceChildren(new Option(allLabel, ""));
  const sorted = [...values].sort((a, b) => compareText(label(a[0]), label(b[0])));
  for (const [v, n] of sorted) sel.append(new Option(`${label(v)} (${n})`, v));
  sel.value = values.some(([v]) => v === cur) ? cur : "";
}
// Alphabetical: the lists are long and searchable, so a reader looks a name up rather than scanning by size.
const counts = (items, key) => [...items.reduce((m, p) => (p[key] ? m.set(p[key], (m.get(p[key]) || 0) + 1) : m), new Map())].sort((a, b) => a[0].localeCompare(b[0]));

function readFilters() {
  return { region: $("af-region").value, district: $("af-district").value, kind: $("af-kind").value, stage: $("af-stage").value, grade: $("af-grade").value };
}

/** Whether a project (or history row) passes the filters; `gradeOf` reads its developer grade. */
function matchesFilters(r, f, gradeOf = (x) => x.developer_rep?.grade) {
  const grade = gradeOf(r);
  return (!f.region || r.region === f.region) && (!f.district || r.district === f.district)
    && (!f.kind || r.kind === f.kind) && (!f.stage || r.stage === f.stage)
    && (!f.grade || (grade != null && grade <= f.grade));
}

function filtered(skip) {
  const f = { ...readFilters(), ...(skip ? { [skip]: "" } : {}) };
  return app.projects.filter((p) => matchesFilters(p, f));
}

/** Fill a stage legend with the stages present and return them as chart series. */
function stageLegend(node, present) {
  node.replaceChildren(...present.map((s) => {
    const span = document.createElement("span");
    const i = document.createElement("i"); i.style.background = s.color;
    span.append(i, document.createTextNode(stageName(s)));
    return span;
  }));
  return present.map((s) => ({ ...s, label: stageName(s) }));
}

const countStages = (rows) => rows.reduce((m, r) => m.set(r.stage || "unknown", (m.get(r.stage || "unknown") || 0) + 1), new Map());

function refreshFilterOptions() {
  fillSelect($("af-region"), counts(filtered("region"), "region"), t("filters.all_regions"), (v) => tv("region", v));
  fillSelect($("af-district"), counts(filtered("district"), "district"), t("filters.all_districts"), areaName);
  fillSelect($("af-kind"), counts(filtered("kind"), "kind"), t("analytics.all_types"), (v) => tv("kind", v));
  const stageCounts = counts(filtered("stage"), "stage").map(([k, n]) => [k, n]);
  const sel = $("af-stage");
  const cur = sel.value;
  sel.replaceChildren(new Option(t("analytics.all_stages"), ""));
  for (const s of STAGES) {
    const n = stageCounts.find(([k]) => k === s.key)?.[1];
    if (n) sel.append(new Option(`${stageName(s)} (${n})`, s.key));
  }
  sel.value = cur;
  const f = readFilters();
  $("af-reset").hidden = !Object.values(f).some(Boolean);
}

// ---------------------------------------------------------------- sections
function renderKpis(items) {
  const p = items.filter(priced);
  const prices = p.map((x) => x.usd_m2_min);
  const med = median(prices);
  $("kpi-hero").textContent = med ? fmtMoney(med) : "-";
  $("kpi-hero-sub").textContent = prices.length
    ? t("analytics.hero_sub", { n: fmtInt(prices.length), lo: fmtMoney(quantile(prices, 0.25)), hi: fmtMoney(quantile(prices, 0.75)) })
    : t("analytics.hero_none");
  const building = items.filter((x) => ["in progress", "just started"].includes(x.stage)).length;
  const devs = new Set(items.map((x) => x.developer_group).filter((d) => d && d !== "Unknown developer")).size;
  const verified = items.filter((x) => x.price_confidence === "verified").length;
  const soldOut = items.filter((x) => x.sold_out).length;
  const risky = new Set(items.filter((x) => (x.developer_rep?.flags || []).some((f) => /bankruptcy|criminal/.test(f))).map((x) => x.developer_group)).size;
  const share = (n) => t("analytics.kpi_share", { pct: pct(n, items.length) });
  const tiles = [
    [t("analytics.kpi_projects"), fmtInt(items.length), t("analytics.kpi_developers", { n: fmtInt(devs) })],
    [t("analytics.kpi_building"), fmtInt(building), share(building)],
    [t("analytics.kpi_verified"), fmtInt(verified), share(verified)],
    [t("analytics.kpi_sold"), fmtInt(soldOut), share(soldOut)],
    [t("analytics.kpi_median_from"), fmtMoney(median(items.map((x) => x.usd_from).filter(Boolean)), { compact: true }), t("analytics.kpi_cheapest")],
    [t("analytics.kpi_bankrupt"), fmtInt(risky), t("analytics.kpi_datalex")],
  ];
  $("an-kpis").replaceChildren(...tiles.map(([label, value, small]) => {
    const d = document.createElement("div");
    d.className = "kpi";
    const s = document.createElement("span"); s.textContent = label;
    const b = document.createElement("b"); b.textContent = value;
    const m = document.createElement("small"); m.textContent = small;
    d.append(s, b, m);
    return d;
  }));
}

/** Chart label for a project's area: a Yerevan district, "Town, Region", or "Region — other". */
function areaKey(p) {
  const d = p.district || p.region;
  if (!d) return t("analytics.unknown");
  if (p.region === "Yerevan" || d === p.region) return areaName(d);
  if (/\(other\)$/.test(d)) return t("analytics.other_region", { region: tv("region", p.region) });
  return `${areaName(d).replace(/\s*\(.*\)$/, "")}, ${tv("region", p.region)}`;
}

function renderDistricts(items) {
  const groups = new Map();
  for (const p of items.filter(priced)) {
    const key = areaKey(p);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p.usd_m2_min);
  }
  const rows = [...groups].filter(([, v]) => v.length >= 3)
    .map(([label, v]) => ({ label, n: v.length, med: median(v), q1: quantile(v, 0.25), q3: quantile(v, 0.75) }))
    .sort((a, b) => b.med - a.med)
    .slice(0, 22);
  hbar($("ch-district"), rows.map((r) => ({
    label: r.label, value: r.med, display: fmtMoney(r.med),
    tipLabel: t("analytics.district_tip", { label: r.label, n: r.n }), tipNote: t("analytics.middle_half", { lo: fmtMoney(r.q1), hi: fmtMoney(r.q3) }),
  })), { format: (v) => fmtMoney(v, { compact: true }) });
  table($("tb-district"), [
    { label: t("analytics.col_area"), key: "label" }, { label: t("analytics.col_projects"), key: "n", num: true },
    { label: t("analytics.col_median"), num: true, render: (r) => fmtMoney(r.med) },
    { label: t("analytics.col_p25"), num: true, render: (r) => fmtMoney(r.q1) }, { label: t("analytics.col_p75"), num: true, render: (r) => fmtMoney(r.q3) },
  ], rows);
}

function renderHistogram(items) {
  const prices = items.filter(priced).map((p) => p.usd_m2_min);
  const step = 250;
  const cap = 4500;
  const bins = [];
  for (let lo = 500; lo < cap; lo += step) bins.push({ lo, hi: lo + step, n: 0 });
  bins.push({ lo: cap, hi: Infinity, n: 0 });
  const below = { lo: 0, hi: 500, n: 0 };
  for (const v of prices) {
    if (v < 500) { below.n++; continue; }
    (bins.find((b) => v >= b.lo && v < b.hi) || bins[bins.length - 1]).n++;
  }
  const all = [below, ...bins];
  const label = (b) => (b.hi === Infinity ? `${fmtMoney(b.lo, { compact: true })}+` : b.lo === 0 ? `<${fmtMoney(b.hi, { compact: true })}` : fmtMoney(b.lo, { compact: true }));
  columns($("ch-hist"), all.map((b) => ({
    label: label(b), value: b.n,
    tipLabel: b.hi === Infinity ? t("analytics.hist_above", { price: fmtMoney(b.lo) }) : t("analytics.hist_band_tip", { lo: fmtMoney(b.lo), hi: fmtMoney(b.hi) }),
  })), { format: (v) => String(Math.round(v)), labelEvery: 4 });
  table($("tb-hist"), [
    { label: t("analytics.col_band"), render: (b) => (b.hi === Infinity ? `${fmtMoney(b.lo)}+` : `${fmtMoney(b.lo)}–${fmtMoney(b.hi)}`) },
    { label: t("analytics.col_projects"), key: "n", num: true },
  ], all.filter((b) => b.n));
}

function renderPipeline(items) {
  const years = new Map();
  for (const p of items) if (p.completion_year) years.set(p.completion_year, (years.get(p.completion_year) || 0) + 1);
  const thisYear = new Date().getFullYear();
  const keys = [...years.keys()].filter((y) => y >= thisYear - 5 && y <= thisYear + 6).sort();
  const earlier = [...years].filter(([y]) => y < thisYear - 5).reduce((s, [, n]) => s + n, 0);
  const cols = keys.map((y) => ({
    label: String(y), value: years.get(y), color: y < thisYear ? "var(--viz-past)" : "var(--viz-seq)",
    tipLabel: `${y}${y < thisYear ? t("analytics.pipeline_past") : y === thisYear ? t("analytics.pipeline_now") : ""}`,
  }));
  columns($("ch-pipeline"), cols, { format: (v) => String(Math.round(v)) });
  table($("tb-pipeline"), [{ label: t("analytics.col_year"), key: "label" }, { label: t("analytics.col_projects"), key: "value", num: true }],
    [...(earlier ? [{ label: t("analytics.pipeline_before", { y: thisYear - 5 }), value: earlier }] : []), ...cols]);
}

function renderStages(items) {
  const f = readFilters();
  const byDistrict = Boolean(f.region || f.district);
  const key = (p) => areaName(byDistrict ? p.district : p.region) || t("analytics.unknown");
  const groups = new Map();
  for (const p of items) {
    const k = key(p);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  let rows = [...groups].map(([label, ps]) => ({ label, total: ps.length, m: countStages(ps) }))
    .sort((a, b) => b.total - a.total);
  if (rows.length > 12) {
    const tail = rows.slice(11);
    const other = new Map();
    for (const r of tail) for (const [k, v] of r.m) other.set(k, (other.get(k) || 0) + v);
    rows = [...rows.slice(0, 11), { label: t("analytics.stage_other", { n: tail.length }), total: tail.reduce((s, r) => s + r.total, 0), m: other }];
  }
  const series = stageLegend($("lg-stage"), STAGES.filter((s) => rows.some((r) => r.m.get(s.key))));
  stacked($("ch-stage"), rows.map((r) => ({ label: r.label, parts: series.map((s) => ({ key: s.key, value: r.m.get(s.key) || 0 })) })), series);
  table($("tb-stage"), [{ label: t(byDistrict ? "analytics.col_district" : "analytics.col_region"), key: "label" },
    ...series.map((s) => ({ label: s.label, num: true, render: (r) => r.m.get(s.key) || 0 })),
    { label: t("analytics.col_total"), key: "total", num: true }], rows);
}

function renderScatter(items) {
  const pts = items.filter((p) => priced(p) && p.completion)
    .map((p) => ({ p, d: new Date(p.completion) }))
    .filter(({ d }) => !Number.isNaN(d.getTime()) && d.getFullYear() >= 2018 && d.getFullYear() <= 2032)
    .map(({ p, d }) => ({
      x: d, y: p.usd_m2_min, label: `${displayTitle(p)} · ${areaName(p.district || p.region)}`,
      note: `${t("analytics.scatter_note", { stage: stageLabel(p), date: p.completion.slice(0, 7) })}${p.developer_rep ? t("analytics.scatter_dev", { grade: p.developer_rep.grade }) : ""}`,
      onClick: openOnMap(p.id),
    }));
  scatter($("ch-scatter"), pts, { formatY: (v) => fmtMoney(v, { compact: true }) });
}

// ---------------------------------------------------------------- history
function renderHistory() {
  if (!app.history) return;
  const f = readFilters();
  const snaps = app.history.map((s) => ({ ...s, rows: s.rows.filter((r) => matchesFilters(r, f, (x) => x.grade)) }));
  const stats = snaps.map((s, i) => {
    const prices = s.rows.filter(priced).map((r) => r.usd_m2_min);
    return { s, n: prices.length, med: median(prices), ...(i ? changes(snaps[i - 1], s) : {}) };
  });
  const backfillNote = (s) => (s.origin === "backfill" ? t("analytics.trend_backfill") : null);
  line($("ch-trend"), [{
    color: "var(--viz-seq)",
    points: stats.filter((x) => x.med != null).map(({ s, n, med }) => ({
      x: new Date(s.date), y: perM2(med, s.rate), label: t("analytics.trend_tip", { date: s.date, n }), note: backfillNote(s),
    })),
  }], { formatY: (v) => fmtAmount(v, { compact: true }) });

  const stageCounts = snaps.map((s) => countStages(s.rows));
  const series = stageLegend($("lg-trend-stage"), STAGES.filter((st) => stageCounts.some((m) => m.get(st.key))));
  stacked($("ch-trend-stage"), snaps.map((s, i) => ({
    label: s.date,
    parts: series.map((st) => ({ key: st.key, value: stageCounts[i].get(st.key) || 0 })),
  })), series, { labelWidth: 100 });

  const num = (k) => (x) => (x[k] == null ? "-" : fmtInt(x[k]));
  table($("tb-trend"), [
    { label: t("analytics.col_date"), render: (x) => x.s.date },
    { label: t("analytics.col_origin"), render: (x) => t(`analytics.origin_${x.s.origin}`) },
    { label: t("analytics.col_projects"), num: true, render: (x) => fmtInt(x.s.rows.length) },
    { label: t("analytics.col_median"), num: true, render: (x) => fmtMoney(x.med, { rate: x.s.rate }) },
    { label: t("analytics.col_added"), num: true, render: num("added") },
    { label: t("analytics.col_removed"), num: true, render: num("removed") },
    { label: t("analytics.col_merged"), num: true, render: num("merged") },
    { label: t("analytics.col_price_changes"), num: true, render: num("price") },
    { label: t("analytics.col_stage_changes"), num: true, render: num("stage") },
  ], [...stats].reverse());
}

async function loadHistoryCard() {
  try {
    app.history = await loadHistory();
    renderHistory();
  } catch (err) {
    console.error(err);
    $("an-history").hidden = true;
  }
}

function renderGrades(items) {
  const n = new Map(GRADES.map((g) => [g, 0]));
  let none = 0;
  for (const p of items) {
    const g = p.developer_rep?.grade;
    if (g) n.set(g, n.get(g) + 1); else none++;
  }
  const cols = GRADES.map((g) => ({ label: g, value: n.get(g), color: GRADE_COLORS[g], tipLabel: t("analytics.grades_tip", { grade: g }) }));
  columns($("ch-grades"), cols, { format: (v) => String(Math.round(v)) });
  table($("tb-grades"), [{ label: t("analytics.col_rating"), key: "label" }, { label: t("analytics.col_projects"), key: "value", num: true }],
    [...cols, { label: t("analytics.not_rated"), value: none }]);
}

function qualityRow(title, parts, total) {
  const wrap = document.createElement("div");
  wrap.className = "q-row";
  const head = document.createElement("div");
  head.className = "q-head";
  const name = document.createElement("span"); name.textContent = title;
  const good = parts.filter((x) => x.good).reduce((s, x) => s + x.n, 0);
  const g = document.createElement("b"); g.textContent = t("analytics.q_good", { pct: pct(good, total) });
  head.append(name, g);
  const bar = document.createElement("div");
  bar.className = "q-bar";
  const keys = document.createElement("div");
  keys.className = "q-keys";
  for (const part of parts.filter((x) => x.n)) {
    const seg = document.createElement("div");
    seg.style.flex = String(part.n);
    seg.style.background = part.color;
    seg.title = `${part.label}: ${part.n} (${pct(part.n, total)})`;
    bar.append(seg);
    const k = document.createElement("span");
    const i = document.createElement("i"); i.style.background = part.color;
    k.append(i, document.createTextNode(`${part.label} ${part.n}`));
    keys.append(k);
  }
  wrap.append(head, bar, keys);
  return wrap;
}

function renderQuality(items) {
  const total = items.length;
  const c = (fn) => items.filter(fn).length;
  $("ch-quality").replaceChildren(
    qualityRow(t("analytics.q_price"), [
      { label: t("analytics.q_price_verified"), n: c((p) => p.price_confidence === "verified"), color: "var(--viz-ord-5)", good: true },
      { label: t("analytics.q_price_high"), n: c((p) => p.price_confidence === "high"), color: "var(--viz-ord-3)", good: true },
      { label: t("analytics.q_price_one"), n: c((p) => ["medium", "low", "rejected"].includes(p.price_confidence)), color: "var(--viz-ord-1)" },
      { label: t("analytics.q_price_none"), n: c((p) => !p.price_confidence || p.price_confidence === "none"), color: "var(--viz-unknown)" },
    ], total),
    qualityRow(t("analytics.q_location"), [
      { label: t("analytics.q_loc_exact"), n: c((p) => p.geo_precision === "exact"), color: "var(--viz-ord-5)", good: true },
      { label: t("analytics.q_loc_address"), n: c((p) => p.geo_precision === "address"), color: "var(--viz-ord-3)", good: true },
      { label: t("analytics.q_loc_street"), n: c((p) => p.geo_precision === "street"), color: "var(--viz-ord-1)" },
      { label: t("analytics.q_loc_area"), n: c((p) => ["district", "city"].includes(p.geo_precision)), color: "var(--viz-unknown)" },
    ], total),
    qualityRow(t("analytics.q_info"), [
      { label: "90–100%", n: c((p) => p.info_score >= 90), color: "var(--viz-ord-5)", good: true },
      { label: "70–89%", n: c((p) => p.info_score >= 70 && p.info_score < 90), color: "var(--viz-ord-3)", good: true },
      { label: "50–69%", n: c((p) => p.info_score >= 50 && p.info_score < 70), color: "var(--viz-ord-1)" },
      { label: t("analytics.q_info_low"), n: c((p) => p.info_score < 50), color: "var(--viz-unknown)" },
    ], total),
    qualityRow(t("analytics.q_research"), [
      { label: t("analytics.q_research_full"), n: c((p) => p.developer_rep?.data === "full"), color: "var(--viz-ord-5)", good: true },
      { label: t("analytics.q_research_limited"), n: c((p) => p.developer_rep && p.developer_rep.data !== "full"), color: "var(--viz-ord-1)" },
      { label: t("analytics.q_research_none"), n: c((p) => !p.developer_rep), color: "var(--viz-unknown)" },
    ], total),
  );
}

function renderDevelopers(items) {
  const groups = new Map();
  for (const p of items) {
    const g = p.developer_group;
    if (!g || g === "Unknown developer" || g.endsWith("(developer n/a)")) continue;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(p);
  }
  const rows = [...groups].map(([name, ps]) => ({
    name, n: ps.length,
    building: ps.filter((p) => ["in progress", "just started"].includes(p.stage)).length,
    med: median(ps.filter(priced).map((p) => p.usd_m2_min)),
    rep: ps[0].developer_rep,
  })).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)).slice(0, 20);
  table($("tb-developers"), [
    { label: t("analytics.col_developer"), key: "name" },
    { label: t("analytics.col_projects"), key: "n", num: true },
    { label: t("analytics.col_building"), key: "building", num: true },
    { label: t("analytics.col_median"), num: true, render: (r) => fmtMoney(r.med) },
    { label: t("analytics.col_rating"), render: (r) => (r.rep ? `${r.rep.grade} (${r.rep.score})${r.rep.data === "full" ? "" : "?"}` : "-") },
    { label: t("analytics.col_flags"), render: (r) => (r.rep?.flags || []).filter((f) => !/not checked/.test(f)).map(flagText).join("; ") || t("analytics.flags_none") },
  ], rows);
}

function renderDeals(items) {
  const rows = items.filter((p) => priced(p) && p.price_confidence === "verified" && p.discount_pct > 0 && !p.sold_out)
    .sort((a, b) => b.discount_pct - a.discount_pct).slice(0, 20);
  table($("tb-deals"), [
    { label: t("analytics.col_project"), render: mapLink },
    { label: t("analytics.col_area"), render: (p) => areaName(p.district || p.region) },
    { label: t("analytics.col_ppm"), num: true, render: (p) => fmtMoney(p.usd_m2_min) },
    { label: t("analytics.col_local_median"), num: true, render: (p) => fmtMoney(p.bench_usd_m2) },
    { label: t("analytics.col_below"), num: true, render: (p) => `${p.discount_pct}%` },
    { label: t("analytics.col_stage"), render: (p) => stageLabel(p) },
    { label: t("analytics.col_developer"), render: (p) => `${p.developer_group}${p.developer_rep ? ` · ${p.developer_rep.grade}` : ""}` },
  ], rows);
}


// ---------------------------------------------------------------- connections graph
const cnNode = (id) => app.connections?.byId.get(id);

/** Nodes to draw: clusters kept whole, filtered by scope, by the page filters and by the focus pick. */
function connectionView(items) {
  const c = app.connections;
  if (!c) return { nodes: [], edges: [] };
  const scope = $("cn-scope").value;
  const focus = $("cn-focus").value;
  const inFilter = new Set(items.map((p) => p.developer_group));
  const flagged = new Set(c.nodes.filter((n) => n.bankruptcy).map((n) => n.component));
  const keep = new Set();
  for (const n of c.nodes) {
    if (n.type !== "developer") continue;
    if (scope === "linked" && n.component_developers < 2) continue;
    if (scope === "flagged" && !flagged.has(n.component)) continue;
    if (!inFilter.has(n.label)) continue;
    keep.add(n.component);
  }
  if (focus) {
    const f = cnNode(focus);
    keep.clear();
    if (f) keep.add(f.component);
  }
  // A node-link graph stops being readable past a few hundred marks, so the largest clusters are drawn
  // first and the rest are left to the tables below.
  const LIMIT = 460;
  const sizes = new Map();
  for (const n of c.nodes) sizes.set(n.component, (sizes.get(n.component) || 0) + 1);
  const order = [...keep].sort((a, b) => (c.devCount.get(b) || 0) - (c.devCount.get(a) || 0) || sizes.get(b) - sizes.get(a));
  const shown = new Set();
  let total = 0;
  for (const comp of order) {
    if (total && total + sizes.get(comp) > LIMIT) continue;
    shown.add(comp);
    total += sizes.get(comp);
  }
  const nodes = c.nodes.filter((n) => shown.has(n.component));
  const ids = new Set(nodes.map((n) => n.id));
  const leads = $("cn-family").checked;
  const edges = c.edges.filter((e) => ids.has(e.source) && ids.has(e.target) && (leads || !SUGGESTED.has(e.kind)));
  return { nodes, edges, hidden: keep.size - shown.size };
}

function bankruptcyBadge(b) {
  const s = document.createElement("span");
  s.className = `cn-status ${b.status}`;
  s.textContent = BANKRUPTCY[b.status].label();
  return s;
}

/** Side panel for the selected node: what it is, how it connects, and every source behind it. */
function renderCnPanel(node) {
  const host = $("cn-panel");
  const c = app.connections;
  host.replaceChildren();
  if (!node) {
    const p = document.createElement("p");
    p.className = "cn-empty";
    p.textContent = t("cn.panel_empty");
    host.append(p);
    return;
  }
  const h = document.createElement("h3");
  h.textContent = node.label;
  const kind = document.createElement("div");
  kind.className = "cn-kind";
  kind.textContent = typeInfo[node.type]?.label() || node.type;
  host.append(kind, h);
  if (node.bankruptcy) {
    host.append(bankruptcyBadge(node.bankruptcy));
    const why = document.createElement("p");
    why.className = "cn-basis";
    why.textContent = node.bankruptcy.basis || "";
    host.append(why);
  }

  const dl = document.createElement("dl");
  const row = (label, value) => {
    if (value == null || value === "") return;
    const dt = document.createElement("dt"); dt.textContent = label;
    const dd = document.createElement("dd");
    if (value instanceof Node) dd.append(value); else dd.textContent = value;
    dl.append(dt, dd);
  };
  if (node.type === "developer") {
    row(t("cn.row_projects"), String(node.projects));
    row(t("cn.row_rating"), node.grade ? `${node.grade} (${node.score})` : t("cn.row_not_rated"));
    row(t("cn.row_role"), node.role && tv("role", node.role));
    row(t("cn.row_lawsuits"), node.lawsuits != null ? String(node.lawsuits) : null);
  } else if (node.type === "company") {
    row(t("cn.row_tax_id"), node.tax_id);
    row(t("cn.row_former_name"), node.former_name);
    row(t("cn.row_status"), node.status === "inactive" ? t("cn.status_inactive") : node.status === "active" ? t("cn.status_active") : null);
    row(t("cn.row_form"), node.form);
    row(t("cn.row_registered"), node.registered);
    row(t("cn.row_address"), node.address);
    row(t("cn.row_activity"), node.nace);
    row(t("cn.row_director"), node.director);
    row(t("cn.row_cases"), node.court_cases != null ? String(node.court_cases) : null);
  } else {
    row(t("cn.row_companies"), String(node.companies));
  }
  host.append(dl);

  const connected = c.edges
    .filter((e) => e.source === node.id || e.target === node.id)
    .map((e) => ({ other: cnNode(e.source === node.id ? e.target : e.source), e }))
    .filter((x) => x.other);
  if (connected.length) {
    const heading = document.createElement("div");
    heading.className = "cn-kind";
    heading.textContent = t("cn.connected_to");
    const ul = document.createElement("ul");
    for (const { other, e } of connected.slice(0, 24)) {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.className = "link";
      b.textContent = other.label;
      b.addEventListener("click", () => selectCn(other.id));
      li.append(b, document.createTextNode(` - ${edgeText(e)}`));
      if (e.evidence) li.append(document.createTextNode(" "), link(t("common.source"), e.evidence));
      ul.append(li);
    }
    host.append(heading, ul);
  }

  const sources = [...(node.sources || []), ...(node.bankruptcy?.sources || [])].filter((s) => s.url);
  const cases = [...(node.bankruptcy?.cases || []), ...(node.cases || [])];
  const heading = document.createElement("div");
  heading.className = "cn-kind";
  heading.textContent = t("cn.sources");
  const ul = document.createElement("ul");
  for (const s of sources) {
    const li = document.createElement("li");
    li.append(link(sourceTitle(s), s.url));
    if (s.note) li.append(document.createTextNode(` - ${s.note}`));
    ul.append(li);
  }
  const caseUrl = (k) => k.url || `https://datalex.am/?app=AppCaseSearch&case_number=${encodeURIComponent(k.case_number)}`;
  for (const k of cases) {
    const li = document.createElement("li");
    const a = link(t("cn.case", { n: k.case_number }), caseUrl(k), { title: t("cn.case_title") });
    li.append(a);
    const note = [tv("tab", k.tab), k.filed, k.claimant && t("cn.claimant", { name: k.claimant }), k.why].filter(Boolean).join(" · ");
    if (note) li.append(document.createTextNode(` - ${note}`));
    ul.append(li);
  }
  if (node.bankruptcy?.confirmed_by) {
    const li = document.createElement("li");
    li.append(link(t("cn.confirmation"), node.bankruptcy.confirmed_by));
    ul.append(li);
  }
  host.append(heading, ul);
  appendLinkLegend(host);
}

function selectCn(id) {
  app.cnSelected = id;
  app.cnGraph?.select(id);
  renderCnPanel(id ? cnNode(id) : null);
}

/** Developer pairs in one cluster and the shortest chain that links them. */
function developerPairs(view) {
  const index = graphIndex(view);
  const devs = view.nodes.filter((n) => n.type === "developer");
  const order = new Map(devs.map((d, i) => [d.id, i]));
  const out = [];
  for (const from of devs) {
    for (const { target, steps } of developerChains(from, index)) {
      if (order.get(target.id) <= order.get(from.id)) continue;  // each pair once
      const via = steps.slice(0, -1).map((x) => x.node);
      out.push({ a: from, b: target, via, how: t(`cn.how_${chainKind(steps)}`), flagged: via.some((n) => n.bankruptcy) });
    }
  }
  return out.sort((a, b) => (b.flagged - a.flagged) || a.via.length - b.via.length || compareText(a.a.label, b.a.label));
}

/** Let the graph take the viewport — 1,300 nodes need the room — and redraw it at the new size. */
function expandConnections(on) {
  app.cnExpanded = on;
  document.body.classList.toggle("cn-full", on);
  $("an-connections").classList.toggle("cn-expanded", on);
  renderConnections(filtered());
  if (on) $("an-connections").scrollIntoView({ block: "start" });
}

function renderConnections(items) {
  const c = app.connections;
  if (!c) return;
  const view = connectionView(items);
  const host = $("ch-connections");
  const treeHost = $("ch-connections-tree");
  const asTree = app.cnView === "tree";
  host.hidden = asTree;
  treeHost.hidden = !asTree;
  $("cn-note").textContent = view.hidden ? t("cn.hidden", { n: view.hidden }) : "";
  const draw = asTree ? drawTree : drawGraph;
  app.cnGraph = draw(asTree ? treeHost : host, view, {
    onSelect: (n) => selectCn(n?.id || null),
    selected: app.cnSelected,
    expanded: app.cnExpanded,
    onExpand: () => expandConnections(!app.cnExpanded),
    layout: app.cnLayout,
    onLayout: (mode) => { app.cnLayout = mode; renderConnections(filtered()); },
    height: app.cnExpanded ? Math.max(420, window.innerHeight - 250) : undefined,
  });
  if (app.cnSelected && !view.nodes.some((n) => n.id === app.cnSelected)) app.cnSelected = null;
  renderCnPanel(app.cnSelected ? cnNode(app.cnSelected) : null);

  $("cn-legend").replaceChildren(...[
    ...Object.entries(typeInfo).map(([, type]) => {
      const s = document.createElement("span");
      const i = document.createElement("i");
      i.style.background = type.color;
      i.style.borderRadius = type.shape === "circle" ? "50%" : type.shape === "diamond" ? "2px" : "3px";
      if (type.shape === "diamond") i.style.transform = "rotate(45deg)";
      s.append(i, document.createTextNode(type.label()));
      return s;
    }),
    ...($("cn-family").checked ? [["family", edgeInfo.family], ["family_lead", edgeInfo.family_lead]] : []).map(([, e]) => {
      const s = document.createElement("span");
      const i = document.createElement("i");
      i.style.background = "none";
      i.style.borderTop = `2px ${e.dash ? "dotted" : "solid"} var(--viz-s5)`;
      i.style.height = "0";
      i.style.width = "14px";
      s.append(i, document.createTextNode(e.label()));
      return s;
    }),
    ...Object.entries(BANKRUPTCY).map(([key, b]) => {
      const s = document.createElement("span");
      s.className = "cn-status-key";
      const i = document.createElement("i");
      i.className = `${key === "case" ? "case" : ""} ${b.dash ? "dashed" : ""}`.trim();
      s.append(i, document.createTextNode(b.label()));
      return s;
    }),
  ]);

  $("cn-nodes").replaceChildren(...view.nodes.slice(0, 600).map((n) => new Option(n.label)));

  const pairs = developerPairs(view);
  table($("tb-connections"), [
    { label: t("cn.col_developer"), render: (r) => r.a.label },
    { label: t("cn.col_connected"), render: (r) => r.b.label },
    { label: t("cn.col_how"), key: "how" },
    { label: t("cn.col_through"), render: (r) => r.via.map((n) => n.label).join(" → ") || "-" },
    { label: t("cn.col_flagged"), render: (r) => t(r.flagged ? "common.yes" : "common.no") },
  ], pairs.slice(0, 60));

  const flags = view.nodes.filter((n) => n.bankruptcy)
    .sort((a, b) => Object.keys(BANKRUPTCY).indexOf(a.bankruptcy.status) - Object.keys(BANKRUPTCY).indexOf(b.bankruptcy.status));
  table($("tb-bankrupt"), [
    { label: t("cn.col_company"), render: (n) => (n.sources?.[0]?.url ? link(n.label, n.sources[0].url) : n.label) },
    { label: t("cn.col_status"), render: (n) => BANKRUPTCY[n.bankruptcy.status].label() },
    {
      label: t("cn.col_developer"),
      render: (n) => {
        const own = (n.developers || []).map((d) => cnNode(d)?.label).filter(Boolean);
        if (own.length) return own.join(", ");
        // an owner's other company: name the developers it shares a cluster with
        const near = app.connections.nodes
          .filter((x) => x.type === "developer" && x.component === n.component).map((x) => x.label);
        return near.length ? t("cn.same_owners", { list: near.slice(0, 3).join(", ") }) : "-";
      },
    },
    { label: t("cn.col_registry"), render: (n) => t(n.status === "inactive" ? "cn.status_inactive" : "cn.status_active") },
    { label: t("cn.col_basis"), render: (n) => n.bankruptcy.basis },
    {
      label: t("cn.col_cases"), render: (n) => {
        const f = document.createDocumentFragment();
        (n.bankruptcy.cases || []).slice(0, 3).forEach((k, i) => {
          if (i) f.append(document.createTextNode(", "));
          f.append(k.url ? link(k.case_number, k.url) : document.createTextNode(k.case_number));
        });
        return f.childNodes.length ? f : "-";
      },
    },
    { label: t("cn.col_bulletin"), render: (n) => link("azdarar.am", (n.sources || []).find((s) => /azdarar/.test(s.url))?.url || "https://www.azdarar.am/") },
  ], flags);
}

function fillFocus() {
  const sel = $("cn-focus");
  const devs = app.connections.nodes.filter((n) => n.type === "developer")
    .sort((a, b) => a.label.localeCompare(b.label));
  sel.replaceChildren(new Option(t("cn.all_clusters"), ""));
  for (const d of devs) {
    sel.append(new Option(d.component_developers > 1 ? t("cn.linked_option", { label: d.label, n: d.component_developers }) : d.label, d.id));
  }
}

async function loadConnections() {
  try {
    const res = await fetch("data/connections.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    data.byId = new Map(data.nodes.map((n) => [n.id, n]));
    data.devCount = new Map(data.nodes.filter((n) => n.type === "developer").map((n) => [n.component, n.component_developers]));
    app.connections = data;
    fillFocus();
    enhanceLongSelects();
    const src = $("cn-sources");
    const m = data.meta;
    // the register check goes before the text's closing "Sources:", which the links below follow
    const register = m.register_date && t("cn.meta_register", {
      date: m.register_date, companies: m.register_checked, current: m.owners_confirmed, former: m.owners_former, dropped: m.owners_dropped,
    });
    const crawl = t("cn.meta_sources", {
      date: m.crawled, companies: m.companies, people: m.people, developers: m.developers,
      by_tax: m.matched_by_tax_id, by_name: m.matched_by_name, unresolved: m.unresolved_entities,
    });
    src.replaceChildren(document.createTextNode([register, crawl].filter(Boolean).join(" ")));
    data.meta.sources.forEach((s, i) => {
      if (i) src.append(document.createTextNode(" · "));
      src.append(link(s.title, s.url));
    });
    renderConnections(filtered());
  } catch (err) {
    console.error(err);
    document.getElementById("an-connections").hidden = true;
  }
}

function render() {
  refreshFilterOptions();
  const items = filtered();
  document.getElementById("an-main").style.opacity = "1";
  renderKpis(items);
  renderDistricts(items);
  renderHistogram(items);
  renderPipeline(items);
  renderStages(items);
  renderScatter(items);
  renderHistory();
  renderGrades(items);
  renderQuality(items);
  renderDevelopers(items);
  renderDeals(items);
  renderConnections(items);
}

function bind() {
  for (const id of ["af-region", "af-district", "af-kind", "af-stage", "af-grade"]) $(id).addEventListener("change", render);
  $("af-reset").addEventListener("click", () => {
    for (const id of ["af-region", "af-district", "af-kind", "af-stage", "af-grade"]) $(id).value = "";
    render();
  });
  $("cn-view").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-view]");
    if (!b) return;
    app.cnView = b.dataset.view;
    $("cn-view").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    renderConnections(filtered());
  });
  $("cn-search").addEventListener("change", (e) => {
    const q = e.target.value.trim().toLowerCase();
    if (!q) return;
    const hit = app.connections?.nodes.find((n) => n.label.toLowerCase() === q)
      || app.connections?.nodes.find((n) => n.label.toLowerCase().includes(q));
    if (!hit) return;
    selectCn(hit.id);
    app.cnGraph?.camera?.focus(app.cnGraph.nodes?.find((n) => n.id === hit.id));
  });
  for (const id of ["cn-scope", "cn-focus", "cn-family"]) {
    $(id).addEventListener("change", () => {
      if (id === "cn-focus") app.cnSelected = $("cn-focus").value || null;
      renderConnections(filtered());
    });
  }
  $("af-currency").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-cur]");
    if (!b) return;
    state.currency = b.dataset.cur;
    $("af-currency").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    render();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (app.cnExpanded) expandConnections(false);
    else if (app.cnSelected) selectCn(null);
  });
  // The layout is computed for the width it is drawn at, so a resized window needs a redraw.
  let resizing;
  window.addEventListener("resize", () => {
    clearTimeout(resizing);
    resizing = setTimeout(() => render(), 250);
  });
}

async function main() {
  // The data needs no dictionary, so it downloads while the translations load.
  const data = loadData();
  data.catch(() => {});  // awaited below; this only keeps an early failure from being reported as unhandled
  await initI18n();
  try {
    const { meta, projects } = await data;
    app.meta = meta;
    app.projects = projects;
    state.rate = meta.amd_per_usd || state.rate;
    $("an-meta").textContent = t("analytics.meta", { projects: t("common.projects", { n: projects.length }), date: meta.generated, rate: meta.amd_per_usd });
    bind();
    render();
    enhanceLongSelects();
    loadConnections();
    loadHistoryCard();
  } catch (err) {
    console.error(err);
    $("an-meta").textContent = t("common.load_failed", { error: err.message });
  }
}

main();

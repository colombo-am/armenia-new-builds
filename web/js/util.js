import { t, tv, lang } from "./i18n.js";

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escape a value for safe interpolation into HTML text or attributes. */
export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

/** Allow only http(s)/mailto/tel URLs; everything else becomes "#". */
export function safeUrl(u) {
  if (typeof u !== "string") return "#";
  const s = u.trim();
  return /^(https?:|mailto:|tel:)/i.test(s) ? s : "#";
}

export const state = { currency: "USD", rate: 385 };

/**
 * Format a price given both USD and AMD values in the current display currency.
 * @param {number|null} usd
 * @param {number|null} amd
 * @param {string} [suffix]
 * @returns {string} e.g. "$1,250/m²" or "—"
 */
export function money(usd, amd, suffix = "") {
  const v = state.currency === "USD" ? usd : amd;
  if (v == null) return "-";
  const n = Math.round(v).toLocaleString("en-US");
  return (state.currency === "USD" ? `$${n}` : `֏${n}`) + suffix;
}

export function compactMoney(usd, amd) {
  const v = state.currency === "USD" ? usd : amd;
  if (v == null) return "-";
  const sym = state.currency === "USD" ? "$" : "֏";
  if (v >= 1e6) return `${sym}${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M`;
  if (v >= 1e3) return `${sym}${Math.round(v / 1e3)}k`;
  return `${sym}${Math.round(v)}`;
}

export function quarter(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return t("common.quarter", { q: Math.floor(d.getUTCMonth() / 3) + 1, y: d.getUTCFullYear() });
}

const STAGES = new Set(["finished", "in progress", "just started", "not started", "stalled"]);

/** Human label for a construction stage; appends "(est.)" when inferred from the completion date alone. */
export function stageLabel(p) {
  return `${STAGES.has(p.stage) ? t(`stage.${p.stage}`) : t("stage.unknown_full")}${p.stage_estimated ? t("stage.est") : ""}`;
}

/** Project name in the reader's language: the Armenian title when there is one and the UI is Armenian. */
export function displayTitle(p) {
  return (lang === "am" && p.title_am) || p.title;
}

/** District and region of a project, translated and without repeats ("Kentron, Yerevan"). */
export function placeText(...parts) {
  return [...new Set(parts.filter(Boolean))].map((v) => tv("district", v)).join(", ");
}

const FLAGS = [
  [/^(\d+) lawsuit\(s\) by individuals$/, "lawsuits"],
  [/^(\d+) negative news item\(s\)$/, "negative_news"],
  [/^bankruptcy case\(s\) as debtor: (\d+)$/, "bankruptcy"],
  [/^(\d+) project\(s\) past completion date$/, "overdue"],
  [/^(\d+) stalled project\(s\)$/, "stalled"],
];

/** A developer's legal flag ("3 lawsuit(s) by individuals") in the reader's language; unknown flags pass through. */
export function flagText(flag) {
  for (const [re, key] of FLAGS) {
    const m = String(flag).match(re);
    if (m) return t(`flag.${key}`, { n: Number(m[1]) });
  }
  return flag;
}

export function debounce(fn, ms = 150) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/** Deterministic, well-spread categorical color for an index (golden-angle hue walk). */
export function colorFor(i) {
  const hue = (i * 137.508 + 12) % 360;
  const light = [48, 40, 56][i % 3];
  return `hsl(${hue.toFixed(1)}, 78%, ${light}%)`;
}

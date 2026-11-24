/**
 * Marks for external links, from web/data/link_status.json (written by scraper/audit_links.py).
 *
 * Every link the pages show was opened by the audit, first by a script and then in a real browser.
 * Links are never hidden — a source is still where a figure came from — but a reader is told when a
 * page is gone, has changed, or could not be verified (a captcha, a login wall, a site that refuses
 * automated checks). A link the audit has not seen yet counts as not verified.
 */
import { t } from "./i18n.js";
import { safeUrl } from "./util.js";

/** Links we build ourselves from coordinates or search terms: nothing to verify. */
const GENERATED = /^https:\/\/(?:www\.)?(?:google\.com\/(?:maps|search)|yandex\.com\/maps)/;
const STATUSES = new Set(["unverified", "changed", "gone"]);  // their symbols live in styles.css

let statuses = null;  // null when the file could not be loaded: then nothing is marked

/** Load the status file; failures only disable the marks. */
export async function loadLinkStatus(url = "data/link_status.json") {
  try {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    statuses = (await res.json()).links || {};
  } catch (err) {
    console.warn("Link status unavailable; links are shown unmarked", err);
    statuses = null;
  }
}

/**
 * What the audit found for one URL.
 * @param {string} url
 * @returns {{status: "unverified"|"changed"|"gone", reason: string, checked: string}|null} null when verified or unknown
 */
export function linkState(url) {
  if (!statuses || typeof url !== "string" || !/^https?:/i.test(url) || GENERATED.test(url)) return null;
  const s = statuses[url];
  if (s === "ok") return null;
  if (!s) return { status: "unverified", reason: "unchecked", checked: "" };
  const [status, reason, ...rest] = s.split(":");
  const checked = rest.join(":");
  return STATUSES.has(status) ? { status, reason, checked } : null;
}

/**
 * Class and tooltip for a link, ready for a template.
 * @param {string} url
 * @returns {{cls: string, title: string}} empty strings for a verified link
 * @example `<a class="src ${m.cls}" title="${esc(m.title)}">`
 */
export function linkMark(url) {
  const st = linkState(url);
  if (!st) return { cls: "", title: "" };
  const why = t(`links.reason_${st.reason}`);
  const when = st.checked ? t("links.checked", { date: st.checked }) : "";
  return { cls: `lk-${st.status}`, title: `${t(`links.${st.status}`, { why })}${when}` };
}

/** Apply the mark to an anchor built with the DOM; pass the URL as stored (a.href is normalised). */
export function markAnchor(a, url) {
  const m = linkMark(url);
  if (!m.cls) return a;
  a.classList.add(m.cls);
  a.title = a.title ? `${a.title} - ${m.title}` : m.title;
  return a;
}

/**
 * An external link element (new tab) carrying its audit mark.
 * @param {string} text
 * @param {string} url
 * @param {{cls?: string, title?: string}} [opts] class and tooltip; the mark's explanation is appended
 */
export function extAnchor(text, url, { cls = "", title = "" } = {}) {
  const a = document.createElement("a");
  a.href = safeUrl(url);
  a.textContent = text;
  a.target = "_blank";
  a.rel = "noopener";
  if (cls) a.className = cls;
  if (title) a.title = title;
  return markAnchor(a, url);
}

/** One-line key to the marks, added under a block that shows at least one marked link. */
export function appendLinkLegend(container) {
  if (!container?.querySelector(".lk-unverified, .lk-changed, .lk-gone") || container.querySelector(":scope > .lk-legend")) return;
  const p = document.createElement("p");
  p.className = "lk-legend muted small";
  p.textContent = t("links.legend");
  container.append(p);
}

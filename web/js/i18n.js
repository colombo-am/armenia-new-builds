/**
 * UI translations. Armenian is the default; the reader's choice is remembered per browser and can be
 * forced with ?lang=en|am. Dictionaries live in web/i18n/<lang>.json as nested objects; a key missing
 * from the active language falls back to English, then to the key itself so a gap is visible, not blank.
 *
 * Static markup is translated through attributes:
 *   data-i18n="key"            → textContent
 *   data-i18n-html="key"       → innerHTML (only for our own dictionary strings that carry markup)
 *   data-i18n-attr="title:key; placeholder:key; aria-label:key"
 */
const LANGS = { am: { tag: "hy" }, en: { tag: "en" } };
const DEFAULT_LANG = "am";
const STORE_KEY = "nb-lang";

let dict = {};
let fallback = {};

function storedLang() {
  try { return localStorage.getItem(STORE_KEY); } catch { return null; }
}

function chooseLang() {
  const asked = new URLSearchParams(location.search).get("lang");
  return [asked, storedLang()].find((l) => l && l in LANGS) || DEFAULT_LANG;
}

/**
 * Active language code: "am" or "en". Decided when the module loads — it needs no dictionary — so data
 * and the map can start loading while the dictionaries are still on their way.
 */
export let lang = chooseLang();

/** BCP 47 tag of the active language, for Intl and the Google APIs. */
export const langTag = () => LANGS[lang].tag;

let plural = new Intl.PluralRules(langTag());

/** Compare two strings in the reader's alphabet; one shared Intl.Collator, cheap enough for sorts. */
export let compareText = new Intl.Collator(langTag()).compare;

async function loadDict(code) {
  const res = await fetch(`i18n/${code}.json`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`i18n/${code}.json: HTTP ${res.status}`);
  return res.json();
}

const lookup = (obj, key) => key.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

/**
 * Translate a key.
 * @param {string} key dotted path, e.g. "filters.stage"
 * @param {Record<string, string|number>} [vars] values for {placeholders}; `n` also picks the plural form
 * @returns {string}
 * @example t("common.projects", { n: 3 }) // "3 նախագիծ" / "3 projects"
 */
export function t(key, vars = {}) {
  let s = lookup(dict, key) ?? lookup(fallback, key);
  if (s && typeof s === "object") s = s[plural.select(Number(vars.n) || 0)] ?? s.other;
  if (typeof s !== "string") return key;
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

/**
 * Translate a data value from a fixed vocabulary (region, stage, kind, …), keeping unknown values as-is.
 * @param {string} group vocabulary name under "vocab" in the dictionary
 * @param {string|null|undefined} value raw value from the dataset
 * @returns {string}
 */
export function tv(group, value) {
  if (value == null || value === "") return "";
  const s = lookup(dict, `vocab.${group}`)?.[value] ?? lookup(fallback, `vocab.${group}`)?.[value];
  return typeof s === "string" ? s : String(value);
}

/** Apply the dictionary to the page's static markup. */
function translateDom() {
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll("[data-i18n-html]")) el.innerHTML = t(el.dataset.i18nHtml);
  for (const el of document.querySelectorAll("[data-i18n-attr]")) {
    for (const pair of el.dataset.i18nAttr.split(";")) {
      const [attr, key] = pair.split(":").map((x) => x.trim());
      if (attr && key) el.setAttribute(attr, t(key));
    }
  }
}

/**
 * Store the choice and reload: the map, charts and Google's own labels are all built once for a
 * language (the Maps API cannot switch language after it has loaded), so a reload is the honest switch.
 */
function switchTo(code) {
  try { localStorage.setItem(STORE_KEY, code); } catch { /* private mode: the ?lang= parameter still works */ }
  const url = new URL(location.href);
  if (!url.searchParams.has("lang")) return location.reload();
  // Replacing only the fragment would not reload the page, but dropping ?lang= changes the URL itself.
  url.searchParams.delete("lang");
  location.replace(url);
}

function bindSwitchers() {
  const other = lang === "am" ? "en" : "am";
  for (const btn of document.querySelectorAll("[data-lang-switch]")) {
    btn.querySelector(".lang-code").textContent = t(`lang.short_${other}`);
    btn.title = t(`lang.switch_to_${other}`);
    btn.setAttribute("aria-label", btn.title);
    btn.setAttribute("lang", LANGS[other].tag);
    btn.addEventListener("click", () => switchTo(other));
  }
}

/** Load the dictionaries, translate the page and wire the language switch. Call before rendering. */
export async function initI18n() {
  try {
    const [active, english] = await Promise.all([loadDict(lang), lang === "en" ? null : loadDict("en")]);
    dict = active;
    fallback = english || active;
  } catch (err) {
    console.error("Translations failed to load; showing the page in English", err);
    lang = "en";
    try { dict = fallback = await loadDict("en"); } catch { dict = fallback = {}; }
    plural = new Intl.PluralRules("en");
    compareText = new Intl.Collator("en").compare;
  }
  document.documentElement.lang = langTag();
  translateDom();
  bindSwitchers();
  document.documentElement.classList.remove("i18n-pending");
}

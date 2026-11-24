/**
 * Dataset history (data/history.json, written by scraper/history.py): one compact snapshot of every
 * project per dataset date, used by the analytics page's "over time" charts.
 */

/** Same threshold as the build's change report (scraper/pipeline.py PRICE_JUMP). */
export const PRICE_JUMP = 0.1;

/**
 * Load the history file and expand each row into an object keyed like a project.
 * @returns {Promise<{date: string, origin: string, rate: number, renamed: Object<string,string>, rows: object[]}[]>}
 */
export async function loadHistory(url = "data/history.json") {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Failed to load ${url}: HTTP ${res.status}`);
  const { fields, snapshots } = await res.json();
  if (!Array.isArray(fields) || !Array.isArray(snapshots)) throw new Error(`${url} is not a history file`);
  return snapshots.map((s) => ({
    date: s.date,
    origin: s.origin,
    rate: s.amd_per_usd,
    renamed: s.renamed || {},
    rows: s.rows.map((r) => Object.fromEntries(fields.map((f, i) => [f, r[i]]))),
  }));
}

/**
 * What changed between two snapshots, following merged ids through `cur.renamed`.
 * @param {{rows: object[]}} prev rows of the earlier snapshot (already filtered)
 * @param {{rows: object[], renamed: Object<string,string>}} cur rows of the later snapshot (already filtered)
 * @returns {{added: number, removed: number, merged: number, price: number, stage: number}}
 * @example changes({rows: [{id: "a", usd_m2_min: 1000}]}, {rows: [{id: "a", usd_m2_min: 1200}], renamed: {}}).price // 1
 */
export function changes(prev, cur) {
  const byId = new Map(cur.rows.map((r) => [r.id, r]));
  const matched = new Set();
  const out = { added: 0, removed: 0, merged: 0, price: 0, stage: 0 };
  for (const p of prev.rows) {
    const id = byId.has(p.id) ? p.id : cur.renamed[p.id];
    const c = id && byId.get(id);
    if (!c) { out.removed++; continue; }
    if (id !== p.id) out.merged++;
    if (matched.has(id)) continue;
    matched.add(id);
    if (p.usd_m2_min && c.usd_m2_min && Math.abs(c.usd_m2_min / p.usd_m2_min - 1) >= PRICE_JUMP) out.price++;
    if ((p.stage || "unknown") !== (c.stage || "unknown")) out.stage++;
  }
  out.added = cur.rows.filter((r) => !matched.has(r.id)).length;
  return out;
}

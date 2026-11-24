/**
 * Force-directed node-link graph for the connections card, in plain SVG.
 *
 * Marks follow the page's dataviz spec: identity is shape + colour (never colour alone), bankruptcy
 * is a reserved status colour drawn as a ring plus a glyph, links are 1–2px hairlines, every mark
 * has a hover tooltip and keyboard focus. The layout is a small velocity-Verlet simulation
 * (repulsion + springs + centring), run for a fixed number of ticks before the first paint.
 */
import { t } from "./i18n.js";

const NS = "http://www.w3.org/2000/svg";
const tip = () => document.getElementById("an-tip");

// Labels are functions so they read the dictionary at render time, after i18n has loaded.
const TYPE = {
  developer: { color: "var(--viz-s1)", shape: "square", label: () => t("cn.type_developer") },
  company: { color: "var(--viz-s3)", shape: "circle", label: () => t("cn.type_company") },
  person: { color: "var(--viz-s2)", shape: "diamond", label: () => t("cn.type_person") },
};
export const BANKRUPTCY = {
  declared: { label: () => t("cn.bank_declared"), color: "var(--high)", dash: null },
  self_declared: { label: () => t("cn.bank_self_declared"), color: "var(--high)", dash: "3 2" },
  case: { label: () => t("cn.bank_case"), color: "var(--ok)", dash: "3 2" },
};
const EDGE = {
  entity: { color: "var(--viz-s1)", width: 2, dash: null, label: () => t("cn.edge_entity") },
  founder: { color: "var(--viz-s2)", width: 1.5, dash: null, label: () => t("cn.edge_founder") },
  director: { color: "var(--viz-s2)", width: 1.5, dash: "4 3", label: () => t("cn.edge_director") },
  address: { color: "var(--viz-muted)", width: 1, dash: "2 3", label: () => t("cn.edge_address") },
  family: { color: "var(--viz-s5)", width: 1.5, dash: null, label: () => t("cn.edge_family") },
  family_lead: { color: "var(--viz-s5)", width: 1, dash: "1 4", label: () => t("cn.edge_family_lead") },
  same_person: { color: "var(--viz-s5)", width: 1, dash: "1 4", label: () => t("cn.edge_same_person") },
};

/** What an edge says, in the reader's language: its kind, with the owner's share or the entity match when known. */
export function edgeText(e) {
  if (e.kind === "founder") {
    const share = /%$/.test(e.label || "") ? e.label : "";
    if (e.current === false) return t("cn.rel_former_owner", { share: share ? ` · ${share}` : "", until: (e.until || "").slice(0, 4) || "?" });
    const owner = share ? t("cn.rel_owner_share", { share }) : EDGE.founder.label();
    return e.unconfirmed ? `${owner} · ${t("cn.rel_unconfirmed")}` : owner;
  }
  if (e.kind === "entity") return t(e.match === "tax_id" ? "cn.rel_entity_tax" : "cn.rel_entity_name");
  return EDGE[e.kind]?.label() || e.kind;
}

/** A source the graph builder generated carries a kind, so its title can be given in the reader's language. */
export const sourceTitle = (s) => (s.kind ? t(`cn.src_${s.kind}`, { name: s.of || "" }) : s.title);

/**
 * Adjacency of a (filtered) connections view.
 * @param {{nodes: object[], edges: object[]}} data
 * @returns {{byId: Map<string, object>, adj: Map<string, [string, object][]>}}
 */
export function graphIndex(data) {
  const byId = new Map(data.nodes.map((n) => [n.id, n]));
  const adj = new Map(data.nodes.map((n) => [n.id, []]));
  for (const e of data.edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue;
    adj.get(e.source).push([e.target, e]);
    adj.get(e.target).push([e.source, e]);
  }
  return { byId, adj };
}

/**
 * Shortest chain from a developer to every other developer it can reach, breadth-first.
 * @returns {{target: object, steps: {node: object, edge: object}[]}[]} steps run from the root outwards
 */
export function developerChains(root, { byId, adj }) {
  const prev = new Map([[root.id, null]]);
  const queue = [root.id];
  const found = [];
  while (queue.length) {
    const cur = queue.shift();
    for (const [next, e] of adj.get(cur) || []) {
      if (prev.has(next)) continue;
      prev.set(next, [cur, e]);
      queue.push(next);
      if (byId.get(next).type === "developer") found.push(next);
    }
  }
  return found.map((id) => {
    const steps = [];
    for (let cur = id; prev.get(cur); cur = prev.get(cur)[0]) steps.unshift({ node: byId.get(cur), edge: prev.get(cur)[1] });
    return { target: byId.get(id), steps };
  });
}

/** The strongest link a chain passes through: "owner", "address", "developer" or "company". */
export function chainKind(steps) {
  const via = steps.slice(0, -1).map((s) => s.node);
  if (via.some((n) => n.type === "person")) return "owner";
  if (steps.some((s) => s.edge.kind === "address")) return "address";
  if (via.some((n) => n.type === "developer")) return "developer";
  return "company";
}
/** Edges that are a lead to check rather than a registry fact; hidden unless the reader asks for them. */
export const SUGGESTED = new Set(["family_lead", "same_person"]);

function el(name, attrs = {}, parent) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) if (v != null) node.setAttribute(k, v);
  if (parent) parent.append(node);
  return node;
}

export const radiusOf = (n) => (n.type === "developer" ? Math.min(17, 7 + Math.sqrt(n.projects || 1) * 2.2) : n.type === "company" ? 7 : 5.5);

function shapePath(node, r) {
  const { x, y } = node;
  if (TYPE[node.type]?.shape === "square") {
    const k = r * 0.92;
    return `M${x - k + 3},${y - k}h${2 * k - 6}a3,3 0 0 1 3,3v${2 * k - 6}a3,3 0 0 1 -3,3h${-2 * k + 6}a3,3 0 0 1 -3,-3v${-2 * k + 6}a3,3 0 0 1 3,-3z`;
  }
  if (TYPE[node.type]?.shape === "diamond") {
    const k = r * 1.25;
    return `M${x},${y - k}L${x + k},${y}L${x},${y + k}L${x - k},${y}z`;
  }
  return `M${x - r},${y}a${r},${r} 0 1 0 ${2 * r},0a${r},${r} 0 1 0 ${-2 * r},0z`;
}

/** Deterministic start positions: a spiral, so the same data always lays out the same way. */
function seed(nodes, w, h) {
  nodes.forEach((n, i) => {
    const a = i * 2.399963;
    const rad = Math.sqrt(i + 1) * Math.min(w, h) / (2 * Math.sqrt(nodes.length + 1));
    n.x = w / 2 + Math.cos(a) * rad;
    n.y = h / 2 + Math.sin(a) * rad;
    n.vx = n.vy = 0;
  });
}

function simulate(nodes, links, w, h, ticks) {
  const n = nodes.length;
  if (!n) return;
  ticks ||= n > 260 ? 140 : 320;  // the pairwise step is O(n²): fewer passes once a cluster is large
  const index = new Map(nodes.map((d, i) => [d.id, i]));
  const pairs = links.map((l) => [index.get(l.source), index.get(l.target)]).filter(([a, b]) => a != null && b != null);
  const deg = new Array(n).fill(0);
  for (const [a, b] of pairs) { deg[a]++; deg[b]++; }
  const repel = 1500;
  const cutoff = 260 ** 2;  // beyond this, repulsion only flings hub nodes out of their own cluster
  const linkLen = 62;
  for (let t = 0; t < ticks; t++) {
    const alpha = 0.12 * (1 - t / ticks) + 0.005;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = nodes[j].x - nodes[i].x;
        let dy = nodes[j].y - nodes[i].y;
        let d2 = dx * dx + dy * dy;
        if (d2 > cutoff) continue;
        if (d2 < 1e-4) { dx = (i % 7) - 3.5; dy = (j % 5) - 2.5; d2 = dx * dx + dy * dy; }
        const d = Math.sqrt(d2);
        const f = Math.min(repel / d2, 40) * alpha;
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        nodes[i].vx -= fx; nodes[i].vy -= fy;
        nodes[j].vx += fx; nodes[j].vy += fy;
      }
    }
    for (const [a, b] of pairs) {
      const dx = nodes[b].x - nodes[a].x;
      const dy = nodes[b].y - nodes[a].y;
      const d = Math.hypot(dx, dy) || 0.01;
      const want = linkLen + Math.min(26, (deg[a] + deg[b]) * 1.6);
      // a hub is held by many springs at once, so each one pulls a little less
      const f = ((d - want) / d) * 0.22 * alpha * 10;
      nodes[a].vx += (dx * f) / Math.sqrt(deg[a]);
      nodes[a].vy += (dy * f) / Math.sqrt(deg[a]);
      nodes[b].vx -= (dx * f) / Math.sqrt(deg[b]);
      nodes[b].vy -= (dy * f) / Math.sqrt(deg[b]);
    }
    for (const d of nodes) {
      d.vx += (w / 2 - d.x) * 0.012 * alpha * 10;
      d.vy += (h / 2 - d.y) * 0.016 * alpha * 10;
      d.x += (d.vx *= 0.82);
      d.y += (d.vy *= 0.82);
    }
  }
  relax(nodes, n > 260 ? 20 : 60);
}

/** Push overlapping marks apart so no node hides another. */
function relax(nodes, rounds = 60) {
  for (let t = 0; t < rounds; t++) {
    let moved = false;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        const min = radiusOf(a) + radiusOf(b) + 9;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 0.01;
        if (d >= min) continue;
        const push = (min - d) / 2;
        a.x -= (dx / d) * push; a.y -= (dy / d) * push;
        b.x += (dx / d) * push; b.y += (dy / d) * push;
        moved = true;
      }
    }
    if (!moved) break;
  }
}

const bbox = (nodes) => ({
  x0: Math.min(...nodes.map((n) => n.x)), x1: Math.max(...nodes.map((n) => n.x)),
  y0: Math.min(...nodes.map((n) => n.y)), y1: Math.max(...nodes.map((n) => n.y)),
});

const TREE_ORDER = { entity: 0, founder: 1, director: 1, address: 2 };
const TREE_DX = 30;  // horizontal slot per leaf
const TREE_DY = 64;  // gap between levels

/**
 * A cluster as a tidy tree: developers on top, then their companies, the owners of those companies and
 * the owners' other companies, one row per step. Every node hangs under the node that reached it first
 * (breadth-first from all developers at once), leaves take one slot each and a parent sits centred over
 * its children. Links that join two branches — what ties developers together — are still drawn.
 * @returns {Set<object>} the links that form the tree, so the others can be drawn lighter
 */
function treeLayout(group, inner) {
  const { byId, adj } = graphIndex({ nodes: group, edges: inner });
  const roots = group.filter((n) => n.type === "developer").sort((a, b) => a.label.localeCompare(b.label));
  if (!roots.length) roots.push([...group].sort((a, b) => adj.get(b.id).length - adj.get(a.id).length)[0]);
  const children = new Map(group.map((n) => [n.id, []]));
  const depth = new Map(roots.map((r) => [r.id, 0]));
  const treeLinks = new Set();
  const queue = roots.map((r) => r.id);
  while (queue.length) {
    const cur = queue.shift();
    const next = adj.get(cur)
      .filter(([id]) => !depth.has(id))
      .sort((a, b) => (TREE_ORDER[a[1].kind] ?? 3) - (TREE_ORDER[b[1].kind] ?? 3) || byId.get(a[0]).label.localeCompare(byId.get(b[0]).label));
    for (const [id, link] of next) {
      if (depth.has(id)) continue;
      depth.set(id, depth.get(cur) + 1);
      children.get(cur).push(id);
      treeLinks.add(link);
      queue.push(id);
    }
  }
  let slot = 0;
  const place = (id) => {
    const kids = children.get(id);
    const n = byId.get(id);
    n.y = depth.get(id) * TREE_DY;
    if (!kids.length) {
      n.x = slot++ * TREE_DX;
      return;
    }
    kids.forEach(place);
    n.x = (byId.get(kids[0]).x + byId.get(kids[kids.length - 1]).x) / 2;
  };
  for (const r of roots) {
    place(r.id);
    slot += 1;  // a gap between neighbouring developers' trees
  }
  for (const n of group) {  // anything no developer reaches (should not happen in a filtered view)
    if (!depth.has(n.id)) { n.x = slot++ * TREE_DX; n.y = 0; }
  }
  return treeLinks;
}

/**
 * Lay each cluster out on its own, then shelf-pack the clusters into the frame. Simulating everything in
 * one field would let the big cluster's repulsion push the small ones off the canvas.
 * @param {"network"|"tree"} mode  force-directed network, or one tidy tree per cluster
 * @returns {Set<object>|null} in tree mode, the links that form the trees
 */
function layout(nodes, links, w, h, mode = "network") {
  const groups = new Map();
  for (const n of nodes) {
    const key = n.component ?? 0;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(n);
  }
  const boxes = [];
  const treeLinks = mode === "tree" ? new Set() : null;
  for (const group of groups.values()) {
    const ids = new Set(group.map((n) => n.id));
    const inner = links.filter((l) => ids.has(l.source) && ids.has(l.target));
    if (treeLinks) {
      for (const l of treeLayout(group, inner)) treeLinks.add(l);
    } else {
      const side = Math.max(140, 92 * Math.sqrt(group.length));
      seed(group, side, side);
      simulate(group, inner, side, side);
    }
    const b = bbox(group);
    for (const n of group) { n.x -= b.x0; n.y -= b.y0; }
    boxes.push({ group, w: b.x1 - b.x0 + 40, h: b.y1 - b.y0 + 40 });
  }
  boxes.sort((a, b) => b.h * b.w - a.h * a.w);
  const width = Math.max(...boxes.map((b) => b.w), Math.sqrt(boxes.reduce((s, b) => s + b.w * b.h, 0) * (w / h)));
  let [x, y, rowH] = [0, 0, 0];
  for (const box of boxes) {
    if (x && x + box.w > width) { x = 0; y += rowH + 24; rowH = 0; }
    for (const n of box.group) { n.x += x + 20; n.y += y + 20; }
    x += box.w + 24;
    rowH = Math.max(rowH, box.h);
  }
  return treeLinks;
}

function showTip(node, lines, e) {
  const t = tip();
  t.replaceChildren();
  const [value, label, note] = lines;
  const b = document.createElement("b"); b.textContent = value; t.append(b);
  if (label) { const s = document.createElement("span"); s.textContent = label; t.append(s); }
  if (note) { const m = document.createElement("em"); m.textContent = note; t.append(m); }
  t.hidden = false;
  const box = node.getBoundingClientRect();
  const x = e?.clientX ?? box.left + box.width / 2;
  const y = e?.clientY ?? box.top;
  t.style.left = `${Math.min(window.innerWidth - t.offsetWidth - 8, Math.max(8, x + 12))}px`;
  t.style.top = `${Math.max(8, y - t.offsetHeight - 12)}px`;
}
const hideTip = () => { tip().hidden = true; };

/**
 * Draw the graph into `host`.
 * @param {HTMLElement} host
 * @param {{nodes: object[], edges: object[]}} data  already filtered to what should be drawn
 * @param {{onSelect?: (node: object|null) => void, selected?: string, height?: number}} opts
 */
export function drawGraph(host, data, opts = {}) {
  const w = Math.max(320, host.clientWidth || 900);
  const h = opts.height || Math.max(440, Math.min(820, 330 + data.nodes.length * 6));
  host.replaceChildren();
  const svg = el("svg", { viewBox: `0 0 ${w} ${h}`, class: "graph", role: "img",
    "aria-label": t("cn.graph_aria", { nodes: data.nodes.length, edges: data.edges.length }) }, host);
  if (!data.nodes.length) {
    const empty = el("text", { x: w / 2, y: h / 2, "text-anchor": "middle", class: "empty" }, svg);
    empty.textContent = t("cn.none");
    return { select() {} };
  }
  const nodes = data.nodes.map((n) => ({ ...n }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const links = data.edges.filter((e) => byId.has(e.source) && byId.has(e.target));
  const treeLinks = layout(nodes, links, w, h, opts.layout);

  // keep everything inside the frame
  const pad = 34;
  const { x0, x1, y0, y1 } = bbox(nodes);
  // Positions carry no units, so x and y may be stretched separately to use the frame — but only up to
  // 2:1, past which a cluster starts to read as a line.
  let kx = Math.min((w - 2 * pad) / Math.max(1, x1 - x0), 2.6);
  let ky = Math.min((h - 2 * pad) / Math.max(1, y1 - y0), 2.6);
  kx = Math.min(kx, ky * 2);
  ky = Math.min(ky, kx * 2);
  if (treeLinks) kx = ky = Math.min(kx, ky);  // a tree keeps its proportions: rows stay rows
  for (const n of nodes) {
    n.x = pad + (n.x - x0) * kx + (w - 2 * pad - (x1 - x0) * kx) / 2;
    n.y = pad + (n.y - y0) * ky + (h - 2 * pad - (y1 - y0) * ky) / 2;
  }
  if (!treeLinks) relax(nodes, nodes.length > 260 ? 12 : 30);

  const view = el("g", {}, svg);
  const linkLayer = el("g", { class: "links" }, view);
  const nodeLayer = el("g", { class: "nodes" }, view);
  const labelLayer = el("g", { class: "labels" }, view);

  const neighbours = new Map(nodes.map((n) => [n.id, new Set()]));
  const lineOf = new Map();
  const baseOpacity = new Map();  // line → its resting opacity
  for (const e of links) {
    const a = byId.get(e.source);
    const b = byId.get(e.target);
    neighbours.get(a.id).add(b.id);
    neighbours.get(b.id).add(a.id);
    const spec = EDGE[e.kind] || EDGE.address;
    // in a tree, a link that joins two branches is context, not structure: drawn lighter
    const base = treeLinks && !treeLinks.has(e) ? 0.22 : e.current === false ? 0.35 : 0.55;
    const line = el("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: spec.color, "stroke-width": spec.width,
      "stroke-dasharray": e.current === false || e.unconfirmed ? "2 3" : spec.dash, "stroke-linecap": "round", class: "link", opacity: base }, linkLayer);
    baseOpacity.set(line, base);
    lineOf.set(e, line);
    const hit = el("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: "transparent", "stroke-width": 10, class: "hit" }, linkLayer);
    hit.addEventListener("pointermove", (ev) => showTip(hit, [`${a.label} - ${b.label}`, edgeText(e), e.detail || ""], ev));
    hit.addEventListener("pointerleave", hideTip);
  }

  const marks = new Map();
  for (const n of nodes) {
    const r = radiusOf(n);
    const g = el("g", { class: "node", tabindex: 0, role: "button", "aria-label": `${n.label}, ${TYPE[n.type]?.label() || n.type}` }, nodeLayer);
    const bank = n.bankruptcy && BANKRUPTCY[n.bankruptcy.status];
    if (bank) {
      el("path", { d: shapePath(n, r + 4.5), fill: "none", stroke: bank.color, "stroke-width": 2, "stroke-dasharray": bank.dash }, g);
    }
    el("path", { d: shapePath(n, r), fill: TYPE[n.type]?.color || "var(--viz-unknown)", stroke: "var(--viz-surface)",
      "stroke-width": 2, opacity: n.status === "inactive" ? 0.45 : 1 }, g);
    if (bank) {
      const glyph = el("text", { x: n.x + r + 6, y: n.y - r - 2, class: "g-flag", fill: bank.color }, g);
      glyph.textContent = "!";
    }
    marks.set(n.id, g);
    const facts = [
      n.type === "developer" ? `${t("cn.fact_projects", { n: n.projects })}${n.grade ? ` · ${t("cn.fact_rating", { grade: n.grade })}` : ""}` : null,
      n.type === "company" ? [n.tax_id && t("cn.fact_tax", { id: n.tax_id }), n.status === "inactive" ? t("cn.fact_inactive") : null].filter(Boolean).join(" · ") : null,
      n.type === "person" ? t("cn.fact_companies", { n: n.companies }) : null,
    ].filter(Boolean).join(" · ");
    const note = bank ? bank.label() : n.address || "";
    const show = (ev) => showTip(g, [n.label, facts, note], ev);
    g.addEventListener("pointermove", show);
    g.addEventListener("focus", () => show());
    g.addEventListener("pointerleave", hideTip);
    g.addEventListener("blur", hideTip);
    const pick = () => opts.onSelect?.(n);
    g.addEventListener("click", pick);
    g.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); pick(); } });

  }

  // Labels are laid out greedily — developers first, then flagged companies, then the rest — and each is
  // skipped when its box would cover one already placed. They are placed again whenever the view moves:
  // text keeps its size on screen while zooming spreads the nodes, so a closer view has room for more
  // names, and only nodes in view are considered.
  const labels = new Map();
  const rank = (n) => (n.type === "developer" ? 0 : n.bankruptcy ? 1 : 2);
  const ordered = [...nodes].sort((a, b) => rank(a) - rank(b));
  function placeLabels(zoom = 1, tx = 0, ty = 0) {
    labelLayer.replaceChildren();
    labels.clear();
    const boxes = [];
    const fits = (x, y, wide, tall) => !boxes.some((b) => Math.abs(b.x - x) * 2 < b.w + wide && Math.abs(b.y - y) * 2 < b.h + tall);
    const s = Math.max(1, zoom);  // base units per screen pixel shrink as the view zooms in
    const [vx0, vx1, vy0, vy1] = [-tx / zoom, (w - tx) / zoom, -ty / zoom, (h - ty) / zoom];
    const everyone = nodes.length <= 80 || zoom >= 1.4;
    for (const n of ordered) {
      const bank = n.bankruptcy && BANKRUPTCY[n.bankruptcy.status];
      if (!(n.type === "developer" || bank || everyone)) continue;
      if (n.x < vx0 || n.x > vx1 || n.y < vy0 || n.y > vy1) continue;
      const max = zoom >= 2 ? 40 : n.type === "developer" ? 26 : 20;
      const value = n.label.length > max ? `${n.label.slice(0, max - 1)}…` : n.label;
      const r = radiusOf(n);
      const wide = (value.length * 6.4 + 6) / s;
      const tall = 14 / s;
      // keep the text inside the view: hug its edge instead of spilling out
      const anchor = n.x - wide / 2 < vx0 + 4 / s ? "start" : n.x + wide / 2 > vx1 - 4 / s ? "end" : "middle";
      const x = anchor === "start" ? Math.max(vx0 + 4 / s, n.x - r) : anchor === "end" ? Math.min(vx1 - 4 / s, n.x + r) : n.x;
      const centre = anchor === "start" ? x + wide / 2 : anchor === "end" ? x - wide / 2 : x;
      const y = [n.y + r + 11 / s, n.y - r - 5 / s, n.y + r + 24 / s, n.y - r - 18 / s].find((cy) => fits(centre, cy, wide, tall));
      if (y == null) continue;
      boxes.push({ x: centre, y, w: wide, h: tall });
      const label = el("text", { x, y, "text-anchor": anchor,
        class: `g-label${bank ? " flagged" : ""}${n.type === "developer" ? " dev" : ""}` }, labelLayer);
      label.textContent = value;
      labels.set(n.id, label);
    }
    markLabels(shown);
  }

  /** Dim the labels away from `id` and its neighbours; all of them lit when nothing is selected. */
  function markLabels(id) {
    const near = id ? new Set([id, ...(neighbours.get(id) || [])]) : null;
    for (const [nid, label] of labels) {
      label.classList.toggle("dim", Boolean(near) && !near.has(nid));
      label.classList.toggle("on", Boolean(near) && near.has(nid));
    }
  }

  /** Highlight a node and its neighbours; `soft` is a hover preview that a real selection outranks. */
  let shown = null;  // the highlighted node, so re-placed labels keep its dimming
  function highlight(id, soft = false) {
    shown = id;
    const near = id ? new Set([id, ...(neighbours.get(id) || [])]) : null;
    for (const [nid, g] of marks) {
      g.classList.toggle("dim", Boolean(near) && !near.has(nid));
      g.classList.toggle("on", Boolean(near) && nid === id);
    }
    markLabels(id);
    for (const [e, line] of lineOf) {
      const on = !near || (near.has(e.source) && near.has(e.target));
      line.setAttribute("opacity", on ? (near ? 0.95 : baseOpacity.get(line)) : soft ? 0.18 : 0.1);
    }
  }
  let selected = opts.selected || null;
  const select = (id) => { selected = id; highlight(id); };
  if (selected) highlight(selected);
  for (const [id, g] of marks) {
    g.addEventListener("pointerenter", () => { if (!selected) highlight(id, true); });
    g.addEventListener("pointerleave", () => { if (!selected) highlight(null); });
  }
  svg.addEventListener("click", (ev) => { if (ev.target === svg) opts.onSelect?.(null); });

  let relabel = 0;
  const camera = attachCamera(svg, view, labelLayer, { w, h }, (zoom, tx, ty) => {
    clearTimeout(relabel);  // once the view settles, not on every frame of a drag
    relabel = setTimeout(() => placeLabels(zoom, tx, ty), 120);
  });
  placeLabels();
  host.append(toolbar(camera, opts));
  const byNode = new Map(nodes.map((n) => [n.id, n]));
  for (const [id, g] of marks) {
    g.addEventListener("dblclick", (ev) => { ev.stopPropagation(); camera.focus(byNode.get(id)); });
  }
  svg.addEventListener("dblclick", (ev) => { if (ev.target === svg) camera.fit(); });

  return { select, nodes, camera };
}

/** On-canvas controls: zoom, fit, and the card's expand toggle when the page offers one. */
function toolbar(camera, opts) {
  const bar = document.createElement("div");
  bar.className = "g-tools";
  const add = (label, title, run) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.title = title;
    b.setAttribute("aria-label", title);
    b.addEventListener("click", run);
    bar.append(b);
    return b;
  };
  add("+", t("cn.zoom_in"), () => camera.by(1.35));
  add("−", t("cn.zoom_out"), () => camera.by(1 / 1.35));
  add(t("cn.fit"), t("cn.fit_title"), () => camera.fit());
  if (opts.onLayout) {
    const tree = opts.layout === "tree";
    add(t(tree ? "cn.layout_network" : "cn.layout_tree"), t(tree ? "cn.layout_network_title" : "cn.layout_tree_title"),
      () => opts.onLayout(tree ? "network" : "tree"));
  }
  if (opts.onExpand) add(t(opts.expanded ? "cn.close" : "cn.expand"), t(opts.expanded ? "cn.leave_full" : "cn.full_screen"), opts.onExpand);
  const hint = document.createElement("p");
  hint.className = "g-hint";
  hint.textContent = t("cn.hint");
  const frag = document.createDocumentFragment();
  frag.append(bar, hint);
  return frag;
}

/**
 * Pan and zoom for a drawn graph: drag to pan, ⌘/Ctrl+wheel or pinch to zoom, buttons for the rest.
 *
 * A plain wheel is left to the page — a graph that swallows the scroll makes the page feel broken.
 * Labels are counter-scaled so text keeps its size while the drawing grows.
 */
function attachCamera(svg, view, labelLayer, { w, h, min = 0.4, max = 6 } = {}, onView = () => {}) {
  let zoom = 1;
  let [tx, ty] = [0, 0];
  const clamp = (z) => Math.min(max, Math.max(min, z));
  const apply = (smooth = false, notify = true) => {
    view.classList.toggle("smooth", smooth);
    view.setAttribute("transform", `translate(${tx} ${ty}) scale(${zoom})`);
    labelLayer.style.fontSize = `${11 / Math.max(1, zoom)}px`;
    svg.dataset.zoom = zoom.toFixed(2);
    if (notify) onView(zoom, tx, ty);
  };
  const at = (ev) => {
    const rect = svg.getBoundingClientRect();
    return [((ev.clientX - rect.left) / rect.width) * w, ((ev.clientY - rect.top) / rect.height) * h];
  };
  const zoomAt = (next, px, py, smooth = false) => {
    next = clamp(next);
    tx = px - ((px - tx) / zoom) * next;
    ty = py - ((py - ty) / zoom) * next;
    zoom = next;
    apply(smooth);
  };
  const api = {
    get zoom() { return zoom; },
    by: (factor) => zoomAt(zoom * factor, w / 2, h / 2, true),
    fit: () => { zoom = 1; tx = ty = 0; apply(true); },
    focus: (node, to = 2.2) => {
      if (!node) return;
      zoom = clamp(to);
      tx = w / 2 - node.x * zoom;
      ty = h / 2 - node.y * zoom;
      apply(true);
    },
  };

  svg.addEventListener("wheel", (ev) => {
    if (!ev.ctrlKey && !ev.metaKey) return;  // plain wheel scrolls the page
    ev.preventDefault();
    const [px, py] = at(ev);
    zoomAt(zoom * (ev.deltaY < 0 ? 1.12 : 1 / 1.12), px, py);
  }, { passive: false });

  let drag = null;
  const pinch = new Map();
  svg.addEventListener("pointerdown", (ev) => {
    pinch.set(ev.pointerId, ev);
    if (ev.target.closest(".node") || pinch.size > 1) return;
    drag = { x: ev.clientX, y: ev.clientY, tx, ty };
    svg.setPointerCapture(ev.pointerId);
    svg.classList.add("grabbing");
  });
  svg.addEventListener("pointermove", (ev) => {
    if (pinch.size > 1) {
      const prev = [...pinch.values()];
      pinch.set(ev.pointerId, ev);
      const now = [...pinch.values()].slice(0, 2);
      const gap = (pts) => Math.hypot(pts[0].clientX - pts[1].clientX, pts[0].clientY - pts[1].clientY);
      const before = gap(prev.slice(0, 2));
      if (before > 0) {
        const mid = { clientX: (now[0].clientX + now[1].clientX) / 2, clientY: (now[0].clientY + now[1].clientY) / 2 };
        const [px, py] = at(mid);
        zoomAt(zoom * (gap(now) / before), px, py);
      }
      return;
    }
    if (!drag) return;
    const rect = svg.getBoundingClientRect();
    tx = drag.tx + ((ev.clientX - drag.x) / rect.width) * w;
    ty = drag.ty + ((ev.clientY - drag.y) / rect.height) * h;
    apply();
  });
  const endDrag = (ev) => { pinch.delete(ev.pointerId); drag = null; svg.classList.remove("grabbing"); };
  svg.addEventListener("pointerup", endDrag);
  svg.addEventListener("pointercancel", endDrag);
  apply(false, false);  // the caller places the first labels itself
  return api;
}

export const typeInfo = TYPE;
export const edgeInfo = EDGE;

/**
 * Tree view of the connections data: one collapsible card per developer, plain HTML.
 *
 * Each card answers the reader's two questions in order. First, which other developers this one is
 * linked to and through whom: the shortest chain to each, spelled out in words and as a clickable
 * path. Second, what stands behind it: its registered companies, the people who own them, and what
 * else those people hold. That second part stops at three levels; anything further away is already
 * covered by a chain in the first part, so the reader never has to follow an unlabelled nesting.
 */
import { BANKRUPTCY, typeInfo, edgeText, graphIndex, developerChains, chainKind, sourceTitle } from "./graph.js";
import { t } from "./i18n.js";
import { extAnchor, appendLinkLegend } from "./links.js";

const CHILD_LIMIT = 40;
const LEADS = new Set(["family_lead", "same_person", "family"]);
const ENTITY = new Set(["entity"]);
const HOLDS = new Set(["founder", "director"]);
const ADDRESS = new Set(["address"]);
/** Which nodes of a chain name its reason: the shared owner, the companies at one address, … */
const REASON_TYPE = { owner: "person", address: "company", developer: "developer", company: "company" };

const el = (name, cls, parent) => {
  const node = document.createElement(name);
  if (cls) node.className = cls;
  if (parent) parent.append(node);
  return node;
};

function typeMark(node) {
  const i = el("i", `cn-mark cn-mark-${node.type}`);
  i.style.background = typeInfo[node.type]?.color || "var(--viz-unknown)";
  i.title = typeInfo[node.type]?.label() || node.type;
  return i;
}

/** What this edge says about the child, in a few words. */
function relation(edge) {
  if (edge.kind === "family") return `${t("cn.rel_family", { label: edge.label })}${edge.detail ? ` · ${edge.detail}` : ""}`;
  return edgeText(edge);
}

function facts(node) {
  if (node.type === "developer") {
    return [t("cn.fact_projects", { n: node.projects }), node.grade && t("cn.fact_rating", { grade: node.grade })].filter(Boolean).join(" · ");
  }
  if (node.type === "company") {
    return [node.tax_id && t("cn.fact_tax", { id: node.tax_id }), node.status === "inactive" ? t("cn.fact_inactive") : null,
      node.registered && t("cn.fact_registered", { y: node.registered.slice(0, 4) }), node.address].filter(Boolean).join(" · ");
  }
  return t("cn.fact_companies", { n: node.companies });
}

/** One plain-language reason for a chain: the strongest kind of link it passes through, and through whom. */
function chainReason(steps) {
  const kind = chainKind(steps);
  const via = steps.slice(0, -1).map((s) => s.node).filter((n) => n.type === REASON_TYPE[kind]);
  return t(`cn.tree_via_${kind}`, { names: [...new Set(via.map((n) => n.label))].join(", ") });
}

/**
 * Render the tree.
 * @param {HTMLElement} host
 * @param {{nodes: object[], edges: object[]}} data  the same filtered view the graph gets
 * @param {{onSelect?: (node: object) => void, selected?: string}} opts
 * @returns {{select: (id: string|null) => void}}
 */
export function drawTree(host, data, opts = {}) {
  host.replaceChildren();
  if (!data.nodes.length) {
    el("p", "cn-empty", host).textContent = t("cn.none");
    return { select() {} };
  }
  const index = graphIndex(data);
  const { byId, adj } = index;
  const roots = data.nodes.filter((n) => n.type === "developer")
    .sort((a, b) => (b.component_developers - a.component_developers) || (b.projects - a.projects) || a.label.localeCompare(b.label));
  const flaggedGroups = new Set(data.nodes.filter((n) => n.bankruptcy).map((n) => n.component));

  const rows = new Map();  // node id -> every row that shows it, for select()
  let activeCard = null;   // the card the reader last clicked in: select() stays inside it when it can
  const addRow = (id, row) => { if (!rows.has(id)) rows.set(id, []); rows.get(id).push(row); };
  const pick = (node) => opts.onSelect?.(node);
  const nameButton = (node, parent, cls = "cn-name") => {
    const b = el("button", cls, parent);
    b.type = "button";
    b.textContent = node.label;
    b.addEventListener("click", () => pick(node));
    return b;
  };

  const tools = el("div", "cn-tree-tools", host);
  el("span", null, tools).textContent = t("cn.tree_hint");
  const toggles = el("span", "cn-tree-toggles", tools);
  const wrap = el("div", "cn-tree", host);
  wrap.addEventListener("pointerdown", (e) => { activeCard = e.target.closest(".cn-branch"); });
  for (const [key, open] of [["cn.tree_expand_all", true], ["cn.tree_collapse_all", false]]) {
    const b = el("button", "link", toggles);
    b.type = "button";
    b.textContent = t(key);
    b.addEventListener("click", () => wrap.querySelectorAll(".cn-branch").forEach((d) => { d.open = open; }));
  }

  /** A row for one node: mark, name, what links it to its parent, badges and source; facts underneath. */
  function nodeRow(node, edge, list) {
    const li = el("li", `cn-item${edge && LEADS.has(edge.kind) ? " cn-lead" : ""}`, list);
    const row = el("div", "cn-row", li);
    row.append(typeMark(node));
    nameButton(node, row);
    if (edge) el("span", "cn-rel", row).textContent = relation(edge);
    const bank = node.bankruptcy && BANKRUPTCY[node.bankruptcy.status];
    if (bank) el("span", `cn-status ${node.bankruptcy.status}`, row).textContent = bank.label();
    const source = (node.sources || []).find((s) => (s.url || "").startsWith("http"));
    if (edge?.evidence) row.append(extAnchor(t("common.evidence"), edge.evidence, { cls: "cn-src" }));
    if (source) row.append(extAnchor(t("common.source"), source.url, { cls: "cn-src", title: sourceTitle(source) }));
    const f = facts(node);
    if (f) el("div", "cn-sub", li).textContent = f;
    addRow(node.id, row);
    return li;
  }

  /** Links from a company to the developers it belongs to, other than the card's own developer. */
  function developerChips(company, root, li) {
    const devs = (company.developers || []).map((id) => byId.get(id)).filter((d) => d && d.id !== root.id);
    if (!devs.length) return;
    const line = li.querySelector(".cn-row");
    for (const d of devs) {
      const chip = nameButton(d, line, "cn-devchip");
      chip.textContent = `→ ${d.label}`;
      chip.title = t("cn.tree_open_dev");
    }
  }

  function childList(parent, items, render) {
    if (!items.length) return;
    const list = el("ul", "cn-list", parent);
    for (const item of items.slice(0, CHILD_LIMIT)) render(item, list);
    if (items.length > CHILD_LIMIT) el("li", "cn-item cn-more", list).textContent = t("cn.more", { n: items.length - CHILD_LIMIT });
  }

  const neighbours = (id, kinds, except) => (adj.get(id) || [])
    .filter(([other, e]) => kinds.has(e.kind) && other !== except)
    .map(([other, e]) => ({ node: byId.get(other), edge: e }))
    .sort((a, b) => Boolean(b.node.bankruptcy) - Boolean(a.node.bankruptcy) || a.node.label.localeCompare(b.node.label));

  function linkedSection(root, body) {
    const section = el("section", "cn-section", body);
    el("h4", null, section).textContent = t("cn.tree_linked");
    const chains = developerChains(root, index).sort((a, b) => a.steps.length - b.steps.length || a.target.label.localeCompare(b.target.label));
    if (!chains.length) {
      el("p", "cn-empty", section).textContent = t("cn.tree_no_links");
      return;
    }
    childList(section, chains, ({ target, steps }, list) => {
      const li = el("li", "cn-item cn-chain", list);
      const row = el("div", "cn-row", li);
      row.append(typeMark(target));
      nameButton(target, row, "cn-name cn-dev");
      el("span", "cn-rel", row).textContent = chainReason(steps);
      if (steps.some((s) => s.node.bankruptcy)) el("span", "cn-status declared", row).textContent = t("cn.tree_bankrupt_chain");
      const path = el("div", "cn-sub cn-path", li);
      path.append(document.createTextNode(`${root.label} → `));
      steps.forEach(({ node }, i) => {
        if (i) path.append(document.createTextNode(" → "));
        nameButton(node, path, `cn-step${node.bankruptcy ? " flagged" : ""}`);
      });
    });
  }

  function companiesSection(root, body) {
    const section = el("section", "cn-section", body);
    el("h4", null, section).textContent = t("cn.tree_companies");
    const companies = neighbours(root.id, ENTITY);
    if (!companies.length) {
      el("p", "cn-empty", section).textContent = t("cn.tree_no_companies");
      return;
    }
    childList(section, companies, ({ node: company, edge }, list) => {
      const li = nodeRow(company, edge, list);
      const below = [...neighbours(company.id, HOLDS), ...neighbours(company.id, ADDRESS)];
      childList(li, below, ({ node: child, edge: e }, sub) => {
        const cli = nodeRow(child, e, sub);
        if (child.type === "company") return developerChips(child, root, cli);
        const held = [...neighbours(child.id, HOLDS, company.id), ...neighbours(child.id, LEADS)];
        childList(cli, held, ({ node: other, edge: oe }, leaf) => {
          const oli = nodeRow(other, oe, leaf);
          if (other.type === "company") developerChips(other, root, oli);
        });
      });
    });
  }

  for (const root of roots) {
    const details = el("details", "cn-branch", wrap);
    details.open = roots.length <= 3;
    const summary = el("summary", "cn-row cn-root", details);
    summary.append(typeMark(root));
    el("b", null, summary).textContent = root.label;
    el("span", "cn-meta", summary).textContent = facts(root);
    if (root.component_developers > 1) el("span", "cn-tag", summary).textContent = t("cn.linked_developers", { n: root.component_developers - 1 });
    if (flaggedGroups.has(root.component)) el("span", "cn-status declared", summary).textContent = t("cn.tree_bankrupt_group");
    summary.addEventListener("click", (e) => {
      // select() opens the branch it reveals; the native toggle would then undo it, so toggle here instead.
      e.preventDefault();
      const open = !details.open;
      pick(root);
      details.open = open;
    });
    addRow(root.id, summary);
    const body = el("div", "cn-card", details);
    linkedSection(root, body);
    companiesSection(root, body);
  }

  function select(id) {
    for (const [nid, list] of rows) for (const r of list) r.classList.toggle("on", nid === id);
    const list = rows.get(id);
    if (!list) return;
    // A developer's own card wins; otherwise the row in the card being read, then the first one shown.
    const row = list.find((r) => r.classList.contains("cn-root")) || list.find((r) => r.closest(".cn-branch") === activeCard) || list[0];
    row.closest("details").open = true;
    row.scrollIntoView({ block: "nearest" });
  }
  appendLinkLegend(host);
  if (opts.selected) select(opts.selected);
  return { select };
}

import { esc, money, compactMoney, quarter, stageLabel, displayTitle, placeText, flagText } from "./util.js";
import { t, tv } from "./i18n.js";

function dealBadge(p) {
  if (p.discount_pct == null) return "";
  if (Math.abs(p.discount_pct) < 1) return `<span class="badge ok" title="${esc(t("list.median_near_title"))}">${esc(t("list.median_near"))}</span>`;
  const cls = p.discount_pct >= 10 ? "good" : p.discount_pct > 0 ? "ok" : "high";
  const sign = p.discount_pct > 0 ? "−" : "+";
  const where = tv("district", p.bench_scope === "district" ? p.district : p.region);
  return `<span class="badge ${cls}" title="${esc(t("list.deal_title", { n: p.bench_n, where }))}">${esc(t("list.deal", { sign, pct: Math.abs(p.discount_pct), where }))}</span>`;
}

/** Developer reputation grade chip (A–E); "?" suffix when based on limited research data. */
export function gradeBadge(p) {
  const r = p.developer_rep;
  if (!r) return "";
  const warn = (r.flags || []).some((x) => /bankruptcy|criminal|lawsuit|negative news/.test(x));
  const title = `${t("list.grade_title", { score: r.score })}${r.data === "limited" ? t("list.grade_limited") : ""}${r.flags?.length ? ` - ${r.flags.map(flagText).join("; ")}` : ""}`;
  return ` <span class="grade grade-${esc(r.grade)}" title="${esc(title)}">${esc(r.grade)}${r.data === "limited" ? "?" : ""}${warn ? " ⚠" : ""}</span>`;
}

function itemHtml(p, selectedId) {
  const img = p.images?.[0];
  return `<li class="item${p.id === selectedId ? " selected" : ""}" data-id="${esc(p.id)}" role="option" tabindex="0" aria-selected="${p.id === selectedId}">
    <div class="thumb" style="--c:${p.color}">${img ? `<img loading="lazy" referrerpolicy="no-referrer" src="${esc(img)}" data-pid="${esc(p.id)}" data-try="0" alt="">` : ""}</div>
    <div class="body">
      <div class="title">${esc(displayTitle(p))}${p.sold_out ? ` <span class="badge high">${esc(t("list.sold_out"))}</span>` : ""}${p.unverified ? ` <span class="badge ok" title="${esc(t("details.unverified"))}">${esc(t("list.unverified"))}</span>` : ""}</div>
      <div class="sub"><span class="dot" style="background:${p.color}"></span>${esc(p.developer_group)}${gradeBadge(p)}</div>
      <div class="sub muted">${esc(placeText(p.district, p.region))} · <span class="stage stage-${esc((p.stage || "unknown").replace(" ", "-"))}">${esc(stageLabel(p))}</span>${p.stage !== "finished" && p.completion ? ` · ${esc(quarter(p.completion))}` : ""}</div>
      <div class="prices">
        <strong${p.price_confidence === "low" ? ` class="uncertain" title="${esc(t("list.price_uncertain"))}"` : ""}>${money(p.usd_m2_min, p.amd_m2_min, t("common.per_m2"))}${p.price_confidence === "low" ? "?" : ""}</strong>
        ${p.usd_from != null ? `<span class="muted">${esc(t("list.from", { price: compactMoney(p.usd_from, p.amd_from) }))}</span>` : ""}
        ${dealBadge(p)}
        <span class="info-meter" title="${esc(t("list.info_meter", { pct: p.info_score }))}"><i style="width:${p.info_score}%"></i></span>
      </div>
    </div>
  </li>`;
}

/**
 * Render the project list; clicking or pressing Enter on an item calls onSelect(id).
 * @param {HTMLElement} el
 * @param {object[]} projects
 * @param {string|null} selectedId
 * @param {(id: string) => void} onSelect
 */
export function renderList(el, projects, selectedId, onSelect) {
  el.innerHTML = projects.length
    ? projects.map((p) => itemHtml(p, selectedId)).join("")
    : `<li class="empty">${esc(t("list.empty"))}</li>`;
  el.querySelectorAll(".thumb img").forEach((img) => img.addEventListener("error", () => nextImage(img, projects)));
  el.onclick = (e) => {
    const li = e.target.closest(".item");
    if (li) onSelect(li.dataset.id);
  };
  el.onkeydown = (e) => {
    const li = e.target.closest(".item");
    if (li && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onSelect(li.dataset.id); }
  };
}

/** Try the project's next image when one fails (dead link / hotlink block); hide the <img> when none work. */
function nextImage(img, projects) {
  const p = projects.find((x) => x.id === img.dataset.pid);
  const i = Number(img.dataset.try) + 1;
  if (p && i < Math.min(p.images.length, 4)) {
    img.dataset.try = String(i);
    img.src = p.images[i];
  } else {
    img.remove();
  }
}

export function scrollToItem(el, id) {
  el.querySelector(`.item[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

export { dealBadge };

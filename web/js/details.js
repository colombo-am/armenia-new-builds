import { esc, safeUrl, money, compactMoney, quarter, state, stageLabel, displayTitle, placeText, flagText } from "./util.js";
import { t, tv, langTag } from "./i18n.js";
import { linkMark, linkState, appendLinkLegend } from "./links.js";
import { dealBadge } from "./list.js";

const DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

function youtubeId(url) {
  const m = String(url).match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : null;
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

/**
 * An external link carrying its audit mark (class and tooltip), opening in a new tab.
 * @param {string} url
 * @param {string} label already-escaped HTML
 * @param {{cls?: string, title?: string}} [opts] extra class and tooltip
 */
function extLink(url, label, { cls = "", title = "" } = {}) {
  const m = linkMark(url);
  const tip = [title, m.title].filter(Boolean).join(" - ");
  return `<a class="${[cls, m.cls].filter(Boolean).join(" ")}" href="${esc(safeUrl(url))}" target="_blank" rel="noopener"${tip ? ` title="${esc(tip)}"` : ""}>${label}</a>`;
}

function row(label, value) {
  return value ? `<div class="kv"><span>${esc(label)}</span><b>${value}</b></div>` : "";
}

function hoursText(wh) {
  if (!Array.isArray(wh) || !wh.length) return "";
  return wh.map((w) => {
    const days = (w.days || []).slice().sort((a, b) => DAYS.indexOf(a) - DAYS.indexOf(b));
    const day = (d) => tv("day", d);
    const span = days.length > 2 ? `${day(days[0])}–${day(days[days.length - 1])}` : days.map(day).join(", ");
    return `${span} ${w.startTime || ""}–${w.endTime || ""}`;
  }).map(esc).join("<br>");
}

function gallery(images) {
  if (!images?.length) return `<div class="hero empty">${esc(t("details.no_images"))}</div>`;
  return `<div class="hero"><img referrerpolicy="no-referrer" src="${esc(images[0])}" data-idx="0" alt=""></div>
    ${images.length > 1 ? `<div class="thumbs">${images.slice(1).map((src, i) => `<img loading="lazy" referrerpolicy="no-referrer" src="${esc(src)}" data-idx="${i + 1}" alt="">`).join("")}</div>` : ""}`;
}

function videos(list) {
  if (!list?.length) return "";
  return `<section><h3>${esc(t("details.videos"))}</h3>${list.map((u) => {
    const yt = youtubeId(u);
    // A video whose owner disabled embedding would show a dead player, so it is offered as a link instead.
    return yt && linkState(u)?.reason !== "noembed"
      ? `<div class="video"><iframe src="https://www.youtube-nocookie.com/embed/${yt}" title="${esc(t("details.video_title"))}" allowfullscreen loading="lazy"></iframe></div>`
      : extLink(u, esc(hostOf(u)));
  }).join("")}</section>`;
}

function links(p) {
  const items = [];
  const add = (label, url) => { if (url && safeUrl(url) !== "#") items.push(extLink(url, esc(label), { cls: "chip" })); };
  add(t("details.project_site"), p.website);
  if (p.developer_website && p.developer_website !== p.website) add(t("details.developer_site"), p.developer_website);
  for (const [k, v] of Object.entries(p.social || {})) add(k[0].toUpperCase() + k.slice(1), v);
  add(t("details.google_maps"), `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}&hl=${langTag()}`);
  add(t("details.street_level"), `https://yandex.com/maps/?ll=${p.lng},${p.lat}&z=17&l=stv,sta&panorama[point]=${p.lng},${p.lat}`);
  // A source is still where the data came from, so it is shown even when gone — marked by the link audit.
  for (const s of p.sources || []) add(t("details.source", { name: s.name }), s.url);
  return items.join("");
}

function roomTable(rows) {
  if (!rows?.length) return "";
  const label = (r) => (!r.rooms ? "-" : /^\d\+?$/.test(r.rooms) ? esc(t("details.rooms_n", { n: r.rooms })) : esc(tv("rooms", r.rooms)));
  const area = (r) => (r.area_min ? `${r.area_min}${r.area_max && r.area_max !== r.area_min ? `–${r.area_max}` : ""} ${t("common.m2")}` : "-");
  return `<section><h3>${esc(t("details.rooms_title"))}</h3><table class="ptable">
    <tr><th>${esc(t("details.rooms_type"))}</th><th>${esc(t("details.rooms_area"))}</th><th>${esc(t("details.rooms_from"))}</th><th>${esc(t("details.rooms_to"))}</th></tr>
    ${rows.map((r) => `<tr><td>${label(r)}</td><td>${area(r)}</td><td>${compactMoney(r.usd_from, r.amd_from)}</td><td>${compactMoney(r.usd_to, r.amd_to)}</td></tr>`).join("")}
  </table></section>`;
}

function floorTable(rows) {
  if (!rows?.length) return "";
  return `<section><h3>${esc(t("details.floor_title"))}</h3><table class="ptable">
    <tr><th>${esc(t("details.floor_floors"))}</th><th>${esc(t("details.floor_rooms"))}</th><th>${esc(t("details.floor_price"))}</th></tr>
    ${rows.map((r) => `<tr><td>${esc(r.floors || t("details.floor_all"))}</td><td>${esc(r.rooms ? tv("rooms", r.rooms) : t("details.floor_any"))}</td><td>${money(r.usd_m2, r.amd_m2)}</td></tr>`).join("")}
  </table></section>`;
}

function completeness(p) {
  if (p.info_score == null) return "";
  return `<div class="completeness"><div class="row between"><span>${esc(t("details.completeness"))}</span><b>${p.info_score}%</b></div>
    <div class="bar"><i style="width:${p.info_score}%"></i></div>
    <span class="muted">${esc(p.info_missing?.length ? t("details.missing", { list: p.info_missing.map((m) => tv("missing", m)).join(", ") }) : t("details.all_found"))}</span>
  </div>`;
}

const CONFIDENCE = { verified: "good", high: "good", medium: "ok", low: "high", rejected: "high" };

function confidenceBadge(p) {
  const c = CONFIDENCE[p.price_confidence];
  return c ? `<span class="badge ${c}" title="${esc(tv("confidence_title", p.price_confidence))}">${esc(t("details.price_badge", { level: tv("confidence", p.price_confidence) }))}</span>` : "";
}

function priceCheck(p) {
  const obs = p.price_obs || [];
  if (!obs.length && !p.price_verification) return "";
  const v = p.price_verification;
  return `<section><h3>${esc(t("details.price_check"))} ${confidenceBadge(p)}</h3>
    ${v ? `<p class="small">${esc(t("details.manual"))} <b>${esc(tv("verdict", v.verdict))}</b>${v.evidence_text ? ` - “${esc(v.evidence_text)}”` : ""}${v.evidence_url ? ` ${extLink(v.evidence_url, esc(t("common.source")))}` : ""}${v.notes ? `<br><span class="muted">${esc(v.notes)}</span>` : ""}</p>` : ""}
    ${obs.length ? `<table class="ptable"><tr><th>${esc(t("details.obs_source"))}</th><th>${esc(t("details.obs_figure"))}</th><th>${esc(t("details.obs_ppm"))}</th><th></th></tr>
      ${obs.map((o) => `<tr class="${o.used ? "" : "muted"}" title="${esc((o.flags || []).join("; "))}">
        <td>${esc(o.source)}${o.kind === "implied" ? ` <span class="small">${esc(t("details.implied"))}</span>` : ""}</td>
        <td class="small">${esc(o.raw || [o.usd && `$${Math.round(o.usd)}`, o.amd && `֏${Math.round(o.amd).toLocaleString("en-US")}`].filter(Boolean).join(" / "))}</td>
        <td>${o.usd_m2 ? `$${o.usd_m2.toLocaleString("en-US")}` : "-"}</td>
        <td>${o.used ? "✓" : (o.flags?.length ? "⚠" : "")}</td></tr>`).join("")}
    </table>` : ""}
  </section>`;
}


function reputation(p) {
  const r = p.developer_rep;
  if (!r) return "";
  const c = r.components || {};
  const res = r.research || {};
  const court = res.court || {};
  const bar = (label, val, max) => `<div class="repbar"><span>${label}</span><i><b style="width:${Math.round((val / max) * 100)}%"></b></i><em>${val}/${max}</em></div>`;
  return `<section><h3>${esc(t("details.rep_title"))} <span class="grade grade-${esc(r.grade)}">${esc(r.grade)} · ${r.score}/100</span></h3>
    ${r.data === "limited" ? `<p class="small muted">${esc(t("details.rep_limited"))}</p>` : ""}
    ${r.flags?.length ? `<p class="small uncertain">⚠ ${r.flags.map((f) => esc(flagText(f))).join(" · ")}</p>` : ""}
    ${bar(t("details.rep_track"), c.track_record, 30)}${bar(t("details.rep_delivery"), c.delivery, 20)}${bar(t("details.rep_legal"), c.legal, 30)}${bar(t("details.rep_validation"), c.validation, 10)}${bar(t("details.rep_transparency"), c.transparency, 10)}
    ${res.legal_entities?.length ? `<div class="kv"><span>${esc(t("details.legal_entity"))}</span><b>${res.legal_entities.map((e) => `${esc([e.name_hy, e.name_en].filter(Boolean).join(" / "))}${e.tax_id ? ` <span class="muted small">${esc(t("details.tax_id"))} ${esc(e.tax_id)}</span>` : ""}${e.registry_url ? ` ${extLink(e.registry_url, esc(t("common.registry")), { cls: "src" })}` : ""}${e.source_url && e.source_url !== e.registry_url ? ` ${extLink(e.source_url, esc(t("common.source")), { cls: "src" })}` : ""}`).join("<br>")}</b></div>` : ""}
    ${res.founded_year ? row(t("details.founded"), esc(res.founded_year)) : ""}
    ${court.total != null ? `<div class="kv"><span>${esc(t("details.court"))}</span><b>${esc(t("details.court_line", { total: court.total, respondent: court.respondent ?? 0, individuals: court.respondent_by_individuals ?? 0, claimant: court.claimant ?? 0 }))}${court.bankruptcy_as_debtor ? ` · <span class="uncertain">${esc(t("details.court_bankruptcy", { n: court.bankruptcy_as_debtor }))}</span>` : ""}${court.criminal ? ` · <span class="uncertain">${esc(t("details.court_criminal", { n: court.criminal }))}</span>` : ""} · ${esc(t("details.court_since", { n: court.since_2021 ?? 0 }))}</b></div>` : ""}
    ${res.notable_cases?.length ? `<ul class="cases">${res.notable_cases.map((k) => `<li>${extLink(k.url || "https://datalex.am/?app=AppCaseSearch", esc(k.case_number), { title: t(k.url ? "details.case_open" : "details.case_search") })} <span class="muted small">${esc(tv("tab", k.tab))} ${esc(k.filed || "")}</span> - ${esc(k.why || "")}</li>`).join("")}</ul>` : ""}
    ${res.news_issues?.length ? `<p class="small"><b>${esc(t("details.reported"))}</b></p><ul class="cases">${res.news_issues.map((n) => `<li>${extLink(n.url, esc(n.title || n.url))} <span class="muted small">${esc(n.date || "")}</span>${n.summary ? ` - ${esc(n.summary)}` : ""}</li>`).join("")}</ul>` : ""}
    ${res.positives?.length ? `<p class="small"><b>${esc(t("details.positives"))}</b> ${res.positives.map((n) => extLink(n.url, esc(n.title))).join(" · ")}</p>` : ""}
    ${res.verify_links?.length ? `<p class="small"><b>${esc(t("details.check_yourself"))}</b> ${res.verify_links.map((l) => extLink(l.url, esc(l.title), { title: l.note || "" })).join(" · ")}${res.searched_names?.length ? `<br><span class="muted">${esc(t("details.searched", { names: res.searched_names.join(", ") }))}</span>` : ""}</p>` : ""}
    ${res.notes ? `<p class="small muted">${esc(t("details.notes", { notes: res.notes }))}</p>` : ""}
  </section>`;
}


/**
 * Render the right-hand details panel for one project.
 * @param {HTMLElement} el
 * @param {object} p project
 * @param {(images:string[], idx:number)=>void} openLightbox
 * @param {(name:string)=>void} onDeveloper filter by developer
 */
export function renderDetails(el, p, openLightbox, onDeveloper) {
  const phones = (p.phones || []).map((tel) => `<a href="tel:${esc(tel.replace(/[^\d+]/g, ""))}">${esc(tel)}</a>`).join("<br>");
  const place = [p.address, placeText(p.district, p.region)].filter(Boolean).join(", ");
  const sections = ["overview", "prices", "developer", "location", "contacts"];
  const title = displayTitle(p);
  const altTitle = title === p.title ? p.title_am : p.title;
  const precision = p.geo_precision && p.geo_precision !== "exact" ? tv("geo_precision", p.geo_precision) : "";
  el.innerHTML = `
    ${gallery(p.images)}
    <div class="dpad">
      <header class="dhead">
        <h2>${esc(title)}</h2>
        ${altTitle && altTitle !== title ? `<div class="muted small" lang="${altTitle === p.title_am ? "hy" : "en"}">${esc(altTitle)}</div>` : ""}
        <button class="devline link" data-dev="${esc(p.developer_group)}" title="${esc(t("details.dev_title"))}"><span class="dot" style="background:${p.color}"></span>${!p.developer_inferred ? esc(p.developer_group)
          : p.developer_group.endsWith("(developer n/a)") ? esc(t("details.dev_not_listed"))
          : `${esc(p.developer_group)} <span class="muted small">&nbsp;${esc(t("details.dev_inferred"))}</span>`}${p.developer_rep ? ` <span class="grade grade-${esc(p.developer_rep.grade)}">${esc(p.developer_rep.grade)}</span>` : ""}</button>
        <div class="muted place">${esc(place)}</div>
        ${p.unverified ? `<p class="unverified-note">${esc(t("details.unverified"))}${p.unverified.reference ? ` ${extLink(p.unverified.reference, esc(t("details.unverified_ref")))}` : ""}</p>` : ""}
      </header>

      <div class="stats">
        <div><span>${esc(t("details.stat_ppm"))}</span><b class="num">${money(p.usd_m2_min, p.amd_m2_min)}${p.usd_m2_max && p.usd_m2_max !== p.usd_m2_min ? `–${money(p.usd_m2_max, p.amd_m2_max)}` : ""}</b></div>
        <div><span>${esc(t("details.stat_from"))}</span><b class="num">${compactMoney(p.usd_from, p.amd_from)}</b>${p.min_area_m2 ? `<small>${p.min_area_m2} ${t("common.m2")}</small>` : ""}</div>
        <div><span>${esc(t("details.stat_ready"))}</span><b>${esc(p.completion ? quarter(p.completion) : (tv("completion_text", p.completion_text) || "-"))}</b><small class="stage stage-${esc((p.stage || "unknown").replace(" ", "-"))}">${esc(stageLabel(p))}${p.sold_out ? esc(t("details.stat_sold")) : ""}</small></div>
      </div>
      ${p.discount_pct != null ? `<div class="bench">${dealBadge(p)} <span class="muted small">${esc(t("details.bench", { price: money(p.bench_usd_m2, p.bench_usd_m2 * state.rate, t("common.per_m2")), n: p.bench_n }))}</span></div>` : ""}

      <nav class="dnav" aria-label="${esc(t("details.sections"))}">${sections.map((id) => `<button type="button" data-sec="sec-${id}">${esc(t(`details.sec_${id}`))}</button>`).join("")}</nav>

      <div id="sec-overview" class="dsec">
        ${p.description || p.description_site || p.developer_about ? `<section><h3>${esc(t("details.about"))}</h3>
          ${p.description_site ? `<p class="sourcesdesc">${esc(p.description_site)}</p>` : ""}
          ${p.description ? `<p>${esc(p.description)}</p>` : ""}
          ${p.developer_about ? `<p class="muted">${esc(p.developer_about)}</p>` : ""}
        </section>` : ""}
        <section>
          <h3>${esc(t("details.details"))}</h3>
          ${row(t("details.kind"), esc(tv("kind", p.kind)))}
          ${row(t("details.floors"), esc(p.floors))}
          ${row(t("details.started"), esc(p.start))}
          ${row(t("details.progress"), p.progress_pct != null && p.stage !== "finished" ? esc(t("details.progress_value", { pct: p.progress_pct })) : "")}
          ${row(t("details.stage_check"), p.stage_check ? `${esc(p.stage_check.evidence || "")}${p.stage_check.imagery ? `<br><span class="muted small">${esc(t("details.satellite", { text: p.stage_check.imagery }))}</span>` : ""}${p.stage_check.evidence_url ? ` ${extLink(p.stage_check.evidence_url, esc(t("common.source")), { cls: "src" })}` : ""}` : "")}
          ${row(t("details.tax"), p.income_tax_refund ? esc(t("details.eligible")) : "")}
        </section>
        ${completeness(p)}
        ${videos(p.videos)}
      </div>

      <div id="sec-prices" class="dsec">
        ${roomTable(p.prices_by_rooms)}
        ${floorTable(p.prices_by_floor)}
        ${p.last_known_usd_m2 && !p.usd_m2_min ? `<section><h3>${esc(t("details.price"))}</h3><p class="small">${esc(t("details.no_current", { sold: p.sold_out ? t("details.no_current_sold") : "", price: money(p.last_known_usd_m2, p.last_known_amd_m2, t("common.per_m2")) }))}</p></section>` : ""}
        ${priceCheck(p)}
        ${row(t("details.price_updated"), esc(p.price_updated))}
        ${row(t("details.currency_raw"), esc(p.currency_raw))}
      </div>

      <div id="sec-developer" class="dsec">${reputation(p) || `<section><h3>${esc(t("details.rep_title"))}</h3><p class="muted small">${esc(t("details.rep_none"))}</p></section>`}</div>

      <div id="sec-location" class="dsec">
        <section><h3>${esc(t("details.location"))}</h3>
          ${row(t("details.address"), esc(place))}
          ${row(t("details.address_am"), esc(p.address_am))}
          ${row(t("details.coords"), `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}${precision ? ` <span class="muted small">(${esc(precision)})</span>` : ""}`)}
          ${row(t("details.location_check"), p.location_note ? `${esc(p.location_note)}${p.location_check?.evidence_url ? ` ${extLink(p.location_check.evidence_url, esc(t("common.source")), { cls: "src" })}` : ""}` : "")}
        </section>
        <section><h3>${esc(t("details.google_check"))}</h3><div id="gplace"></div></section>
      </div>

      <div id="sec-contacts" class="dsec">
        <section>
          <h3>${esc(t("details.contacts"))}${p.contacts_via_developer ? ` <span class="small muted">${esc(t("details.contacts_office"))}</span>` : ""}</h3>
          ${row(t("details.phone"), phones)}
          ${row(t("details.email"), p.email ? `<a href="mailto:${esc(p.email)}">${esc(p.email)}</a>` : "")}
          ${row(t("details.sales_office"), esc(p.sales_address))}
          ${row(t("details.hours"), hoursText(p.working_hours))}
          ${!phones && !p.email ? `<p class="muted small">${esc(t("details.no_contacts"))}</p>` : ""}
        </section>
        <section><h3>${esc(t("details.links"))}</h3><div class="chips">${links(p)}</div></section>
      </div>
    </div>`;

  const panel = el.closest(".sidebar") || el;
  el.querySelectorAll(".dnav button").forEach((b) => b.addEventListener("click", () => {
    const target = el.querySelector(`#${b.dataset.sec}`);
    const nav = el.querySelector(".dnav");
    el.dataset.navLock = String(Date.now() + 900);
    el.querySelectorAll(".dnav button").forEach((x) => x.classList.toggle("on", x === b));
    panel.scrollTo({ top: target.offsetTop - nav.offsetHeight - 8, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }));
  el.querySelectorAll("img[data-idx]").forEach((img) => {
    img.addEventListener("click", () => openLightbox(p.images, Number(img.dataset.idx)));
    img.addEventListener("error", () => img.remove(), { once: true });
  });
  el.querySelector(".devline")?.addEventListener("click", (e) => onDeveloper(e.currentTarget.dataset.dev));
  el.querySelectorAll(".dsec").forEach(appendLinkLegend);
  panel.scrollTop = 0;
  observeSections(el, panel);
}

/** Highlight the section tab for whatever part of the panel is in view. */
function observeSections(el, panel) {
  const tabs = new Map([...el.querySelectorAll(".dnav button")].map((b) => [b.dataset.sec, b]));
  const io = new IntersectionObserver((entries) => {
    if (Number(el.dataset.navLock || 0) > Date.now()) return; // a tab click is scrolling; keep its highlight
    for (const e of entries) {
      if (e.isIntersecting) tabs.forEach((b, id) => b.classList.toggle("on", id === e.target.id));
    }
  }, { root: panel, rootMargin: "-30% 0px -60% 0px" });
  el.querySelectorAll(".dsec").forEach((sec) => io.observe(sec));
}

/** Wire the full-screen image viewer; returns an open(images, idx) function. */
export function createLightbox(root) {
  const img = root.querySelector("img");
  let images = [];
  let idx = 0;
  const show = () => { img.src = images[idx]; };
  const step = (d) => { idx = (idx + d + images.length) % images.length; show(); };
  const close = () => { root.hidden = true; img.removeAttribute("src"); };
  root.querySelector(".close").onclick = close;
  root.querySelector(".prev").onclick = () => step(-1);
  root.querySelector(".next").onclick = () => step(1);
  root.addEventListener("click", (e) => { if (e.target === root) close(); });
  document.addEventListener("keydown", (e) => {
    if (root.hidden) return;
    if (e.key === "Escape") { e.preventDefault(); close(); }
    if (e.key === "ArrowLeft") step(-1);
    if (e.key === "ArrowRight") step(1);
  });
  return (list, start = 0) => {
    if (!list?.length) return;
    images = list;
    idx = Math.min(Math.max(start, 0), list.length - 1);
    root.hidden = false;
    show();
  };
}

"""Audit every link the map and analytics pages show, and publish a status per link for the UI.

Two passes share one cache, scraper/link_audit.json:

1. This script (standard library only) fetches each link like a browser would and judges it: does it
   answer, and is it the page it is cited for — the project named on a source page, the case number
   on a court page, the tax ID or name on a registry page, the article title on a news page. It also
   catches soft 404s (a deep link that lands on the home page or a "not found" page), parked domains
   and YouTube videos whose owner disabled embedding.
2. scraper/audit_links_browser.py re-opens everything this pass could not settle (JavaScript-only
   pages, sites that block scripts, pages that did not name what they are cited for) in headless
   Chrome and judges the rendered page instead.

`--export` (run by both passes at the end) writes web/data/link_status.json: one short status per
URL — ok, gone, changed or unverified, with a reason code — that both pages use to mark links.

Usage:
    python3 scraper/audit_links.py [--kinds source,website,social,video,evidence] [--only HOST]
                                   [--recheck] [--workers N]
    python3 scraper/audit_links.py --export
"""
from __future__ import annotations

import argparse
import json
import random
import re
import ssl
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import parse_qs, quote, urlsplit

import azdarar
import check_urls as cu
import eregister
import link_fixes
from datalex import case_index

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "scraper" / "link_audit.json"
STATUS = ROOT / "web" / "data" / "link_status.json"
CONNECTIONS_RAW, REGISTER, NOTICES = eregister.RAW, eregister.OUT, azdarar.OUT
LINK_KINDS = ("source", "website", "social", "video", "evidence")
KINDS = (*LINK_KINDS, "image")
YT = re.compile(r"(?:v=|youtu\.be/|embed/|shorts/|live/)([\w-]{11})")
PARKED = re.compile(r"domain (?:is|may be) for sale|buy this domain|this domain has expired|parked (?:free|domain)|"
                    r"sedoparking|hugedomains|dan\.com|account suspended|default web site page|welcome to nginx|"
                    r"it works!|index of /", re.I)
NOT_FOUND = re.compile(r"<title[^>]*>[^<]*(?:404|not found|page not found|не найден|չի գտնվել|էջը գոյություն չունի)[^<]*</title>", re.I)
HOME = r"/?(?:(?:hy|am|en|ru|arm|eng|rus)/?)?(?:home/?|index\.\w+)?"


def new_entry() -> dict:
    return {"kinds": set(), "projects": {}, "expect": set(), "who": set(), "soft": False}


def add(entries: dict, url, kind: str, project: dict | None = None, expect: list | None = None, who: str = "",
        soft: bool = False) -> None:
    """Register a URL under a kind, with the project(s) and strings the right page should carry.

    soft: the expected strings are our own paraphrase (an English title for an Armenian article), so a
    page that does not carry them is "not verified" rather than "changed".
    """
    if not isinstance(url, str) or not url.startswith("http") or "google.com/search" in url:
        return
    e = entries[url]
    e["kinds"].add(kind)
    e["soft"] = e["soft"] or soft
    if project:
        e["projects"][project["id"]] = project
    e["expect"].update(x for x in (expect or []) if x)
    if who:
        e["who"].add(who)


def collect_projects(entries: dict, projects: list[dict]) -> None:
    for p in projects:
        for url in [p.get("source_url"), *[s.get("url") for s in p.get("sources") or []]]:
            add(entries, url, "source", p)
        for f in ("website", "developer_website"):
            add(entries, p.get(f), "website", p)
        for v in (p.get("social") or {}).values():
            add(entries, v, "social", p)
        for v in p.get("videos") or []:
            add(entries, v, "video", p)
        for v in p.get("images") or []:
            add(entries, v, "image", p)
        for f in ("price_verification", "location_check", "stage_check"):
            add(entries, (p.get(f) or {}).get("evidence_url"), "evidence", p)
        collect_research(entries, p)


def collect_research(entries: dict, p: dict) -> None:
    r = (p.get("developer_rep") or {}).get("research") or {}
    who = p.get("developer_group") or ""
    names = [who, *[n for e in r.get("legal_entities") or [] for n in (e.get("name_hy"), e.get("name_en"))]]
    for e in r.get("legal_entities") or []:
        ids = [e.get("tax_id"), e.get("name_hy"), e.get("name_en")]
        add(entries, e.get("registry_url"), "evidence", expect=ids, who=who)
        add(entries, e.get("source_url"), "evidence", expect=ids, who=who)
    for k in r.get("notable_cases") or []:
        add(entries, k.get("url"), "evidence", expect=[k.get("case_number")], who=who)
    for group in ("news_issues", "positives"):
        for item in r.get(group) or []:
            add(entries, item.get("url"), "evidence", expect=[item.get("title"), *names], who=who, soft=True)
    for item in r.get("verify_links") or []:
        add(entries, item.get("url"), "evidence", who=who)


def collect_connections(entries: dict) -> None:
    if not cu.CONNECTIONS.exists():
        return
    graph = json.loads(cu.CONNECTIONS.read_text())
    for n in graph["nodes"]:
        label = n.get("label") or ""
        ids = [label, n.get("tax_id")]
        for src in n.get("sources") or []:
            add(entries, src.get("url"), "evidence", expect=ids, who=label)
        bank = n.get("bankruptcy") or {}
        for c in [*(n.get("cases") or []), *(bank.get("cases") or [])]:
            add(entries, c.get("url"), "evidence", expect=[c.get("case_number")], who=label)
        for src in bank.get("sources") or []:
            add(entries, src.get("url"), "evidence", expect=ids, who=label)
        add(entries, (bank.get("notice") or {}).get("url"), "evidence", expect=ids, who=label)
        add(entries, bank.get("confirmed_by"), "evidence", expect=ids, who=label)
    for e in graph["edges"]:
        add(entries, e.get("evidence"), "evidence", who=e.get("kind") or "")
    for src in (graph.get("meta") or {}).get("sources") or []:
        add(entries, src.get("url"), "evidence", who="meta")


def collect() -> dict:
    """Every URL either page shows, with what the right page for it should say."""
    entries: dict = defaultdict(new_entry)
    collect_projects(entries, json.loads(cu.PROJECTS.read_text())["projects"])
    collect_connections(entries)
    return entries


def landed_home(url: str, final: str) -> bool:
    """A deep link that redirected to the site root is a soft 404 — the reader sees the wrong page."""
    a, b = urlsplit(url), urlsplit(final)
    deep = not re.fullmatch(HOME, a.path or "/") or bool(a.query)
    return deep and bool(re.fullmatch(HOME, b.path or "/")) and not b.query


def expect_verdict(text: str, expect: set[str]) -> dict:
    """Does the page carry any of the identifiers (case no., tax id, title) it is cited for?"""
    flat = cu.squash(text)
    lower = text.lower()
    for x in expect:
        s = cu.squash(x)
        if len(s) >= 5 and s in flat:
            return {"content": "match", "matched_on": x}
        # a short name ("ԱՍՌ") would match inside any word, so it must stand as a word of its own
        if 2 <= len(s) < 5 and re.search(rf"(?<!\w){re.escape(x.strip().lower())}(?!\w)", lower):
            return {"content": "match", "matched_on": x}
    for x in expect:
        words = cu.tokens(x)
        if len(words) >= 2 and sum(w in flat for w in words) / len(words) >= 0.6:
            return {"content": "match", "matched_on": x}
    return {"content": "mismatch", "expected": sorted(expect)[:4]}


def judge_page(url: str, e: dict, html: str, final_url: str) -> dict:
    """Soft-404, parked and content checks on a page that answered. Shared with the browser pass."""
    res: dict = {}
    if landed_home(url, final_url):
        res["page"] = "redirected_home"
    elif NOT_FOUND.search(html[:20000]):
        res["page"] = "not_found_page"
    text = cu.body_text(html)
    if PARKED.search(text[:200000]) and len(text) < 20000:
        res["page"] = "parked_or_placeholder"
    by_project = e["projects"] and ({"source", "website"} & e["kinds"] or not e["expect"])
    if len(re.sub(r"\s+", "", text)) < 200:
        res["content"] = "js_rendered"
    elif by_project:
        res.update(cu.content_verdict(html, list(e["projects"].values()), url))
    elif e["expect"]:
        res.update(expect_verdict(text, e["expect"]))
        if res["content"] == "mismatch" and e["soft"]:
            res["content"] = "weak"
    return res


def youtube(url: str, ctx: ssl.SSLContext) -> dict:
    """The panel embeds YouTube in an iframe: oEmbed 200 means public and embeddable."""
    vid = YT.search(url)
    probe = f"https://www.youtube.com/oembed?format=json&url={quote('https://www.youtube.com/watch?v=' + vid.group(1), safe='')}"
    r = cu.fetch(probe, ctx)
    verdict = {200: "ok", 401: "not_embeddable", 403: "not_embeddable", 404: "missing", 400: "missing"}.get(r["status"], "error")
    return {"status": r["status"], "verdict": "unreachable" if r["status"] is None else verdict}


def audit(url: str, e: dict, ctx: ssl.SSLContext) -> dict:
    if "video" in e["kinds"] and YT.search(url) and ("youtube" in url or "youtu.be" in url):
        res = youtube(url, ctx)
    else:
        full = bool({"source", "website", "evidence", "social"} & e["kinds"])
        r = cu.fetch(url, ctx, cu.MAX_BODY if full else 4096)
        res = {"status": r["status"], "final_url": r["final_url"],
               "verdict": "dns" if r.get("dns") else cu.classify(r["status"], r.get("error"))}
        if r.get("error"):
            res["error"] = r["error"]
        if res["verdict"] == "ok":
            if e["kinds"] == {"image"}:
                # S3 buckets serve images as octet-stream and browsers still show them; an HTML page is not an image.
                if "html" in r.get("ctype", ""):
                    res["verdict"] = "not_image"
            else:
                res.update(judge_page(url, e, r.get("body", ""), r["final_url"]))
    res.update(kinds=sorted(e["kinds"]), projects=sorted(e["projects"])[:5], n_projects=len(e["projects"]),
               who=sorted(e["who"])[:3], checked=time.strftime("%Y-%m-%d"))
    return res


def run(args) -> None:
    entries = collect()
    kinds = set(args.kinds.split(","))
    # --recheck re-tests the selected URLs only; results for every other URL stay in the cache.
    cache = load_cache()
    skip = crawled_records()
    todo = [u for u, e in entries.items() if e["kinds"] & kinds and (not args.only or args.only in urlsplit(u).netloc)
            and (args.recheck or u not in cache) and u not in skip]
    random.Random(0).shuffle(todo)  # spread hosts across workers; each host is throttled to 1 req/s
    print(f"{len(entries)} distinct URLs shown; {len(todo)} to check "
          f"{dict(Counter(k for u in todo for k in entries[u]['kinds']))}", flush=True)
    ctx = ssl.create_default_context()
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for i, (url, res) in enumerate(zip(todo, pool.map(lambda u: audit(u, entries[u], ctx), todo)), 1):
            cache[url] = res
            if i % 200 == 0:
                print(f"  {i}/{len(todo)}", flush=True)
                save(cache)
    save(cache)
    export(entries, cache)


def load_cache() -> dict:
    return json.loads(CACHE.read_text()) if CACHE.exists() else {}


def save(cache: dict) -> None:
    CACHE.write_text(json.dumps(cache, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


SEARCH = re.compile(r"[?&](?:query|q|search|s)=", re.I)


def status_of(r: dict, url: str) -> tuple[str, str]:
    """Collapse one audit record (browser verdict first) into (ok|gone|changed|unverified, reason).

    A search page that lists results without visibly naming what it was searched for may still hold it
    in the full text behind a truncated excerpt, so that is "not verified", not "changed".
    """
    b = r.get("browser") or {}
    v = b.get("verdict") or r["verdict"]
    page, content = (b if b else r).get("page"), (b if b else r).get("content")
    if v in ("captcha", "login"):
        return "unverified", v
    if v in ("dns", "unreachable"):
        return "gone", v
    if v == "missing":
        return "gone", "404"
    if v == "not_embeddable":
        return "changed", "noembed"
    if v in ("blocked", "error"):
        return "unverified", "blocked" if v == "blocked" or r.get("status") in (400, 403, 429) else "error"
    if content == "noresults":
        return "changed", "noresults"
    if page == "parked_or_placeholder":
        return "gone", "parked"
    if page == "redirected_home":
        return "changed", "home"
    if page == "not_found_page":
        return "changed", "404"
    if content == "mismatch":
        return ("unverified", "weak") if SEARCH.search(url) else ("changed", "mismatch")
    if content == "weak":
        return "unverified", "weak"
    if content in ("js_rendered", "empty"):
        return "unverified", "js"
    return "ok", ""


def read_status() -> dict[str, tuple[str, str, str]]:
    """The published verdicts: url -> (status, reason, checked); a verified link is ("ok", "", "")."""
    if not STATUS.exists():
        return {}
    links = json.loads(STATUS.read_text(encoding="utf-8"))["links"]
    return {u: tuple((v.split(":", 2) + ["", ""])[:3]) for u, v in links.items()}


def court_index() -> dict[str, str]:
    """case_number -> case_id from every datalex search result we hold: the reputation research cache
    and the rows the connections crawl stored in connections_raw.json."""
    index = {num: str(hit["case_id"]) for num, hit in case_index().items()}
    raw = json.loads(CONNECTIONS_RAW.read_text(encoding="utf-8")) if CONNECTIONS_RAW.exists() else {}
    for rows in (raw.get("bankruptcy") or {}).values():
        for c in rows:
            if c.get("case_number") and c.get("case_id"):
                index.setdefault(c["case_number"], str(c["case_id"]))
    return index


def court_records(entries: dict) -> dict[str, bool]:
    """datalex case links checked against the court's own search results, without loading the site.

    datalex puts every case page behind a captcha, so a script or a browser only ever sees that. The
    links are built from the case_id in datalex's search results, so a link is right when that id
    belongs to the case number shown next to it. Readers still solve the captcha to open it.
    """
    index = court_index()
    out = {}
    for url, e in entries.items():
        case_id = parse_qs(urlsplit(url).query).get("case_id", [None])[0] if "datalex.am" in url else None
        if case_id and e["expect"]:
            out[url] = any(index.get(num) == case_id for num in e["expect"])
    return out


def crawled_records() -> set[str]:
    """Register and bulletin pages our own crawlers just read and parsed (scraper/eregister.py,
    scraper/azdarar.py): a company page and its owner declarations, and the notices that name a
    company. They were fetched and matched when the graph was built, so they need no second fetch."""
    urls: set[str] = set()
    if REGISTER.exists():
        for rec in json.loads(REGISTER.read_text(encoding="utf-8")).values():
            if rec.get("url"):
                urls.add(rec["url"])
            urls.update(d["url"] for d in rec.get("declarations") or [] if d.get("owners"))
    if NOTICES.exists():
        for rec in json.loads(NOTICES.read_text(encoding="utf-8")).values():
            urls.update(n["url"] for n in rec.get("notices") or [] if n.get("url"))
    return urls


def export(entries: dict | None = None, cache: dict | None = None) -> None:
    """Write web/data/link_status.json for the pages: every shown link, with its status."""
    entries = entries if entries is not None else collect()
    cache = cache if cache is not None else load_cache()
    links, counts = {}, Counter()
    court = court_records(entries)
    # checked by hand, or read and parsed by our own register and bulletin crawlers
    trusted = {u for u, fix in link_fixes.load().items() if fix.get("verified")} | crawled_records()
    for url, e in entries.items():
        if not e["kinds"] & set(LINK_KINDS):
            continue
        r = cache.get(url)
        if url in court:
            status, reason = ("ok", "") if court[url] else ("changed", "mismatch")
        elif url in trusted:
            status, reason = "ok", ""
        else:
            status, reason = status_of(r, url) if r else ("unverified", "unchecked")
        counts[status] += 1
        checked = ((r or {}).get("browser", {}).get("checked") or (r or {}).get("checked") or "")[:10]
        links[url] = "ok" if status == "ok" else f"{status}:{reason}:{checked}"
    STATUS.write_text(json.dumps({"generated": time.strftime("%Y-%m-%d"), "links": links},
                                 ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{STATUS.relative_to(ROOT)}: {len(links)} links {dict(counts)}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--kinds", default=",".join(LINK_KINDS), help=f"any of {','.join(KINDS)}")
    ap.add_argument("--only", help="limit to URLs on this host")
    ap.add_argument("--recheck", action="store_true", help="ignore the cache and test everything again")
    ap.add_argument("--workers", type=int, default=16)
    ap.add_argument("--export", action="store_true", help="only write web/data/link_status.json from the cache")
    args = ap.parse_args()
    if args.export:
        export()
    else:
        run(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

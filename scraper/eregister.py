"""The official state register (e-register.moj.am): company cards and beneficial-owner declarations.

karg.am, the mirror the connections crawl was built from, answers 403 to everyone since 2026-09-21.
The register itself publishes, per company, its current name, status, legal address and every
beneficial-owner declaration it filed; each declaration is a public page naming the owners and their
shares. Those pages are what makes an ownership link in the graph verifiable, so this module reads
them for every company in the graph and writes scraper/eregister.json.

Usage:
    python3 scraper/eregister.py crawl [--limit N] [--refresh]   # every tax ID in connections_raw.json
    python3 scraper/eregister.py company 00144692                  # one company, printed
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from textutil import html_text as _text

BASE = "https://e-register.moj.am"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"
HERE = Path(__file__).resolve().parent
CACHE_DIR = HERE / ".cache_eregister"
RAW = HERE / "connections_raw.json"
OUT = HERE / "eregister.json"
MIN_INTERVAL = 1.0
NO_LIQUIDATION = "տեղեկություններ գրառված չեն"  # "nothing recorded about liquidation or termination"
_last = 0.0


def search_url(tax_id: str) -> str:
    return f"{BASE}/hy/search/companies?query={tax_id}"


def _get(path: str, refresh: bool = False) -> str:
    """Fetch a register page (cached on disk, one request a second); "" when it cannot be read."""
    global _last
    CACHE_DIR.mkdir(exist_ok=True)
    cf = CACHE_DIR / (re.sub(r"[^\w.-]+", "_", path.strip("/"))[:180] + ".html")
    if cf.exists() and not refresh:
        return cf.read_text(encoding="utf-8")
    for attempt in range(3):
        wait = MIN_INTERVAL - (time.monotonic() - _last)
        if wait > 0:
            time.sleep(wait)
        _last = time.monotonic()
        try:
            req = urllib.request.Request(BASE + path, headers={"User-Agent": UA, "Accept-Language": "hy,en;q=0.8"})
            with urllib.request.urlopen(req, timeout=40) as r:
                page = r.read().decode("utf-8", "replace")
            cf.write_text(page, encoding="utf-8")
            return page
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return ""
        except Exception:  # noqa: BLE001 — timeouts and resets: retry, then give up on this page
            pass
        if attempt < 2:
            time.sleep(3 * (attempt + 1))
    return ""


def _detail(page: str, label: str) -> str | None:
    m = re.search(rf"<dt>\s*{re.escape(label)}\s*</dt>\s*<dd>(.*?)</dd>", page, re.S)
    return _text(m.group(1)) if m else None


def find_company(tax_id: str, refresh: bool = False) -> dict:
    """The register's own id for a tax ID: {"company_id", "name"} or {"error"} (none / several hits)."""
    page = _get(search_url(tax_id).removeprefix(BASE), refresh)
    hits = re.findall(r'<a href="/hy/companies/(\d+)">\s*<h4>(.*?)</h4>', page, re.S)
    if len(hits) != 1:
        return {"error": "not found" if not hits else f"{len(hits)} companies match", "hits": [h[0] for h in hits][:5]}
    return {"company_id": hits[0][0], "name": _text(hits[0][1])}


def company_card(company_id: str, refresh: bool = False) -> dict:
    """Name, status, registration, address and the list of owner declarations (newest first)."""
    page = _get(f"/hy/companies/{company_id}", refresh)
    if not page:
        return {"error": "company page unreadable"}
    title = re.search(r'class="border company-title">\s*<h4>(.*?)</h4>', page, re.S)
    status = _detail(page, "Կարգավիճակ") or ""
    decls = re.findall(r'<a href="(/hy/companies/\d+/declarations/[0-9a-f-]{36})">\s*([\d-]{10} [\d:]{5})\s*</a>', page)
    return {
        "company_id": company_id,
        "url": f"{BASE}/hy/companies/{company_id}",
        "name": _text(title.group(1)) if title else None,
        "tax_id": _detail(page, "ՀՎՀՀ"),
        "active": NO_LIQUIDATION in status,
        "status_text": status,
        "registered": _detail(page, "Գրանցման ամսաթիվ"),
        "address": _detail(page, "Գտնվելու վայր"),
        "declarations": [{"url": BASE + u, "filed": d} for u, d in sorted(decls, key=lambda x: x[1], reverse=True)],
    }


def _rows(fragment: str) -> list[tuple[str, str]]:
    return [(_text(k), _text(v)) for k, v in re.findall(
        r'class="decl-row-key decl-row">(.*?)</div>\s*<div class="decl-row-val decl-row">(.*?)</div>', fragment, re.S)]


def declaration(url: str, refresh: bool = False) -> dict:
    """One beneficial-owner declaration: confirmation date, company name and the owners it names."""
    page = _get(url.removeprefix(BASE), refresh)
    if not page:
        return {"url": url, "error": "declaration unreadable"}
    approved = re.search(r'class="pdf-approved">\s*[^<\d]*([\d/]{10})', page)
    sections = re.split(r'class="decl-section-name">', page)
    owners, name = [], None
    for sec in sections[1:]:
        heading = _text(sec.split("</div>", 1)[0])
        if heading == "Կազմակերպություն":
            name = dict(_rows(sec)).get("Անվանում")
        elif heading == "Իրական շահառուներ":
            person: dict = {}
            for key, val in _rows(sec):
                if key == "Անուն":
                    if person:
                        owners.append(person)
                    person = {"first": val}
                elif key == "Ազգանուն":
                    person["last"] = val
                elif key == "Քաղաքացիություն":
                    person["citizenship"] = val
                elif key.startswith("Իրական շահառու դառնալու"):
                    person["since"] = val
                elif key.startswith("Մասնակցության չափ"):
                    share = re.search(r"[\d.]+", val)
                    person["share"] = round(float(share.group()), 2) if share else None
            if person:
                owners.append(person)
    return {"url": url, "approved": approved.group(1) if approved else None, "name": name, "owners": owners}


def company(tax_id: str, refresh: bool = False, company_id: str | None = None) -> dict:
    """Everything the register publishes for one tax ID, with the owners named in every declaration.

    Older declarations are what show a former owner: someone the latest one no longer names. A
    declaration is a filed document at its own address and never changes, so a refresh re-reads the
    company card (which lists any new declaration) but takes known declarations from the cache.
    """
    base = {"tax_id": tax_id, "search_url": search_url(tax_id)}
    if not company_id:
        found = find_company(tax_id, refresh)
        if "error" in found:
            return {**base, **found}
        company_id = found["company_id"]
    card = company_card(company_id, refresh)
    for d in card.get("declarations") or []:
        d.update({k: v for k, v in declaration(d["url"]).items() if k != "url"})
    return {**base, **card, "checked": time.strftime("%Y-%m-%d")}


def save(out: dict) -> None:
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")


def crawl(limit: int | None = None, refresh: bool = False) -> dict:
    raw = json.loads(RAW.read_text(encoding="utf-8"))
    taxes = sorted(raw["companies"])[:limit]
    out = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {}
    for i, tax in enumerate(taxes, 1):
        if tax in out and not refresh:
            continue
        # the tax ID → register id mapping does not change, so a refresh goes straight to the card
        out[tax] = company(tax, refresh, (out.get(tax) or {}).get("company_id"))
        if i % 25 == 0:
            print(f"  {i}/{len(taxes)}", flush=True)
            save(out)
    save(out)
    found = [c for c in out.values() if "error" not in c]
    print(f"{OUT.name}: {len(out)} tax IDs, {len(found)} found, "
          f"{sum(1 for c in found if c.get('declarations'))} with owner declarations")
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("crawl")
    c.add_argument("--limit", type=int)
    c.add_argument("--refresh", action="store_true", help="re-read pages instead of using the cache")
    one = sub.add_parser("company")
    one.add_argument("tax_id")
    args = ap.parse_args()
    if args.cmd == "crawl":
        crawl(args.limit, args.refresh)
    else:
        print(json.dumps(company(args.tax_id), ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())

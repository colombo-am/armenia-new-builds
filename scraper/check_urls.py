"""Fetching a cited page and judging whether it shows what it is cited for.

The helpers the link audit (scraper/audit_links.py and audit_links_browser.py) is built on: a polite,
IRI-safe GET, a status classification, and a content check that looks for a project's names in three
languages, its street and house number, or its developer. A page that answers 200 but never mentions
the project is the failure a status check cannot see: a site that renames its slugs and serves its
home page instead of a 404.
"""
from __future__ import annotations

import random
import socket
import ssl
import threading
import time
import re
import urllib.error
import urllib.request
from html import unescape
from collections import defaultdict
from pathlib import Path
from urllib.parse import quote, urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parent.parent
PROJECTS = ROOT / "web" / "data" / "projects.json"
CONNECTIONS = ROOT / "web" / "data" / "connections.json"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/128.0.0.0 Safari/537.36")
HOST_DELAY = 1.0
TIMEOUT = 25
MAX_BODY = 1_500_000

_host_lock = defaultdict(threading.Lock)
_host_last: dict[str, float] = {}


def squash(text: str) -> str:
    """Lowercase and drop everything but letters and digits, so punctuation and spacing cannot differ."""
    return re.sub(r"[^0-9a-z\u0530-\u058f\u0400-\u04ff]+", "", (text or "").lower())


STOP = {"residential", "complex", "house", "housing", "building", "buildings", "project", "street",
        "district", "yerevan", "armenia", "quarter", "new", "the", "and", "llc", "ltd", "residence",
        "բնակելի", "համալիր", "շենք", "փողոց", "երևան", "жилой", "комплекс", "дом", "улица", "ереван"}


def tokens(text: str) -> list[str]:
    """Distinctive words of a name: the generic half of "X Residential Complex" says nothing."""
    words = re.findall(r"[0-9a-z\u0530-\u058f\u0400-\u04ff]+", (text or "").lower())
    return [w for w in words if len(w) >= 3 and w not in STOP]


def signals(p: dict) -> list[tuple[str, list[str]]]:
    """Groups of words, any of which the right page should carry, strongest first."""
    out = []
    for field in ("title", "title_full", "title_am", "title_ru"):
        t = tokens(p.get(field) or "")
        if t:
            out.append((field, t))
    address = p.get("address") or ""
    street = tokens(re.sub(r"\d+[/\-\d]*", " ", address.split(",")[0]))
    house = re.findall(r"\b(\d{1,3})(?:[/\-]\d+)?\b", address.split(",")[0])
    if street:
        out.append(("address", street + house[:1]))
    dev = tokens(p.get("developer") or "")
    if dev and p.get("developer") != "Unknown developer":
        out.append(("developer", dev))
    return out


def body_text(html: str) -> str:
    """Visible text plus embedded JSON — these sites ship their content in Next.js payloads."""
    text = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", html, flags=re.S | re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    payload = " ".join(re.findall(r"<script[^>]*>(.*?)</script>", html, re.S | re.I))
    return unescape(text + " " + payload)


def content_verdict(html: str, projects: list[dict], url: str = "") -> dict:
    """How well the page matches the project(s) it is cited for.

    Sites rename a project between catalogues ("Nor Avan Complex" vs "Nor Avan Residential Complex"),
    so words are compared rather than whole strings: most of a name's distinctive words, or the street
    plus house number, is a match; a few words is weak; nothing at all is a mismatch.
    """
    text = body_text(html).lower() + " " + url.lower()
    if len(text) < 200:
        return {"content": "empty"}
    words = set(re.findall(r"[0-9a-z\u0530-\u058f\u0400-\u04ff]+", text))
    best = {"content": "mismatch", "checked_projects": [p["id"] for p in projects[:3]]}
    for p in projects:
        for field, group in signals(p):
            hits = sum(1 for w in group if w in words)
            if not hits:
                continue
            ratio = hits / len(group)
            if ratio >= 0.6 or (field == "address" and hits >= 2):
                return {"content": "match", "matched": p["id"], "matched_on": field,
                        "evidence": f"{hits}/{len(group)} words of {field}"}
            best = {"content": "weak", "matched": p["id"], "matched_on": field,
                    "evidence": f"{hits}/{len(group)} words of {field}"}
    return best


def polite(host: str) -> None:
    """One request per host per second, so a slow site is never hit in parallel."""
    with _host_lock[host]:
        wait = HOST_DELAY - (time.monotonic() - _host_last.get(host, 0))
        if wait > 0:
            time.sleep(wait + random.uniform(0, 0.2))
        _host_last[host] = time.monotonic()


def classify(status: int | None, error: str | None) -> str:
    if status is None:
        return "unreachable"
    if status in (403, 429):
        return "blocked"
    if status == 404 or status == 410:
        return "missing"
    if 200 <= status < 400:
        return "ok"
    return "error"


def encoded(url: str) -> str:
    """Percent-encode an IRI: Armenian paths are common here and urllib only speaks ASCII."""
    parts = urlsplit(url)
    return urlunsplit((parts.scheme, parts.netloc.encode("idna").decode("ascii") if not parts.netloc.isascii() else parts.netloc,
                       quote(parts.path, safe="/%:@!$&'()*+,;=~"), quote(parts.query, safe="=&%:/?+,;@"), ""))


def fetch(url: str, ctx: ssl.SSLContext, limit: int = 4096) -> dict:
    """GET like a browser (HEAD is rejected or faked by too many of these sites) and read up to `limit` bytes.

    Returns status, final_url, ctype, body and ms; error when the request failed, and dns=True when the
    host name no longer resolves — a domain that is gone, not a site that is down.
    """
    polite(urlsplit(url).netloc)
    req = urllib.request.Request(encoded(url), headers={
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,image/*;q=0.8,*/*;q=0.7",
        "Accept-Language": "en,hy;q=0.8,ru;q=0.6",
    })
    started = time.monotonic()
    ms = lambda: round((time.monotonic() - started) * 1000)  # noqa: E731
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT, context=ctx) as r:
            body = r.read(limit)
            return {"status": r.status, "final_url": r.url, "ctype": r.headers.get("Content-Type", ""),
                    "body": body.decode("utf-8", "replace"), "bytes": len(body), "ms": ms()}
    except urllib.error.HTTPError as e:
        return {"status": e.code, "final_url": url, "error": e.reason and str(e.reason), "ms": ms()}
    except Exception as e:  # noqa: BLE001 — DNS, TLS, timeouts and resets all mean "cannot reach"
        res = {"status": None, "final_url": url, "error": f"{type(e).__name__}: {e}", "ms": ms()}
        if isinstance(getattr(e, "reason", None), socket.gaierror):
            res["dns"] = True
        return res

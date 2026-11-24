"""Hand-checked corrections to a project's data, applied while the dataset is built.

scraper/project_fixes.json holds, per project id, what a check against a live source found wrong:

    {"fixes": {"<project id>": {
        "remove": true,                                   # not a project a buyer can find (or a duplicate)
        "set": {"developer": "…", "completion": "2027-05-31", "social": {"instagram": "…"}},
        "unset": ["phones", "floors"],                    # a value that came from the wrong page
        "remove_images": ["<url>"], "remove_phones": ["<number>"],
        "add_sources": [{"name": "site.am", "url": "…"}], "remove_sources": ["<url>"],
        "unverified": {"reference": "<url>"},             # kept on the map, marked unconfirmed: only a mention remains
        "why": "…", "evidence": "…", "checked": "YYYY-MM-DD"}}}

Prices are corrected through scraper/price_verified_*.json instead, which already carries the
evidence and the unverifiable case. Every fix says why and what page showed it.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

FIXES_FILE = Path(__file__).resolve().parent / "project_fixes.json"


def load() -> dict[str, dict]:
    return json.loads(FIXES_FILE.read_text(encoding="utf-8")).get("fixes", {}) if FIXES_FILE.exists() else {}


def _digits(phone: str) -> str:
    return re.sub(r"\D", "", phone or "")[-8:]


def first_source(p: dict) -> str | None:
    """The project's first remaining source link, for when its main link is gone."""
    return next((s["url"] for s in p.get("sources") or [] if s.get("url")), None)


def fix_project(p: dict, fix: dict) -> None:
    """Apply one project's corrections in place."""
    for key, value in (fix.get("set") or {}).items():
        p[key] = {**(p.get(key) or {}), **value} if isinstance(value, dict) and isinstance(p.get(key), dict) else value
    for key in fix.get("unset") or []:
        p[key] = [] if isinstance(p.get(key), list) else None
    if fix.get("remove_images"):
        gone = set(fix["remove_images"])
        p["images"] = [u for u in p.get("images") or [] if u not in gone]
    if fix.get("remove_phones"):
        gone = {_digits(x) for x in fix["remove_phones"]}
        p["phones"] = [x for x in p.get("phones") or [] if _digits(x) not in gone]
    if fix.get("remove_sources"):
        gone = set(fix["remove_sources"])
        p["sources"] = [s for s in p.get("sources") or [] if s.get("url") not in gone]
        if p.get("source_url") in gone:
            p["source_url"] = first_source(p)
    known = {s.get("url") for s in p.get("sources") or []}
    p["sources"] = [*(p.get("sources") or []), *(s for s in fix.get("add_sources") or [] if s.get("url") not in known)]
    if fix.get("unverified"):
        p["unverified"] = fix["unverified"]
    p["data_fix"] = {k: fix[k] for k in ("why", "checked") if fix.get(k)}


def apply(projects: list[dict], fixes: dict | None = None) -> list[dict]:
    """Drop the projects a fix removes and correct the rest; returns the kept list."""
    fixes = load() if fixes is None else fixes
    kept = []
    for p in projects:
        fix = next((fixes[i] for i in [p["id"], *p.get("merged_ids", [])] if i in fixes), None)
        if fix and fix.get("remove"):
            continue
        if fix:
            fix_project(p, fix)
        kept.append(p)
    return kept

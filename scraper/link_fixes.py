"""Hand-checked link corrections, applied to everything the site shows.

scraper/link_fixes.json maps a URL that is broken or points at the wrong page to what replaces it:

    {"fixes": {"<old url>": {"url": "<replacement>", "why": "…", "checked": "YYYY-MM-DD"},
               "<old url>": {"drop": true, "why": "…", "checked": "YYYY-MM-DD"}}}

A replacement is used wherever the old URL appears — sources, websites, social links, images,
videos, research evidence, connection sources. A dropped URL is removed: from a list its whole entry
goes (an image, a source, a news item), from a single field the field is emptied. Every fix records
why, so the next audit can tell a curated correction from a new break.

A link that is right for one project and wrong for another (a catalogue that attached one account to
two complexes, a developer home page cited for each of its projects) takes a per-project map:

    "<old url>": {"projects": {"<project id>": "<url>" | null}, "why": "…"}

null drops the link from that project; projects not listed get the fix's own "url"/"drop", if any.

A link that is right but that no script can confirm (the name is in Armenian, the page is built by
JavaScript) is recorded as checked by hand, so the link audit counts it as verified:

    "<url>": {"verified": true, "why": "…", "evidence": "<text seen on the page>", "checked": "…"}
"""
from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

FIXES_FILE = Path(__file__).resolve().parent / "link_fixes.json"


def load() -> dict[str, dict]:
    return json.loads(FIXES_FILE.read_text(encoding="utf-8")).get("fixes", {}) if FIXES_FILE.exists() else {}


def _dropped(item, fixes: dict) -> bool:
    """A list entry goes when it is a dropped URL, or a link record (a source, a news item) whose url is
    one. Only "url" counts: a project also sits in a list, and losing its main link must not drop it."""
    if isinstance(item, str):
        return fixes.get(item, {}).get("drop", False)
    if isinstance(item, dict):
        return isinstance(item.get("url"), str) and fixes.get(item["url"], {}).get("drop", False)
    return False


def _fixed(value, fixes: dict, stats: dict):
    """One value after the fixes: a replaced URL, or the value itself (containers are rewritten in place)."""
    if isinstance(value, str):
        fix = fixes.get(value)
        if fix and fix.get("url"):
            stats["replaced"] += 1
            return fix["url"]
    elif isinstance(value, (list, dict)):
        apply(value, fixes, stats)
    return value


def apply_to_projects(projects: list[dict], fixes: dict | None = None, stats: Counter | None = None) -> list[dict]:
    """Per-project fixes first, then the ones that hold everywhere."""
    fixes = load() if fixes is None else fixes
    stats = Counter() if stats is None else stats
    scoped = {url: fix["projects"] for url, fix in fixes.items() if fix.get("projects")}
    for p in projects:
        local = {}
        for url, per in scoped.items():
            if p["id"] in per:
                local[url] = {"url": per[p["id"]]} if per[p["id"]] else {"drop": True}
        if local:
            apply(p, local, stats)
    return apply(projects, fixes, stats)


def apply(node, fixes: dict | None = None, stats: Counter | None = None):
    """Rewrite `node` (any JSON value) in place with the fixes; returns it. `stats` counts what changed."""
    fixes = load() if fixes is None else fixes
    stats = Counter() if stats is None else stats
    if isinstance(node, list):
        kept = [x for x in node if not _dropped(x, fixes)]
        stats["dropped"] += len(node) - len(kept)
        node[:] = [_fixed(x, fixes, stats) for x in kept]
    elif isinstance(node, dict):
        for k, v in node.items():
            if isinstance(v, str) and _dropped(v, fixes):
                node[k] = None
                stats["dropped"] += 1
            else:
                node[k] = _fixed(v, fixes, stats)
    return node

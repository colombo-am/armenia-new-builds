"""Owners of a company as its beneficial-owner declarations in the state register show them.

scraper/eregister.py stores every declaration a company filed, each naming its owners. This module
turns that into who owns the company now (named in the latest readable declaration) and who owned it
before (named only in older ones), each with the declaration that says so — the evidence an
ownership link in the connections graph points to.
"""
from __future__ import annotations

import re
from difflib import SequenceMatcher
from functools import lru_cache

from textutil import iso_day

# Է/Ե and Օ/Ո are written both ways in the register; case and punctuation do not matter
SPELLING = str.maketrans({"Է": "Ե", "Օ": "Ո", "է": "ե", "օ": "ո"})


@lru_cache(maxsize=None)
def name_tokens(name: str | None) -> tuple[str, ...]:
    return tuple(sorted(re.findall(r"\w+", (name or "").translate(SPELLING).upper())))


def same_person(a: str | None, b: str | None) -> bool:
    """Two spellings of one name. The register mistypes letters («Ամատւնի», «Մարությյան») and some
    records put the surname first, so words are compared in any order, each allowed one slip."""
    ta, tb = name_tokens(a), name_tokens(b)
    if len(ta) < 2 or len(tb) < 2:
        return False
    short, long_ = (ta, tb) if len(ta) <= len(tb) else (tb, ta)
    pool = list(long_)
    for word in short:
        if word in pool:  # the usual case: the same spelling
            pool.remove(word)
            continue
        score, best = max((SequenceMatcher(None, word, w).ratio(), w) for w in pool)
        if score < 0.85:  # Արմեն/Արման (0.80) are two names
            return False
        pool.remove(best)
    return True


def owner_history(record: dict | None) -> list[dict]:
    """Everyone the company's declarations name, newest declaration first.

    Each owner: {"name", "share", "current", "declaration" (url of the newest declaration naming
    them), "declared" (its date), "until" (for a former owner: date of the first declaration that no
    longer names them)}. Empty when the register has no readable declaration for the company.
    """
    decls = [d for d in (record or {}).get("declarations") or [] if d.get("owners") and iso_day(d.get("approved"))]
    decls.sort(key=lambda d: iso_day(d["approved"]), reverse=True)
    out: list[dict] = []
    for i, d in enumerate(decls):
        for o in d["owners"]:
            name = f"{o.get('first', '')} {o.get('last', '')}".strip()
            if any(same_person(name, x["name"]) for x in out):
                continue
            out.append({"name": name, "share": o.get("share"), "current": i == 0, "declaration": d["url"],
                        "declared": iso_day(d["approved"]), "until": iso_day(decls[i - 1]["approved"]) if i else None})
    return out


def find_owner(name: str | None, history: list[dict]) -> dict | None:
    return next((o for o in history if same_person(name, o["name"])), None)

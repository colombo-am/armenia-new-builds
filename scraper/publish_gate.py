"""Publish gate: decide what of a freshly built dataset may go live, against the last published one.

Automated refreshes publish without a human review, so every new or changed figure must carry
verification evidence or it does not go out:

  apply  per item, on web/data/projects.json
         - a new project is held back unless its location is checked (location_check verdict
           correct/moved) or the pin came straight from a source (geo_precision exact);
         - a new project's price is removed unless verified (price_verification confirmed/corrected);
         - on an existing project, an unverified jump of 30 % or more in any price figure, a new price
           where there was none, or any implausible price reverts the price fields to the published
           ones; a verification counts only if it differs from the published one (a stale
           "confirmed" carried over from an earlier check does not cover a new figure);
         - a stage that moves backwards (or to stalled/unknown) without a stage_check is reverted;
         - a pin that moves 1 km or more without a location check is reverted with its area.
         Held and reverted items are listed in scraper/reports/gate-<stamp>.json|md so the next
         refresh verifies them first.
  check  structural problems that block publishing outright: duplicate ids, missing fields,
         coordinates outside Armenia, meta.count mismatch, or a collapse in the project count.

The gate uses only the standard library, so the workflow can run the copy from the base commit
in isolation (python3 -I) with GATE_ROOT pointing at the checkout.

Usage:
  python3 scraper/publish_gate.py apply --base-ref <commit>
  python3 scraper/publish_gate.py check --base-ref <commit>
"""
from __future__ import annotations

import argparse
import copy
import json
from collections import Counter
import math
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(os.environ.get("GATE_ROOT") or Path(__file__).resolve().parent.parent)
DATA = ROOT / "web" / "data" / "projects.json"
REPORTS = ROOT / "scraper" / "reports"

PRICE_JUMP = 0.30
JUMP_FIELDS = ("usd_m2_min", "usd_m2_max", "usd_from")
PRICE_RANGE = (300, 15000)  # USD per m2; the whole dataset sits within 800-8,400
MOVE_M = 1000
ARMENIA = {"lat": (38.8, 41.4), "lng": (43.3, 46.7)}  # same box build_dataset._valid_coords accepts
MAX_DROP = (10, 0.05)  # fail when more than max(10, 5 %) of the published projects vanish
PRICE_OK = {"confirmed", "corrected"}
LOCATION_OK = {"correct", "moved"}
STAGE_RANK = {"not started": 0, "just started": 1, "in progress": 2, "finished": 3}
PRICE_FIELDS = ("usd_m2_min", "usd_m2_max", "amd_m2_min", "amd_m2_max", "usd_from", "amd_from", "prices_by_floor",
                "prices_by_rooms", "price_obs", "price_confidence", "price_flags", "price_verification", "price_updated",
                "discount_pct", "bench_usd_m2", "bench_n", "bench_scope")
STAGE_FIELDS = ("stage", "stage_estimated", "stage_check")
LOCATION_FIELDS = ("lat", "lng", "geo_precision", "geo_obs", "geo_spread_m", "geo_support", "geo_outliers",
                   "location_check", "location_note", "region", "district", "elevation_m")


# ---------------------------------------------------------------- predicates
def haversine_m(a: dict, b: dict) -> float:
    """Distance in metres between two dicts with lat/lng."""
    la1, lo1, la2, lo2 = map(math.radians, (a["lat"], a["lng"], b["lat"], b["lng"]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(h))


def fresh(old: dict, new: dict, field: str) -> bool:
    """True when `new` carries a check in `field` that is not the one already published."""
    return bool(new.get(field)) and new.get(field) != old.get(field)


def price_plausible(p: dict) -> bool:
    v = p.get("usd_m2_min")
    return v is None or PRICE_RANGE[0] <= v <= PRICE_RANGE[1]


def price_verified(p: dict) -> bool:
    return (p.get("price_verification") or {}).get("verdict") in PRICE_OK and price_plausible(p)


def location_checked(p: dict) -> bool:
    return (p.get("location_check") or {}).get("verdict") in LOCATION_OK


def location_trusted(p: dict) -> bool:
    return location_checked(p) or p.get("geo_precision") == "exact"


def in_armenia(p: dict) -> bool:
    lat, lng = p.get("lat"), p.get("lng")
    return (isinstance(lat, (int, float)) and isinstance(lng, (int, float))
            and ARMENIA["lat"][0] <= lat <= ARMENIA["lat"][1] and ARMENIA["lng"][0] <= lng <= ARMENIA["lng"][1])


def price_jumped(old: dict, new: dict) -> bool:
    for f in JUMP_FIELDS:
        a, b = old.get(f), new.get(f)
        if b is not None and (not a or abs(b / a - 1) >= PRICE_JUMP):
            return True
    return False


def stage_regressed(old: dict, new: dict) -> bool:
    a, b = old.get("stage"), new.get("stage")
    if a == b or a not in STAGE_RANK:
        return False
    return b not in STAGE_RANK or STAGE_RANK[b] < STAGE_RANK[a]


# ---------------------------------------------------------------- apply
def _restore(new: dict, old: dict, fields: tuple[str, ...]) -> None:
    for f in fields:
        if f in old:
            new[f] = copy.deepcopy(old[f])
        else:
            new.pop(f, None)


def _strip_price(p: dict) -> None:
    for f in PRICE_FIELDS:
        if f in ("price_verification", "price_flags", "price_obs"):
            continue
        v = p.get(f)
        p[f] = type(v)() if isinstance(v, (list, dict)) else None
    p["price_confidence"] = "none"


def _match(base: list[dict]):
    by_id = {p["id"]: p for p in base}
    by_url = {}
    for p in base:
        for s in p.get("sources") or []:
            if s.get("url"):
                by_url.setdefault(s["url"], p)

    def find(p: dict) -> dict | None:
        if p["id"] in by_id:
            return by_id[p["id"]]
        return next((by_url[s["url"]] for s in p.get("sources") or [] if s.get("url") in by_url), None)
    return find


def _review_new(p: dict, report: dict) -> bool:
    """True when a new project may be published (its price may be stripped)."""
    reasons = []
    if not location_trusted(p):
        reasons.append(f"location not verified ({p.get('geo_precision')})")
    if not in_armenia(p):
        reasons.append("coordinates outside Armenia")
    if not p.get("title") or not p.get("source_url"):
        reasons.append("missing title or source")
    if reasons:
        report["held"].append({"id": p["id"], "title": p.get("title"), "reasons": reasons})
        return False
    if p.get("usd_m2_min") is not None and not price_verified(p):
        report["price_stripped"].append({"id": p["id"], "title": p.get("title"), "usd_m2_min": p["usd_m2_min"]})
        _strip_price(p)
    return True


def _review_existing(p: dict, old: dict, report: dict) -> None:
    def revert(field: str, fields: tuple[str, ...], frm, to) -> None:
        report["reverted"].append({"id": p["id"], "title": p.get("title"), "field": field, "from": frm, "to": to})
        _restore(p, old, fields)

    if not price_plausible(p) or (price_jumped(old, p) and not (price_verified(p) and fresh(old, p, "price_verification"))):
        revert("price", PRICE_FIELDS, old.get("usd_m2_min"), p.get("usd_m2_min"))
    if stage_regressed(old, p) and not fresh(old, p, "stage_check"):
        revert("stage", STAGE_FIELDS, old.get("stage"), p.get("stage"))
    moved = in_armenia(old) and in_armenia(p) and haversine_m(old, p) >= MOVE_M
    if moved and not (location_checked(p) and fresh(old, p, "location_check")):
        revert("location", LOCATION_FIELDS, [old["lat"], old["lng"]], [p["lat"], p["lng"]])


def apply(base: dict, new: dict) -> tuple[dict, dict]:
    """Return (dataset safe to publish, report of held/reverted/price-stripped items). Inputs are not modified."""
    new = copy.deepcopy(new)
    find = _match(base.get("projects") or [])
    report = {"held": [], "reverted": [], "price_stripped": []}
    kept = []
    for p in new.get("projects") or []:
        old = find(p)
        if old is None:
            if _review_new(p, report):
                kept.append(p)
            continue
        _review_existing(p, old, report)
        kept.append(p)
    new["projects"] = kept
    new.setdefault("meta", {})["count"] = len(kept)
    return new, report


# ---------------------------------------------------------------- check
def check(base: dict, published: dict) -> list[str]:
    """Structural problems that must block publishing; empty when the dataset is sound."""
    errors = []
    projects = published.get("projects") or []
    ids = [p.get("id") for p in projects]
    dupes = sorted(str(i) for i, n in Counter(ids).items() if n > 1)
    if dupes:
        errors.append(f"duplicate ids: {', '.join(dupes[:10])}")
    count = (published.get("meta") or {}).get("count")
    if count != len(projects):
        errors.append(f"meta.count {count} != {len(projects)} projects")
    for p in projects:
        for f in ("id", "title", "source_url"):
            if not p.get(f):
                errors.append(f"{p.get('id')}: missing {f}")
        if not in_armenia(p):
            errors.append(f"{p.get('id')}: coordinates outside Armenia ({p.get('lat')}, {p.get('lng')})")
    old_n = len(base.get("projects") or [])
    allowed = max(MAX_DROP[0], int(old_n * MAX_DROP[1]))
    if old_n - len(projects) > allowed:
        errors.append(f"project count dropped from {old_n} to {len(projects)} (more than {allowed})")
    return errors


# ---------------------------------------------------------------- CLI
def load_base(ref: str) -> dict:
    out = subprocess.run(["git", "show", f"{ref}:web/data/projects.json"], cwd=ROOT, capture_output=True, check=True)
    return json.loads(out.stdout)


REPORT_SECTIONS = (
    ("held", "Held back (new, unverified)", lambda x: f": {'; '.join(x['reasons'])}"),
    ("reverted", "Reverted to the published value", lambda x: f" {x['field']}: kept {x['from']}, rejected {x['to']}"),
    ("price_stripped", "Published without price (price unverified)", lambda x: f": {x['usd_m2_min']} $/m²"),
)


def summary(report: dict) -> str:
    return (f"Held back: {len(report['held'])} · Reverted: {len(report['reverted'])} · "
            f"Published without price: {len(report['price_stripped'])}")


def write_report(report: dict) -> Path:
    REPORTS.mkdir(exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M")
    (REPORTS / f"gate-{stamp}.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    lines = [f"# Publish gate {stamp}", "", summary(report), ""]
    for key, heading, detail in REPORT_SECTIONS:
        if report[key]:
            lines += [f"## {heading}", *(f"- {x['title']} ({x['id']}){detail(x)}" for x in report[key]), ""]
    path = REPORTS / f"gate-{stamp}.md"
    path.write_text("\n".join(lines), encoding="utf-8")
    return path


def cmd_apply(args) -> int:
    published, report = apply(load_base(args.base_ref), json.loads(DATA.read_text(encoding="utf-8")))
    tmp = DATA.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(published, ensure_ascii=False), encoding="utf-8")
    tmp.replace(DATA)
    path = write_report(report)
    print(summary(report))
    print(f"report: {path.relative_to(ROOT)}")
    return 0


def cmd_check(args) -> int:
    errors = check(load_base(args.base_ref), json.loads(DATA.read_text(encoding="utf-8")))
    for e in errors[:50]:
        print(f"::error::{e}")
    print("gate check: " + ("FAILED" if errors else "ok"))
    return 1 if errors else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("apply", "check"):
        sub.add_parser(name).add_argument("--base-ref", required=True, help="commit holding the published dataset")
    args = ap.parse_args()
    return {"apply": cmd_apply, "check": cmd_check}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())

"""Dataset history: one compact snapshot of every project per dataset date.

export_db.py rebuilds the SQLite file from scratch on every build, so this committed file
(web/data/history.json) is the durable record of how prices, stages and ratings changed. The
analytics page reads it for its trend charts, and export_db.py flattens it into the
`snapshots`, `project_history` and `project_renames` tables.

Snapshots are keyed by meta.generated: rebuilding on the same day replaces that day's snapshot
instead of adding a duplicate. `renamed` maps project ids that disappeared since the previous
snapshot to the id that took over their source URLs (merged duplicates), so a project's series
can be followed across merges.

Usage:
  python3 scraper/history.py append [--prev scraper/reports/projects.prev.json] [--origin build]
  python3 scraper/history.py backfill   # rebuild from the git history of web/data/projects.json
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

from pipeline import _index, load_projects

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "web" / "data" / "projects.json"
HISTORY = ROOT / "web" / "data" / "history.json"
FIELDS = ["id", "usd_m2_min", "usd_m2_max", "stage", "price_confidence", "kind", "region", "district",
          "developer", "grade"]
ORIGINS = ("backfill", "build", "refresh")


def project_row(p: dict) -> list:
    """One project as a list aligned with FIELDS."""
    return [p.get("id"), p.get("usd_m2_min"), p.get("usd_m2_max"), p.get("stage"), p.get("price_confidence"),
            p.get("kind"), p.get("region"), p.get("district"), p.get("developer_group"),
            (p.get("developer_rep") or {}).get("grade")]


def snapshot(data: dict, origin: str, commit: str | None = None, prev: list[dict] = ()) -> dict:
    """Compact snapshot of a projects.json document; rows are sorted by id for stable diffs.
    `prev` is the previous build's projects, used to record merged ids in `renamed`."""
    meta, projects = data.get("meta") or {}, data.get("projects") or []
    return {"date": meta.get("generated"), "origin": origin, "commit": commit, "amd_per_usd": meta.get("amd_per_usd"),
            "renamed": renames(prev, projects), "rows": sorted((project_row(p) for p in projects), key=lambda r: r[0] or "")}


def renames(old: list[dict], new: list[dict]) -> dict[str, str]:
    """Ids present in `old` but not in `new`, mapped to the new project that now holds one of their source URLs."""
    new_ids = {p["id"] for p in new}
    by_url = _index(new)
    out = {}
    for p in old:
        if p["id"] in new_ids:
            continue
        target = next((by_url[s["url"]] for s in p.get("sources") or [] if s.get("url") in by_url), None)
        if target:
            out[p["id"]] = target["id"]
    return out


def compose(first: dict[str, str], then: dict[str, str]) -> dict[str, str]:
    """Rename map equivalent to applying `first` and then `then`; identity mappings are dropped."""
    out = {k: then.get(v, v) for k, v in first.items()}
    out.update(then)
    return {k: v for k, v in out.items() if k != v}


def upsert(hist: dict, snap: dict) -> dict:
    """Add `snap`, replacing a snapshot of the same date (its renames are kept and chained)."""
    if not snap.get("date"):
        raise ValueError("snapshot has no date (meta.generated missing)")
    same = next((s for s in hist["snapshots"] if s["date"] == snap["date"]), None)
    snaps = [s for s in hist["snapshots"] if s is not same]
    if same:
        snap = {**snap, "renamed": compose(same.get("renamed") or {}, snap.get("renamed") or {})}
    snaps.append(snap)
    snaps.sort(key=lambda s: s["date"])
    return {"fields": FIELDS, "snapshots": snaps}


def load(path: Path = HISTORY) -> dict:
    if not path.exists():
        return {"fields": FIELDS, "snapshots": []}
    hist = json.loads(path.read_text(encoding="utf-8"))
    if hist.get("fields") != FIELDS:
        raise ValueError(f"{path} has fields {hist.get('fields')}, expected {FIELDS}; migrate it before appending")
    return hist


def save(path: Path, hist: dict) -> None:
    """Write one snapshot per line, so each refresh is a one-line git diff."""
    lines = [json.dumps(s, ensure_ascii=False, separators=(",", ":")) for s in hist["snapshots"]]
    body = '{"fields":' + json.dumps(hist["fields"]) + ',"snapshots":[\n' + ",\n".join(lines) + "\n]}\n"
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(body, encoding="utf-8")
    tmp.replace(path)


def table_rows(hist: dict) -> tuple[list[dict], list[dict], list[dict]]:
    """Flatten history into rows for the snapshots, project_history and project_renames tables."""
    snaps, rows, renamed = [], [], []
    names = ["project_id", *FIELDS[1:]]
    for s in hist["snapshots"]:
        snaps.append({"date": s["date"], "origin": s.get("origin"), "commit_sha": s.get("commit"),
                      "project_count": len(s["rows"]), "amd_per_usd": s.get("amd_per_usd")})
        rows.extend({"date": s["date"], **dict(zip(names, r))} for r in s["rows"])
        renamed.extend({"date": s["date"], "old_id": k, "new_id": v} for k, v in sorted((s.get("renamed") or {}).items()))
    return snaps, rows, renamed


# ---------------------------------------------------------------- commands
def git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, check=True).stdout


def head_commit() -> str | None:
    try:
        return git("rev-parse", "--short", "HEAD").strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


def cmd_append(args) -> None:
    data = json.loads(DATA.read_text(encoding="utf-8"))
    snap = snapshot(data, args.origin, head_commit(), load_projects(args.prev) if args.prev else [])
    hist = upsert(load(HISTORY), snap)
    save(HISTORY, hist)
    print(f"history: {snap['date']} ({args.origin}) · {len(snap['rows'])} projects · "
          f"{len(snap['renamed'])} renamed · {len(hist['snapshots'])} snapshots")


def cmd_backfill(args) -> None:
    """Rebuild history from every committed projects.json, keeping the last commit of each dataset date."""
    revs = git("log", "--reverse", "--format=%h", "--", "web/data/projects.json").split()
    hist, prev = {"fields": FIELDS, "snapshots": []}, []
    for rev in revs:
        data = json.loads(git("show", f"{rev}:web/data/projects.json"))
        snap = snapshot(data, "backfill", rev, prev)
        hist = upsert(hist, snap)
        prev = data["projects"]
    current = load(HISTORY)
    known = {s["date"] for s in hist["snapshots"]}
    for s in current["snapshots"]:
        if s["date"] not in known:
            hist = upsert(hist, s)
    save(HISTORY, hist)
    print(f"history: {len(hist['snapshots'])} snapshots from {len(revs)} commits")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("append", help="add or replace the snapshot of the current dataset")
    a.add_argument("--prev", type=Path, help="previous build's projects.json, used to detect merged ids")
    a.add_argument("--origin", choices=ORIGINS, default=os.environ.get("HISTORY_ORIGIN") or "build")
    sub.add_parser("backfill", help="rebuild from the git history of web/data/projects.json")
    args = ap.parse_args()
    {"append": cmd_append, "backfill": cmd_backfill}[args.cmd](args)
    return 0


if __name__ == "__main__":
    sys.exit(main())

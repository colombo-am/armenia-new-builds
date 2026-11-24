import copy
import json
from pathlib import Path

import publish_gate as gate

ROOT = Path(__file__).resolve().parents[2]


def proj(pid, **kw):
    p = {"id": pid, "title": pid.upper(), "source_url": f"https://src/{pid}", "sources": [{"url": f"https://src/{pid}"}],
         "lat": 40.18, "lng": 44.51, "geo_precision": "exact", "kind": "Apartments", "stage": "in progress",
         "usd_m2_min": None, "price_confidence": "none"}
    p.update(kw)
    return p


VERIFIED = {"verdict": "confirmed", "evidence_url": "https://x"}


def doc(*projects):
    return {"meta": {"generated": "2026-12-01", "count": len(projects)}, "projects": list(projects)}


def run(base, new):
    return gate.apply(doc(*base), doc(*new))


def by_id(result):
    published, _ = result
    return {p["id"]: p for p in published["projects"]}


# ---------------------------------------------------------------- new projects
def test_new_project_with_exact_pin_and_no_price_is_published():
    published, report = run([], [proj("a")])
    assert [p["id"] for p in published["projects"]] == ["a"]
    assert report["held"] == []


def test_new_project_with_unverified_approximate_location_is_held():
    published, report = run([], [proj("a", geo_precision="district")])
    assert published["projects"] == []
    assert report["held"][0]["id"] == "a"


def test_new_project_with_checked_location_is_published():
    published, _ = run([], [proj("a", geo_precision="street", location_check={"verdict": "correct"})])
    assert len(published["projects"]) == 1


def test_new_project_with_unverified_price_is_published_without_price():
    p = proj("a", usd_m2_min=1500, usd_m2_max=1800, amd_m2_min=540000, usd_from=60000, price_confidence="medium")
    out = by_id(run([], [p]))["a"]
    assert out["usd_m2_min"] is None and out["usd_m2_max"] is None and out["usd_from"] is None
    assert out["price_confidence"] == "none"


def test_new_project_with_verified_price_keeps_it():
    p = proj("a", usd_m2_min=1500, price_confidence="verified", price_verification=VERIFIED)
    assert by_id(run([], [p]))["a"]["usd_m2_min"] == 1500


def test_meta_count_follows_published_projects():
    published, _ = run([], [proj("a"), proj("b", geo_precision="city")])
    assert published["meta"]["count"] == 1


# ---------------------------------------------------------------- prices of existing projects
def test_unverified_price_jump_is_reverted():
    base = proj("a", usd_m2_min=1000, usd_m2_max=1200, price_confidence="verified", price_verification=VERIFIED)
    new = proj("a", usd_m2_min=2000, usd_m2_max=2400, price_confidence="medium")
    published, report = run([base], [new])
    out = by_id((published, report))["a"]
    assert out["usd_m2_min"] == 1000 and out["usd_m2_max"] == 1200 and out["price_confidence"] == "verified"
    assert report["reverted"][0]["field"] == "price"


def test_verified_price_jump_is_kept():
    base = proj("a", usd_m2_min=1000)
    new = proj("a", usd_m2_min=2000, price_confidence="verified", price_verification={"verdict": "corrected"})
    assert by_id(run([base], [new]))["a"]["usd_m2_min"] == 2000


def test_small_price_change_is_kept_without_verification():
    base = proj("a", usd_m2_min=1000)
    new = proj("a", usd_m2_min=1100, price_confidence="medium")
    assert by_id(run([base], [new]))["a"]["usd_m2_min"] == 1100


def test_new_price_on_a_project_that_had_none_needs_verification():
    base = proj("a")
    new = proj("a", usd_m2_min=1300, price_confidence="medium")
    assert by_id(run([base], [new]))["a"]["usd_m2_min"] is None


def test_price_disappearing_is_allowed():
    base = proj("a", usd_m2_min=1000, price_confidence="verified", price_verification=VERIFIED)
    new = proj("a", usd_m2_min=None, price_confidence="none")
    assert by_id(run([base], [new]))["a"]["usd_m2_min"] is None


def test_stale_verification_does_not_cover_a_new_price():
    base = proj("a", usd_m2_min=1000, price_confidence="verified", price_verification=VERIFIED)
    new = proj("a", usd_m2_min=2000, price_confidence="verified", price_verification=dict(VERIFIED))
    assert by_id(run([base], [new]))["a"]["usd_m2_min"] == 1000


def test_unverified_jump_in_starting_price_is_reverted():
    base = proj("a", usd_m2_min=1000, usd_from=50000)
    new = proj("a", usd_m2_min=1000, usd_from=120000)
    assert by_id(run([base], [new]))["a"]["usd_from"] == 50000


def test_stale_stage_check_does_not_cover_a_regression():
    check = {"confidence": "high"}
    base = proj("a", stage="finished", stage_check=check)
    new = proj("a", stage="in progress", stage_check=dict(check))
    assert by_id(run([base], [new]))["a"]["stage"] == "finished"


def test_stale_location_check_does_not_cover_a_move():
    check = {"verdict": "correct", "evidence_url": "https://x"}
    base = proj("a", lat=40.18, lng=44.51, location_check=check)
    new = proj("a", lat=40.25, lng=44.51, location_check=dict(check))
    assert by_id(run([base], [new]))["a"]["lat"] == 40.18


def test_gate_imports_only_the_standard_library():
    import ast, sys
    tree = ast.parse((ROOT / "scraper" / "publish_gate.py").read_text())
    mods = {a.name.split(".")[0] for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names}
    mods |= {n.module.split(".")[0] for n in ast.walk(tree) if isinstance(n, ast.ImportFrom) and n.module}
    assert mods <= set(sys.stdlib_module_names) | {"__future__"}


def test_implausible_price_is_reverted_even_if_marked_verified():
    base = proj("a", usd_m2_min=1000)
    new = proj("a", usd_m2_min=99000, price_confidence="verified", price_verification=VERIFIED)
    assert by_id(run([base], [new]))["a"]["usd_m2_min"] == 1000


# ---------------------------------------------------------------- stage and location
def test_unchecked_stage_regression_is_reverted():
    base = proj("a", stage="finished")
    published, report = run([base], [proj("a", stage="in progress")])
    assert by_id((published, report))["a"]["stage"] == "finished"
    assert report["reverted"][0]["field"] == "stage"


def test_checked_stage_regression_is_kept():
    base = proj("a", stage="finished")
    new = proj("a", stage="stalled", stage_check={"confidence": "high"})
    assert by_id(run([base], [new]))["a"]["stage"] == "stalled"


def test_stage_progress_is_kept():
    assert by_id(run([proj("a", stage="just started")], [proj("a", stage="finished")]))["a"]["stage"] == "finished"


def test_unchecked_long_move_is_reverted_with_its_area():
    base = proj("a", lat=40.18, lng=44.51, district="Kentron")
    new = proj("a", lat=40.25, lng=44.51, district="Avan", geo_precision="street")
    out = by_id(run([base], [new]))["a"]
    assert (out["lat"], out["lng"], out["district"]) == (40.18, 44.51, "Kentron")


def test_checked_long_move_is_kept():
    base = proj("a", lat=40.18, lng=44.51)
    new = proj("a", lat=40.25, lng=44.51, location_check={"verdict": "moved"})
    assert by_id(run([base], [new]))["a"]["lat"] == 40.25


def test_project_matched_by_source_url_counts_as_existing():
    base = proj("old", usd_m2_min=1000, sources=[{"url": "https://shared"}])
    new = proj("new", usd_m2_min=2500, price_confidence="medium", geo_precision="district",
               sources=[{"url": "https://shared"}])
    out = by_id(run([base], [new]))
    assert "new" in out and out["new"]["usd_m2_min"] == 1000


# ---------------------------------------------------------------- structural check
def test_check_passes_on_a_sound_dataset():
    assert gate.check(doc(proj("a"), proj("b")), doc(proj("a"), proj("b"))) == []


def test_check_fails_on_a_collapse_in_project_count():
    base = doc(*[proj(f"p{i}") for i in range(100)])
    assert any("dropped" in e for e in gate.check(base, doc(*[proj(f"p{i}") for i in range(80)])))
    assert gate.check(base, doc(*[proj(f"p{i}") for i in range(95)])) == []


def test_check_fails_on_coordinates_outside_armenia_and_missing_fields():
    errors = gate.check(doc(), doc(proj("a", lat=55.7, lng=37.6), proj("b", title="")))
    assert any("outside Armenia" in e for e in errors)
    assert any("missing title" in e for e in errors)


def test_check_fails_on_duplicate_ids_and_wrong_count():
    bad = doc(proj("a"), proj("a"))
    bad["meta"]["count"] = 5
    errors = gate.check(doc(), bad)
    assert any("duplicate" in e for e in errors)
    assert any("meta.count" in e for e in errors)


def test_current_dataset_passes_unchanged():
    data = json.loads((ROOT / "web" / "data" / "projects.json").read_text())
    published, report = gate.apply(copy.deepcopy(data), copy.deepcopy(data))
    assert report["held"] == [] and report["reverted"] == [] and report["price_stripped"] == []
    assert gate.check(data, published) == []

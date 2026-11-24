import json

import history


def proj(pid, urls=(), **kw):
    return {"id": pid, "sources": [{"url": u} for u in urls], **kw}


def test_project_row_follows_fields_and_tolerates_missing_values():
    p = proj("a", usd_m2_min=1200, usd_m2_max=1500, stage="in progress", price_confidence="verified",
             kind="Apartments", region="Yerevan", district="Arabkir", developer_group="Dev",
             developer_rep={"grade": "B"})
    assert history.project_row(p) == ["a", 1200, 1500, "in progress", "verified", "Apartments",
                                      "Yerevan", "Arabkir", "Dev", "B"]
    bare = history.project_row(proj("b"))
    assert bare[0] == "b" and bare[1:] == [None] * (len(history.FIELDS) - 1)


def test_snapshot_records_date_origin_and_one_row_per_project():
    data = {"meta": {"generated": "2026-11-08", "amd_per_usd": 360.5},
            "projects": [proj("b"), proj("a")]}
    snap = history.snapshot(data, origin="build", commit="abc1234")
    assert snap["date"] == "2026-11-08"
    assert snap["origin"] == "build" and snap["commit"] == "abc1234"
    assert snap["amd_per_usd"] == 360.5
    assert [r[0] for r in snap["rows"]] == ["a", "b"]
    assert snap["renamed"] == {}


def test_renames_follow_source_urls_of_vanished_ids():
    old = [proj("keep", ["u1"]), proj("merged", ["u2"]), proj("gone", ["u3"])]
    new = [proj("keep", ["u1"]), proj("target", ["u2", "u4"])]
    assert history.renames(old, new) == {"merged": "target"}


def test_renames_ignore_ids_that_still_exist():
    old = [proj("a", ["u1"]), proj("b", ["u2"])]
    new = [proj("a", ["u1", "u2"]), proj("b", ["u5"])]
    assert history.renames(old, new) == {}


def test_compose_chains_renames():
    assert history.compose({"a": "b"}, {"b": "c", "x": "y"}) == {"a": "c", "b": "c", "x": "y"}
    assert history.compose({"a": "b"}, {"b": "a"}) == {"b": "a"}


def test_upsert_appends_in_date_order():
    h = {"fields": history.FIELDS, "snapshots": []}
    h = history.upsert(h, {"date": "2026-10-01", "renamed": {}, "rows": []})
    h = history.upsert(h, {"date": "2026-09-01", "renamed": {}, "rows": []})
    assert [s["date"] for s in h["snapshots"]] == ["2026-09-01", "2026-10-01"]


def test_upsert_replaces_same_date_and_keeps_earlier_renames():
    h = {"fields": history.FIELDS, "snapshots": [{"date": "2026-11-08", "renamed": {"a": "b"}, "rows": [["a"]]}]}
    h = history.upsert(h, {"date": "2026-11-08", "renamed": {"b": "c"}, "rows": [["c"]]})
    assert len(h["snapshots"]) == 1
    assert h["snapshots"][0]["rows"] == [["c"]]
    assert h["snapshots"][0]["renamed"] == {"a": "c", "b": "c"}


def test_upsert_rejects_snapshot_without_date():
    h = {"fields": history.FIELDS, "snapshots": []}
    try:
        history.upsert(h, {"date": None, "renamed": {}, "rows": []})
    except ValueError:
        return
    raise AssertionError("expected ValueError")


def test_save_writes_one_snapshot_per_line_and_load_roundtrips(tmp_path):
    path = tmp_path / "history.json"
    h = {"fields": history.FIELDS, "snapshots": [
        {"date": "2026-09-01", "origin": "backfill", "renamed": {}, "rows": [["a", 1]]},
        {"date": "2026-10-01", "origin": "build", "renamed": {"a": "b"}, "rows": [["b", 2]]}]}
    history.save(path, h)
    lines = path.read_text().splitlines()
    assert sum(1 for line in lines if '"date"' in line) == 2
    assert history.load(path) == h
    assert json.loads(path.read_text()) == h


def test_load_missing_file_gives_empty_history(tmp_path):
    h = history.load(tmp_path / "none.json")
    assert h == {"fields": history.FIELDS, "snapshots": []}


def test_load_rejects_a_field_list_it_does_not_know(tmp_path):
    path = tmp_path / "history.json"
    path.write_text(json.dumps({"fields": ["id", "other"], "snapshots": []}))
    try:
        history.load(path)
    except ValueError:
        return
    raise AssertionError("expected ValueError")


def test_table_rows_flatten_snapshots_for_sqlite():
    h = {"fields": history.FIELDS, "snapshots": [
        {"date": "2026-09-01", "origin": "backfill", "commit": "abc", "amd_per_usd": 390.0,
         "renamed": {"x": "a"}, "rows": [["a", 1000, 1200, "finished", "verified", "Apartments", "Yerevan", "Kentron", "Dev", "A"]]}]}
    snaps, rows, renamed = history.table_rows(h)
    assert snaps == [{"date": "2026-09-01", "origin": "backfill", "commit_sha": "abc", "project_count": 1, "amd_per_usd": 390.0}]
    assert rows[0]["project_id"] == "a" and rows[0]["usd_m2_min"] == 1000 and rows[0]["grade"] == "A"
    assert renamed == [{"date": "2026-09-01", "old_id": "x", "new_id": "a"}]

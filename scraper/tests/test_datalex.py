import json

import datalex


def search_response(*rows):
    return json.dumps({"result": {"data": list(rows)}})


def test_case_index_merges_committed_file_and_cache(tmp_path, monkeypatch):
    cache = tmp_path / "cache"
    cache.mkdir()
    (cache / "civil_abc.json").write_text(search_response(
        {"case_number": "A/1", "case_id": 99}, {"case_number": "B/2", "case_id": 2}, {"case_number": "C/3"}))
    (cache / "payment_x.json").write_text(search_response({"case_number": "D/4", "case_id": 4}))
    (cache / "broken_y.json").write_text("{not json")
    index_file = tmp_path / "datalex_cases.json"
    index_file.write_text(json.dumps({"A/1": {"case_id": 1, "tab": "civil"}}))
    monkeypatch.setattr(datalex, "CACHE_DIR", cache)
    monkeypatch.setattr(datalex, "INDEX_FILE", index_file)

    assert datalex.case_index() == {
        "A/1": {"case_id": 1, "tab": "civil"},
        "B/2": {"case_id": 2, "tab": "civil"},
        "D/4": {"case_id": 4, "tab": "payment_order"},
    }
    assert datalex.save_case_index() == 3
    monkeypatch.setattr(datalex, "CACHE_DIR", tmp_path / "missing")
    assert set(datalex.case_index()) == {"A/1", "B/2", "D/4"}


def test_case_index_without_file_or_cache_is_empty(tmp_path, monkeypatch):
    monkeypatch.setattr(datalex, "CACHE_DIR", tmp_path / "missing")
    monkeypatch.setattr(datalex, "INDEX_FILE", tmp_path / "none.json")
    assert datalex.case_index() == {}

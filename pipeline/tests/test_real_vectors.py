"""reference.real_vectors の検査。TS 側（web/tests/unit/data.test.ts）は同じベクタファイルと照合する。"""

from __future__ import annotations

import json

from reference.real_vectors import RETURNS_FILE, VECTORS_FILE, make_vectors


def _load():
    doc = json.loads(RETURNS_FILE.read_text(encoding="utf-8"))
    saved = json.loads(VECTORS_FILE.read_text(encoding="utf-8"))
    return doc, saved


def test_vectors_file_is_up_to_date():
    """コミット済みベクタ = 現在の returns.json と transform.real_return の出力。"""
    doc, saved = _load()
    assert saved == make_vectors(doc)


def test_all_six_combos_present():
    _, saved = _load()
    assert sorted(saved["combos"]) == sorted(
        f"{c}_{a}" for c in ("USD", "JPY") for a in ("SP500", "WORLD_DM", "GOLD")
    )


def test_usd_real_return_spot_check():
    """1 年分を手計算の式 (1+r)/(1+π)−1 と照合（ベクタ生成の配線ミスを検出）。"""
    doc, saved = _load()
    v = saved["combos"]["USD_SP500"]
    year = v["start_year"]
    r = doc["assets"]["SP500"]["values"][year - doc["assets"]["SP500"]["start_year"]]
    us = doc["macro"]["us_inflation"]
    pi = us["values"][year - us["start_year"]]
    assert v["values"][0] == (1.0 + r) / (1.0 + pi) - 1.0


def test_jpy_real_return_spot_check():
    doc, saved = _load()
    v = saved["combos"]["JPY_GOLD"]
    year = v["end_year"]
    g = doc["assets"]["GOLD"]
    fx, jp = doc["macro"]["usdjpy_change"], doc["macro"]["jp_inflation"]
    r = g["values"][year - g["start_year"]]
    d = fx["values"][year - fx["start_year"]]
    pi = jp["values"][year - jp["start_year"]]
    assert v["values"][-1] == (1.0 + r) * (1.0 + d) / (1.0 + pi) - 1.0

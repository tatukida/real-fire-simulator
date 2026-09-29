"""reference.generate_golden の検査。書き出しは pytest の一時フォルダだけに行う。"""

from __future__ import annotations

import json
from dataclasses import asdict

import numpy as np
import pytest
from reference import generate_golden as gg
from reference import simulate as sim

CASE_IDS = [f"{g}{i}" for g, k in zip("ABCDEF", (6, 4, 4, 1, 6, 3)) for i in range(1, k + 1)]
METHODS = ("historical", "bootstrap", "parametric")


@pytest.fixture(scope="module")
def out_dir(tmp_path_factory):
    d = tmp_path_factory.mktemp("golden")
    assert gg.main([str(d)]) == 0
    return d


def _case(out_dir, cid):
    return json.loads((out_dir / "cases" / f"{cid}.json").read_text(encoding="utf-8"))


def test_index_size_and_determinism(out_dir, tmp_path):
    index = json.loads((out_dir / "index.json").read_text(encoding="utf-8"))
    assert index["specVersion"] == "0.9"
    assert index["cases"] == CASE_IDS
    assert {"generatedAt", "python", "numpy"} <= index.keys()
    assert sorted(p.stem for p in (out_dir / "cases").iterdir()) == sorted(CASE_IDS)
    assert sum(p.stat().st_size for p in out_dir.rglob("*.json")) <= 500_000
    assert gg.main([]) == 2  # 出力先なしは使い方エラー
    gg.generate(tmp_path)  # 2 回目の生成とバイト単位で一致
    for cid in CASE_IDS:
        name = f"cases/{cid}.json"
        assert (tmp_path / name).read_bytes() == (out_dir / name).read_bytes()


def test_inputs_and_tolerances_follow_case_list(out_dir):
    fixture = json.loads(gg.VECTORS_FILE.read_text(encoding="utf-8"))["combos"]
    a4 = _case(out_dir, "A4")
    inp = a4["input"]
    assert (inp["initial"], inp["spending"], inp["fee"], inp["horizon"]) == (5e7, 2e6, 0.001, 30)
    assert inp["series"]["values"] == fixture["JPY_SP500"]["values"]
    assert _case(out_dir, "C2")["input"]["spending"] == 900_000
    assert [_case(out_dir, c)["input"]["fee"] for c in ("C3", "C4")] == [0.02, 0.0]
    seeds = [_case(out_dir, c)["input"]["seed"] for c in ("A1", "F1", "F2")]
    assert seeds == [20260929, 0, 4294967295]
    assert all(_case(out_dir, c)["input"]["paths"] == 1000 for c in CASE_IDS)
    tol = a4["tolerance"]
    rels = [tol[m]["valuesRel"] for m in METHODS]
    assert rels == [0.0, 1e-9, 1e-6]
    assert tol["bootstrap"]["successRateAbs"] == tol["solve"]["successRateAbs"] == 0.005


@pytest.mark.parametrize(
    ("cid", "n", "level"),
    [("A5", 20, "none"), ("E1", 20, "none"), ("E2", 19, "caution"), ("E3", 10, "caution"),
     ("E4", 9, "strong"), ("E5", 1, "strong"), ("B2", 1, "strong"), ("E6", 0, "noHistory"),
     ("B3", 0, "noHistory"), ("B4", 99, "none"), ("D1", 8, "strong")],
)  # fmt: skip
def test_start_count_and_warning_level(out_dir, cid, n, level):
    out = _case(out_dir, cid)["output"]
    assert (out["n"], out["warningLevel"]) == (n, level)
    assert (out["historical"] is None) == (n <= 0)


def test_outputs_recompute_from_embedded_input(out_dir):
    horizons = [30] * 6 + [1, 98, 99, 0] + [30] * 4 + [3, 35, 36, 45, 46, 54, 55, 30, 30, 31]
    for cid, horizon in zip(CASE_IDS, horizons):
        doc = _case(out_dir, cid)
        inp, out, full = doc["input"], doc["output"], doc["outputs"] == "all"
        v, t = np.array(inp["series"]["values"]), inp["horizon"]
        rng_args = (inp["paths"], inp["seed"])
        assert t == horizon, cid
        boot = sim.bootstrap_returns(v, t, *rng_args)
        para = None if cid == "D1" else sim.parametric_returns(v, t, *rng_args)
        for method, rets in zip(METHODS, (sim.historical_returns(v, t), boot, para)):
            if rets is None:
                assert out[method] is None, (cid, method)
                continue
            res = sim.run_engine(rets, inp["initial"], inp["spending"], inp["fee"])
            assert out[method]["successCount"] == int(res.success.sum()), (cid, method)
            assert not full or out[method]["percentiles"] == sim.percentiles(res.balances)
        if full:
            solved = sim.solve_spending(boot, inp["initial"], inp["fee"])
            assert out["solve"] == (solved and gg._camel(asdict(solved))), cid


def test_output_shapes_full_and_rate_only(out_dir):
    a1 = _case(out_dir, "A1")["output"]
    for method, count in (("historical", 69), ("bootstrap", 200), ("parametric", 200)):
        m = a1[method]
        sp, hist = m["samplePaths"], m["ruinHistogram"]
        assert sp["count"] == count and len(sp["first"]) == len(sp["last"]) == 31
        assert all(len(v) == 31 for v in m["percentiles"].values())
        assert len(hist["counts"]) == 30
        assert sum(hist["counts"]) + hist["endedAtZero"] + m["successCount"] == m["paths"]
    e1 = _case(out_dir, "E1")  # 成功率のみのケース
    assert e1["outputs"] == "success_rate_only" and "solve" not in e1["output"]
    assert set(e1["output"]["bootstrap"]) == {"successRate", "successCount", "paths"}


def test_special_cases_d1_and_zero_horizon(out_dir):
    out = _case(out_dir, "D1")["output"]
    assert out["historical"]["successRate"] == 0.5
    assert out["historical"]["ruinHistogram"] == {"counts": [0, 1, 1], "endedAtZero": 2}
    assert out["parametric"] is None and out["solve"] is None and "ln(1 + r)" in out["note"]
    assert 0.3 < out["bootstrap"]["successRate"] < 0.5
    out = _case(out_dir, "B4")["output"]  # T = 0
    solve = {"spending": 1e6, "successRate": 1.0, "upper": 1e6, "capped": True, "evaluations": 2}
    assert out["solve"] == solve
    assert out["historical"]["samplePaths"]["count"] == 99
    assert out["bootstrap"]["successRate"] == out["parametric"]["successRate"] == 1.0

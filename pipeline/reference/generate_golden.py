"""ゴールデンの生成（docs/golden-cases.md のケース）。

  cd pipeline && python -m reference.generate_golden <出力先>

出力先に index.json と cases/<ID>.json を書く。リポジトリの golden/ への書き出しは人間が行う。
系列は fixtures/real_returns_vectors.json（共通期間の実質リターン、信託報酬を引く前）の値を埋め込む。
"""

from __future__ import annotations

import json
import platform
import re
import sys
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from reference import simulate as sim

VECTORS_FILE = Path(__file__).parent / "fixtures" / "real_returns_vectors.json"

SPEC_VERSION = "0.9"
PATHS = 1000
DEFAULT_SEED = 20260929
INITIAL = {"USD": 1_000_000, "JPY": 50_000_000}
D1_SERIES = [0.05, 0.03, 0.04, 0.02, -1.0, 0.06, 0.01, 0.05, 0.04, -1.0]
# −100% の年で ln(1 + r) が −∞ になる（docs/golden-cases.md 未確認事項 1）
PARAMETRIC_NOTE_D1 = "パラメトリックは計算しない（−100% の年で ln(1 + r) が −∞ のため）"

# (ID, 系列, T, 生活費 % of 初期資産, 信託報酬, シード, 全項目か, 目的)
CASES: list[tuple[str, str, int, int, float, int, bool, str]] = [
    ("A1", "USD_SP500", 30, 4, 0.001, DEFAULT_SEED, True, "標準"),
    ("A2", "USD_WORLD_DM", 30, 4, 0.001, DEFAULT_SEED, True, "標準"),
    ("A3", "USD_GOLD", 30, 4, 0.001, DEFAULT_SEED, True, "標準"),
    ("A4", "JPY_SP500", 30, 4, 0.001, DEFAULT_SEED, True, "標準"),
    ("A5", "JPY_WORLD_DM", 30, 4, 0.001, DEFAULT_SEED, True, "標準（N = 20）"),
    ("A6", "JPY_GOLD", 30, 4, 0.001, DEFAULT_SEED, True, "標準"),
    ("B1", "USD_SP500", 1, 4, 0.001, DEFAULT_SEED, True, "T = 1"),
    ("B2", "USD_SP500", 98, 4, 0.001, DEFAULT_SEED, True, "T = 共通期間の年数（N = 1）"),
    ("B3", "USD_SP500", 99, 4, 0.001, DEFAULT_SEED, True, "T > 共通期間の年数（N = 0）"),
    ("B4", "USD_SP500", 0, 4, 0.001, DEFAULT_SEED, True, "T = 0（逆算は capped）"),
    ("C1", "USD_SP500", 30, 0, 0.001, DEFAULT_SEED, True, "生活費 0"),
    ("C2", "USD_SP500", 30, 90, 0.001, DEFAULT_SEED, True, "初期資産に近い生活費"),
    ("C3", "JPY_GOLD", 30, 4, 0.02, DEFAULT_SEED, True, "信託報酬の上限"),
    ("C4", "JPY_SP500", 30, 4, 0.0, DEFAULT_SEED, True, "信託報酬 0"),
    ("D1", "SYNTH_D1", 3, 0, 0.0, DEFAULT_SEED, True, "倍率 0、endedAtZero、逆算が null"),
    ("E1", "USD_GOLD", 35, 4, 0.001, DEFAULT_SEED, False, "N = 20（表示なし）"),
    ("E2", "USD_GOLD", 36, 4, 0.001, DEFAULT_SEED, False, "N = 19（注意）"),
    ("E3", "USD_GOLD", 45, 4, 0.001, DEFAULT_SEED, False, "N = 10（注意）"),
    ("E4", "USD_GOLD", 46, 4, 0.001, DEFAULT_SEED, False, "N = 9（強い注意）"),
    ("E5", "USD_GOLD", 54, 4, 0.001, DEFAULT_SEED, False, "N = 1（強い注意）"),
    ("E6", "USD_GOLD", 55, 4, 0.001, DEFAULT_SEED, False, "N = 0（ヒストリカルは null）"),
    ("F1", "USD_SP500", 30, 4, 0.001, 0, True, "シード 0"),
    ("F2", "USD_SP500", 30, 4, 0.001, 4294967295, True, "シード 4294967295（最大値）"),
    ("F3", "USD_SP500", 31, 4, 0.001, DEFAULT_SEED, True, "T = 31、最後のブロックを切り捨て"),
]

# 相対比較は |a − b| ≤ rel·max(|a|, |b|)（両方 0 なら一致）。成功率は割合（0〜1）で、0.005 = ±0.5 ポイント
TOLERANCE = {
    "relative_formula": "|a - b| <= rel * max(|a|, |b|)",
    "historical": {"success_rate_abs": 0.0, "values_rel": 0.0, "counts": "exact"},
    "bootstrap": {"success_rate_abs": 0.005, "values_rel": 1e-9, "counts": "successRate"},
    "parametric": {"success_rate_abs": 0.005, "values_rel": 1e-6, "counts": "successRate"},
    "solve": {"spending_rel": 1e-9, "upper_rel": 1e-9, "success_rate_abs": 0.005},
    "exact": ["n", "warningLevel", "solve.evaluations", "solve.capped", "solve is null"],
}


def load_series(name: str) -> dict:
    if name == "SYNTH_D1":
        return {"name": name, "start_year": None, "end_year": None, "values": D1_SERIES}
    combo = json.loads(VECTORS_FILE.read_text(encoding="utf-8"))["combos"][name]
    return {"name": name, **combo}


def method_output(returns: np.ndarray | None, inp: dict, full: bool, historical: bool):
    if returns is None:
        return None
    res = sim.run_engine(returns, inp["initial"], inp["spending"], inp["fee"])
    out: dict = {
        "success_rate": sim.success_rate(res),
        "success_count": int(res.success.sum()),
        "paths": len(res.success),
    }
    if full:
        samples = sim.sample_paths(res.balances, historical)
        counts, ended_at_zero = sim.ruin_histogram(res)
        out["percentiles"] = sim.percentiles(res.balances)
        first, last = samples[0].tolist(), samples[-1].tolist()
        out["sample_paths"] = {"count": len(samples), "first": first, "last": last}
        out["ruin_histogram"] = {"counts": counts, "ended_at_zero": ended_at_zero}
    return out


def build_case(case: tuple[str, str, int, int, float, int, bool, str]) -> dict:
    cid, name, horizon, pct, fee, seed, full, purpose = case
    series = load_series(name)
    currency = None if name == "SYNTH_D1" else name.split("_", 1)[0]
    initial = 1000 if currency is None else INITIAL[currency]
    inp = {
        "series": series,
        "currency": currency,
        "initial": initial,
        "spending": initial * pct // 100,
        "fee": fee,
        "horizon": horizon,
        "seed": seed,
        "paths": PATHS,
        "block_length": sim.BLOCK_LENGTH,
        "target_rate": sim.TARGET_RATE,
        "solve_rel_width": sim.SOLVE_REL_WIDTH,
    }
    values = np.asarray(series["values"], dtype=float)
    n = sim.start_count(len(values), horizon)
    boot = sim.bootstrap_returns(values, horizon, PATHS, seed)
    para = None if name == "SYNTH_D1" else sim.parametric_returns(values, horizon, PATHS, seed)
    output: dict = {
        "n": n,
        "warning_level": sim.warning_level(n),
        "historical": method_output(sim.historical_returns(values, horizon), inp, full, True),
        "bootstrap": method_output(boot, inp, full, False),
        "parametric": method_output(para, inp, full, False),
    }
    if full:
        solved = sim.solve_spending(boot, initial, fee)
        output["solve"] = None if solved is None else asdict(solved)
    if name == "SYNTH_D1":
        output["note"] = PARAMETRIC_NOTE_D1
    return {
        "id": cid,
        "purpose": purpose,
        "outputs": "all" if full else "success_rate_only",
        "input": inp,
        "tolerance": TOLERANCE,
        "output": output,
    }


def _camel(obj):
    """JSON のキーを camelCase にする（golden-cases.md の successRate・endedAtZero と同じ形）。"""
    if isinstance(obj, dict):
        return {re.sub(r"_([a-z])", lambda m: m[1].upper(), k): _camel(v) for k, v in obj.items()}
    return [_camel(v) for v in obj] if isinstance(obj, list) else obj


def _dump(path: Path, doc: dict) -> None:
    text = json.dumps(_camel(doc), ensure_ascii=False, allow_nan=False, indent=1)
    path.write_text(text + "\n", encoding="utf-8")


def generate(out_dir: Path) -> list[str]:
    (out_dir / "cases").mkdir(parents=True, exist_ok=True)
    ids = []
    for case in CASES:
        _dump(out_dir / "cases" / f"{case[0]}.json", build_case(case))
        ids.append(case[0])
    index = {
        "spec_version": SPEC_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "python": platform.python_version(),
        "numpy": np.__version__,
        "cases": ids,
    }
    _dump(out_dir / "index.json", index)
    return ids


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 1:
        print("usage: python -m reference.generate_golden <出力先>", file=sys.stderr)
        return 2
    out_dir = Path(args[0])
    ids = generate(out_dir)
    print(f"書き出し: {out_dir}（{len(ids)} ケース）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""実質リターン合成の共有ベクタ（TS と Python の一致確認用）。

  cd pipeline && PYTHONPATH=src python -m reference.real_vectors

data/processed/returns.json の全 通貨×資産 について、共通期間と fire_data.transform.real_return の結果を
fixtures/real_returns_vectors.json に書き出す。TS 側（web/tests/unit/data.test.ts）は同じファイルと照合する。
returns.json を作り直したら、このベクタも再生成すること（pytest が不一致を検出する）。
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from fire_data.transform import real_return

ROOT = Path(__file__).resolve().parents[2]
RETURNS_FILE = ROOT / "data" / "processed" / "returns.json"
VECTORS_FILE = Path(__file__).parent / "fixtures" / "real_returns_vectors.json"

ASSETS = ["SP500", "WORLD_DM", "GOLD"]
CURRENCIES = ["USD", "JPY"]
REQUIRED_MACRO = {"USD": ["us_inflation"], "JPY": ["usdjpy_change", "jp_inflation"]}


def _years(s: dict) -> range:
    return range(s["start_year"], s["start_year"] + len(s["values"]))


def _slice(s: dict, start: int, end: int) -> np.ndarray:
    i0 = start - s["start_year"]
    return np.asarray(s["values"][i0 : i0 + end - start + 1], dtype=float)


def make_vectors(doc: dict) -> dict:
    combos = {}
    for currency in CURRENCIES:
        for asset in ASSETS:
            req = [doc["assets"][asset]] + [doc["macro"][m] for m in REQUIRED_MACRO[currency]]
            common = set(_years(req[0])).intersection(*(_years(s) for s in req[1:]))
            start, end = min(common), max(common)
            assert len(common) == end - start + 1, "共通期間が連続していない"
            r = _slice(doc["assets"][asset], start, end)
            if currency == "USD":
                us = _slice(doc["macro"]["us_inflation"], start, end)
                real = real_return(r, us, currency="USD")
            else:
                real = real_return(
                    r,
                    None,
                    currency="JPY",
                    fx_change=_slice(doc["macro"]["usdjpy_change"], start, end),
                    jp_inflation=_slice(doc["macro"]["jp_inflation"], start, end),
                )
            combos[f"{currency}_{asset}"] = {
                "start_year": start,
                "end_year": end,
                "values": [float(v) for v in real],
            }
    return {
        "note": "PYTHONPATH=src python -m reference.real_vectors で生成。手で編集しない。",
        "returns_generated_at": doc["generated_at"],
        "combos": combos,
    }


def main() -> int:
    doc = json.loads(RETURNS_FILE.read_text(encoding="utf-8"))
    VECTORS_FILE.parent.mkdir(parents=True, exist_ok=True)
    VECTORS_FILE.write_text(json.dumps(make_vectors(doc)) + "\n", encoding="utf-8")
    print(f"書き出し: {VECTORS_FILE}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

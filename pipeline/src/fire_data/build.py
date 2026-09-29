"""生データ → data/processed/returns.json。

  python -m fire_data.build [--raw-dir data/raw] [--out data/processed/returns.json] [--allow-review]

既定では license_status == 'cleared' のソースだけを使う。--allow-review は開発時のみ。
配信前は必ず `python -m fire_data.validate --strict` を通すこと（needs-review 混入を弾く）。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from . import parse, transform
from .config import (
    ASSET_START_FLOOR,
    ASSETS,
    MIN_COUNTRIES_DM,
    NOTICE_FOOTER_JA,
    NOTICE_HEADER_JA,
    OUTPUT_FILE,
    RAW_DIR,
    SCHEMA_VERSION,
    SOURCES,
)


@dataclass
class RawData:
    damodaran: pd.DataFrame | None = None
    jst: pd.DataFrame | None = None
    fx: pd.Series | None = None
    us_cpi: pd.Series | None = None
    jp_cpi: pd.Series | None = None
    source_meta: dict[str, dict] = field(default_factory=dict)
    skipped: list[dict] = field(default_factory=list)


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_raw(raw_dir: Path = RAW_DIR, allowed: tuple[str, ...] = ("cleared",)) -> RawData:
    """ファイルを読む。ライセンス状態が許可外、またはファイルが無いソースはスキップして記録する。"""
    raw = RawData()

    loaders = {
        "DAMODARAN": lambda p: parse.read_damodaran_xls(p),
        "JST": lambda p: parse.read_jst_xlsx(p),
        "FRED_DEXJPUS": lambda p: parse.parse_fred_text(p.read_text(encoding="utf-8")),
        "FRED_CPIAUCNS": lambda p: parse.parse_fred_text(p.read_text(encoding="utf-8"), monthly=True),
        "JP_CPI": lambda p: parse.parse_level_csv(p.read_text(encoding="utf-8")),
    }
    attr = {
        "DAMODARAN": "damodaran",
        "JST": "jst",
        "FRED_DEXJPUS": "fx",
        "FRED_CPIAUCNS": "us_cpi",
        "JP_CPI": "jp_cpi",
    }
    for sid, src in SOURCES.items():
        if src.license_status not in allowed:
            raw.skipped.append({"source": sid, "reason": f"license_status={src.license_status}"})
            continue
        path = raw_dir / src.raw_file
        if not path.exists():
            raw.skipped.append({"source": sid, "reason": f"ファイルなし: {src.raw_file}"})
            continue
        setattr(raw, attr[sid], loaders[sid](path))
        raw.source_meta[sid] = {
            "label": src.label,
            "license_status": src.license_status,
            "license_note": src.license_note,
            "citation": src.citation,
            "raw_file": src.raw_file,
            "sha256": _sha256(path),
        }
    return raw


def _pack(series: pd.Series, source: str) -> dict:
    """年次 Series → {source, start_year, values}。欠番があればエラー。"""
    years = [int(y) for y in series.index]
    if not years:
        raise ValueError(f"{source}: 有効な年がありません")
    if years != list(range(years[0], years[-1] + 1)):
        gaps = sorted(set(range(years[0], years[-1] + 1)) - set(years))
        raise ValueError(f"{source}: 年が連続していません（欠番: {gaps[:5]}...）")
    return {
        "source": source,
        "start_year": years[0],
        "values": [round(float(v), 6) for v in series.to_numpy()],
    }


def inflation_alignment_check(damodaran_infl: pd.Series, us_inflation: dict) -> dict | None:
    """Damodaran のインフレ列と FRED CPI 由来のインフレを比べ、年のずれ（列・行のずれ）を検出する。

    year_offset o: Damodaran の y 年を FRED の y+o 年と比べたときの平均絶対差。
    正しく揃っていれば o=0 が最小になる。比較できる年が 20 未満なら None。
    """
    fred = pd.Series(
        us_inflation["values"],
        index=range(us_inflation["start_year"], us_inflation["start_year"] + len(us_inflation["values"])),
    )
    out: dict[str, float] = {}
    n0 = 0
    for off in (-1, 0, 1):
        shifted = damodaran_infl.copy()
        shifted.index = shifted.index + off
        joined = pd.concat([shifted, fred], axis=1, join="inner").dropna()
        if len(joined) < 20:
            return None
        out[str(off)] = round(float((joined.iloc[:, 0] - joined.iloc[:, 1]).abs().mean()), 6)
        if off == 0:
            n0 = len(joined)
    return {"years_compared": n0, "mean_abs_diff_by_year_offset": out}


def build_attribution(used_source_ids: set[str]) -> dict:
    """使用したソースだけから、画面表示用の出所・加工表記を組み立てる。"""
    items = []
    processing = []
    for sid, src in SOURCES.items():  # 定義順で固定
        if sid in used_source_ids:
            items.append({"id": sid, "text_ja": src.attribution_ja, "text_en": src.attribution_en})
            if src.processing_ja:
                processing.append(src.processing_ja)
    notice = NOTICE_HEADER_JA + "".join(f"\n・{it['text_ja']}" for it in items)
    notice += "\n" + NOTICE_FOOTER_JA
    if processing:
        notice += "\n" + "".join(processing)
    return {"notice_ja": notice, "items": items}


def assemble(raw: RawData, generated_at: str | None = None) -> dict:
    """RawData → 出力ドキュメント（純粋関数）。"""
    assets: dict[str, dict] = {}
    macro: dict[str, dict] = {}

    if raw.damodaran is not None:
        d = raw.damodaran
        sp500 = d["sp500"].dropna()
        assets["SP500"] = {"label": ASSETS["SP500"][0], **_pack(sp500, "DAMODARAN")}
        gold = d["gold"].dropna()
        floor_year, floor_reason = ASSET_START_FLOOR["GOLD"]
        gold = gold[gold.index >= floor_year]
        assets["GOLD"] = {
            "label": ASSETS["GOLD"][0],
            **_pack(gold, "DAMODARAN"),
            "notes": [floor_reason],
        }

    if raw.jst is not None:
        dm = transform.dm_equity_usd(raw.jst, MIN_COUNTRIES_DM)
        floor_year, floor_reason = ASSET_START_FLOOR["WORLD_DM"]
        dm = dm[dm.index >= floor_year]
        assets["WORLD_DM"] = {
            "label": ASSETS["WORLD_DM"][0],
            **_pack(dm, "JST"),
            "notes": [
                floor_reason,
                f"各年、有効な国が {MIN_COUNTRIES_DM} か国以上ある年のみ、国別USDリターンの等ウェイト平均",
            ],
        }

    if raw.us_cpi is not None:
        us_infl = transform.annual_change(transform.year_end_levels(raw.us_cpi))
        macro["us_inflation"] = _pack(us_infl, "FRED_CPIAUCNS")

    if raw.fx is not None:
        fx = transform.annual_change(transform.year_end_levels(raw.fx))
        macro["usdjpy_change"] = _pack(fx, "FRED_DEXJPUS")

    if raw.jp_cpi is not None:
        jp = transform.annual_change(transform.year_end_levels(raw.jp_cpi))
        macro["jp_inflation"] = _pack(jp, "JP_CPI")

    checks: dict = {}
    if raw.damodaran is not None and "us_inflation" in macro:
        chk = inflation_alignment_check(raw.damodaran["inflation"].dropna(), macro["us_inflation"])
        if chk is not None:
            checks["damodaran_inflation_vs_fred_cpi"] = chk

    used = {o["source"] for o in list(assets.values()) + list(macro.values())}
    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": generated_at or datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "units": (
            "annual calendar-year decimal returns (0.05 = 5%). assets: nominal USD total return. "
            "macro.us_inflation / jp_inflation: Dec/Dec CPI change. "
            "macro.usdjpy_change: JPY-per-USD Dec/Dec change (positive = yen weaker)."
        ),
        "assets": assets,
        "macro": macro,
        "checks": checks,
        "attribution": build_attribution(used),
        "sources": raw.source_meta,
        "skipped": raw.skipped,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--raw-dir", type=Path, default=RAW_DIR)
    ap.add_argument("--out", type=Path, default=OUTPUT_FILE)
    ap.add_argument(
        "--allow-review",
        action="store_true",
        help="license_status=needs-review のソースも含める（開発用。配信前は --strict 検証で弾く）",
    )
    args = ap.parse_args(argv)

    allowed = ("cleared", "needs-review") if args.allow_review else ("cleared",)
    raw = load_raw(args.raw_dir, allowed)
    doc = assemble(raw)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps(doc, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8"
    )
    print(f"書き出し: {args.out}（{args.out.stat().st_size} bytes）")
    print(f"アセット: {sorted(doc['assets'])}  マクロ: {sorted(doc['macro'])}")
    for s in doc["skipped"]:
        print(f"  スキップ: {s['source']} — {s['reason']}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

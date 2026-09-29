"""returns.json の品質検証。

  python -m fire_data.validate [--strict] [path]

errors  : 1件でもあれば終了コード 1（配信不可）。
warnings: 目視確認用（パース誤り・1か月ずれ等の兆候を、広い許容範囲で検出）。
--strict: 含まれる全ソースが license_status == 'cleared' であることを追加で要求（デプロイ時に使う）。
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

from .config import MAX_OUTPUT_BYTES, OUTPUT_FILE, SCHEMA_VERSION

ASSET_RANGE = (-0.95, 3.0)  # 年次名目リターンとして許容する範囲
INFLATION_RANGE = (-0.30, 5.0)
FX_RANGE = (-0.50, 1.00)
REQUIRED_MACRO = ("us_inflation",)

# 広めのサニティ範囲（年, 下限, 上限）。外れたら warning。
GOLD_SANITY = [
    (1979, 0.80, 1.80),  # 第二次オイルショック前後の急騰（約+126%）
    (1981, -0.50, -0.20),  # 急落（約-32%）
]
DM_SANITY = [
    (2008, -0.65, -0.25),  # 世界金融危機（等ウェイト・USD建て）
    (2009, 0.15, 0.90),
]
SP500_SANITY = [
    (1931, -0.70, -0.25),  # 大恐慌
    (1933, 0.20, 0.90),
    (2008, -0.50, -0.25),
]


def _check_series(name: str, obj: dict, lo: float, hi: float, errors: list[str]) -> None:
    if not isinstance(obj, dict) or "values" not in obj or "start_year" not in obj:
        errors.append(f"{name}: start_year / values がありません")
        return
    start, values = obj["start_year"], obj["values"]
    if not isinstance(start, int) or not (1800 <= start <= 2100):
        errors.append(f"{name}: start_year が不正: {start!r}")
    if not values:
        errors.append(f"{name}: values が空です")
        return
    current_year = datetime.now(timezone.utc).year
    if isinstance(start, int) and start + len(values) - 1 >= current_year:
        errors.append(f"{name}: 未完了の年（{start + len(values) - 1}）を含んでいます")
    for i, v in enumerate(values):
        if not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v):
            errors.append(f"{name}[{i}]: 数値でない/非有限: {v!r}")
        elif not (lo < v < hi):
            errors.append(f"{name}[{i}] (年{start + i}): 範囲外 {v} (許容 {lo}〜{hi})")


def validate_doc(doc: dict, raw_bytes: int | None = None, strict: bool = False) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []

    if doc.get("schema_version") != SCHEMA_VERSION:
        errors.append(f"schema_version が {SCHEMA_VERSION} ではありません: {doc.get('schema_version')!r}")

    assets, macro = doc.get("assets", {}), doc.get("macro", {})
    if not assets:
        errors.append("assets が空です")
    for name, obj in assets.items():
        _check_series(f"assets.{name}", obj, *ASSET_RANGE, errors)
    for name in REQUIRED_MACRO:
        if name not in macro:
            errors.append(f"macro.{name} がありません（実質化に必須）")
    ranges = {"us_inflation": INFLATION_RANGE, "jp_inflation": INFLATION_RANGE, "usdjpy_change": FX_RANGE}
    for name, obj in macro.items():
        lo, hi = ranges.get(name, (-1.0, 10.0))
        _check_series(f"macro.{name}", obj, lo, hi, errors)

    # 円建て可否の注意
    if "usdjpy_change" not in macro or "jp_inflation" not in macro:
        warnings.append("円建て（JPY）に必要な usdjpy_change / jp_inflation が揃っていません")

    # 各アセットが参照するソースが sources に存在するか
    sources = doc.get("sources", {})
    for section in (assets, macro):
        for name, obj in section.items():
            if isinstance(obj, dict) and obj.get("source") not in sources:
                errors.append(f"{name}: source '{obj.get('source')}' が sources に記録されていません")

    # 出所・加工表記（画面表示用）。使用したソースすべてに表記があり、加工表記が含まれること
    used = {o.get("source") for sec in (assets, macro) for o in sec.values() if isinstance(o, dict)}
    attr = doc.get("attribution")
    if not isinstance(attr, dict) or not attr.get("notice_ja") or not attr.get("items"):
        errors.append("attribution（出所・加工表記）がありません")
    else:
        listed = {it.get("id") for it in attr["items"]}
        for sid in sorted(x for x in used if x):
            if sid not in listed:
                errors.append(f"attribution: 使用ソース {sid} の出所表記がありません")
        for it in attr["items"]:
            if not it.get("text_ja") or not it.get("text_en"):
                errors.append(f"attribution: {it.get('id')} の日本語/英語表記が空です")
        notice = attr["notice_ja"]
        if "開発者が独自に" not in notice:
            errors.append("attribution: 「開発者が独自に加工」の旨の記載がありません")
        if "JST" in used:
            for phrase in ("Jordà", "CC BY-NC-SA 4.0", "非営利", "等ウェイト"):
                if phrase not in notice:
                    errors.append(f"attribution: JSTの表記に「{phrase}」がありません")
        if "JP_CPI" in used:
            for phrase in ("総務省統計局", "消費者物価指数", "開発者が独自に計算・加工"):
                if phrase not in notice:
                    errors.append(f"attribution: 日本CPIの表記に「{phrase}」がありません")

    if strict:
        for sid, meta in sources.items():
            if meta.get("license_status") != "cleared":
                errors.append(f"strict: ソース {sid} の license_status が '{meta.get('license_status')}'")

    # サニティ（SP500）
    sp = assets.get("SP500")
    if isinstance(sp, dict) and "values" in sp:
        for year, lo, hi in SP500_SANITY:
            i = year - sp["start_year"]
            if 0 <= i < len(sp["values"]) and not (lo <= sp["values"][i] <= hi):
                warnings.append(
                    f"SP500 {year}年 = {sp['values'][i]:+.1%} は想定範囲 {lo:+.0%}〜{hi:+.0%} の外です"
                    "（列ずれ・1か月ずれの可能性）"
                )

    dm = assets.get("WORLD_DM")
    if isinstance(dm, dict) and "values" in dm:
        for year, lo, hi in DM_SANITY:
            i = year - dm["start_year"]
            if 0 <= i < len(dm["values"]) and not (lo <= dm["values"][i] <= hi):
                warnings.append(
                    f"WORLD_DM {year}年 = {dm['values'][i]:+.1%} は想定範囲 {lo:+.0%}〜{hi:+.0%} の外です"
                    "（列ずれ・為替の向きの誤りの可能性）"
                )

    gd = assets.get("GOLD")
    if isinstance(gd, dict) and "values" in gd:
        for year, lo, hi in GOLD_SANITY:
            i = year - gd["start_year"]
            if 0 <= i < len(gd["values"]) and not (lo <= gd["values"][i] <= hi):
                warnings.append(
                    f"GOLD {year}年 = {gd['values'][i]:+.1%} は想定範囲 {lo:+.0%}〜{hi:+.0%} の外です"
                    "（列ずれ・年ずれの可能性）"
                )

    # Damodaran のインフレ列と FRED CPI の突き合わせ（年ずれの検出）
    chk = doc.get("checks", {}).get("damodaran_inflation_vs_fred_cpi")
    if chk:
        by_off = chk["mean_abs_diff_by_year_offset"]
        best = min(by_off, key=by_off.get)
        if best != "0" and by_off[best] < by_off["0"] - 1e-9:
            warnings.append(f"インフレ突き合わせ: 年オフセット {best} の方が一致（{by_off}）。年がずれている疑い")
        if by_off["0"] > 0.01:
            warnings.append(
                f"インフレ突き合わせ: Damodaran と FRED CPI の平均絶対差が {by_off['0']:.2%} と大きい"
                "（定義の違い〔年平均/12月比〕か、パース誤りの可能性）"
            )

    if raw_bytes is not None and raw_bytes > MAX_OUTPUT_BYTES:
        errors.append(f"ファイルサイズ {raw_bytes} bytes が上限 {MAX_OUTPUT_BYTES} を超えています")
    return errors, warnings


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("path", nargs="?", type=Path, default=OUTPUT_FILE)
    ap.add_argument("--strict", action="store_true")
    args = ap.parse_args(argv)

    raw_text = args.path.read_text(encoding="utf-8")
    errors, warnings = validate_doc(json.loads(raw_text), len(raw_text.encode("utf-8")), args.strict)
    for w in warnings:
        print(f"WARN  {w}", file=sys.stderr)
    for e in errors:
        print(f"ERROR {e}", file=sys.stderr)
    print(f"検証: エラー {len(errors)} 件 / 警告 {len(warnings)} 件")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())

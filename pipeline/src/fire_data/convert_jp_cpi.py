"""総務省統計局（e-Stat）の「品目別価格指数（全国・月次）」CSV → data/raw/manual/jp_cpi.csv（date,value）。

  python -m fire_data.convert_jp_cpi <統計局のCSV> [--out data/raw/manual/jp_cpi.csv]

入力: 行 = 年月（YYYYMM）、列 = 品目。見出し行の '総合' 列を使う。文字コードは CP932 / UTF-8 を自動判定。
出力: 見出し 'date,value'、日付は 'YYYY-MM'（月次）。年月が欠けている・重複している場合はエラー。
"""

from __future__ import annotations

import argparse
import csv
import io
import re
import sys
from pathlib import Path

from .config import RAW_DIR

_YM = re.compile(r"^\s*(\d{4})(\d{2})\s*$")


def _decode(raw: bytes) -> str:
    for enc in ("utf-8-sig", "cp932"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    raise ValueError("文字コードを判定できません（UTF-8 / CP932 以外）")


def convert(text: str) -> list[tuple[str, float]]:
    """統計局CSVのテキスト → [('YYYY-MM', 指数), ...]（昇順）。"""
    rows = list(csv.reader(io.StringIO(text)))
    header_idx = next((i for i, r in enumerate(rows) if r and r[0].strip() == "類・品目"), None)
    if header_idx is None:
        raise ValueError("見出し行（先頭セルが '類・品目'）が見つかりません")
    cols = [j for j, c in enumerate(rows[header_idx]) if c.strip() == "総合"]
    if len(cols) != 1:
        raise ValueError(f"'総合' 列が1つではありません: {cols}")
    col = cols[0]

    out: list[tuple[str, float]] = []
    for r in rows[header_idx + 1 :]:
        m = _YM.match(r[0]) if r else None
        if not m:
            continue
        year, month = int(m.group(1)), int(m.group(2))
        if not 1 <= month <= 12:
            raise ValueError(f"月が不正です: {r[0]!r}")
        try:
            value = float(r[col])
        except (ValueError, IndexError):
            raise ValueError(f"{r[0].strip()} の総合が数値ではありません: {r[col:col + 1]!r}") from None
        if value <= 0:
            raise ValueError(f"{r[0].strip()} の総合が 0 以下です: {value}")
        out.append((f"{year:04d}-{month:02d}", value))
    if not out:
        raise ValueError("年月の行（YYYYMM）が見つかりません")

    keys = [k for k, _ in out]
    if len(set(keys)) != len(keys):
        raise ValueError("年月が重複しています")
    out.sort()
    expected = []
    y, m = int(keys[0][:4]), int(keys[0][5:])
    last = out[-1][0]
    while True:
        expected.append(f"{y:04d}-{m:02d}")
        if expected[-1] == last:
            break
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    missing = sorted(set(expected) - set(keys))
    if missing:
        raise ValueError(f"欠けている月があります: {missing[:6]}...")
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("src", type=Path, help="統計局のCSV（品目別価格指数・全国・月次）")
    ap.add_argument("--out", type=Path, default=RAW_DIR / "manual" / "jp_cpi.csv")
    args = ap.parse_args(argv)

    series = convert(_decode(args.src.read_bytes()))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        "date,value\n" + "".join(f"{d},{v}\n" for d, v in series), encoding="utf-8"
    )
    print(f"書き出し: {args.out}（{len(series)} か月: {series[0][0]}〜{series[-1][0]}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())

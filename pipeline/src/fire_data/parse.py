"""生データのパーサ。すべて「正規化された pandas オブジェクト」を返す。

ファイルI/Oと解析ロジックを分け、解析部分は文字列/DataFrameを受け取るので合成データでテストできる。
"""

from __future__ import annotations

import io
import re
from pathlib import Path

import numpy as np
import pandas as pd

# ---------- FRED ----------


def parse_fred_text(text: str, monthly: bool = False) -> pd.Series:
    """FRED の CSV（1列目: 日付, 2列目: 値, 欠損は '.'）→ Timestamp index の Series。

    monthly=True: FRED の月次系列は日付が月初（例 2020-12-01）なので、月末に直す
    （年末判定 year_end_levels が「12月の後半」を要求するため）。
    """
    df = pd.read_csv(io.StringIO(text), dtype=str)
    if df.shape[1] < 2:
        raise ValueError("FRED CSV: 列が足りません")
    dates = pd.to_datetime(df.iloc[:, 0], format="%Y-%m-%d")
    values = pd.to_numeric(df.iloc[:, 1].replace(".", pd.NA), errors="coerce")
    idx = pd.DatetimeIndex(dates)
    if monthly:
        idx = idx.to_period("M").to_timestamp(how="end").normalize()
    return pd.Series(values.to_numpy(), index=idx).sort_index()


# ---------- 手動配置の水準系列（ゴールド・日本CPI等） ----------


def _parse_date_token(tok: str) -> pd.Timestamp:
    tok = tok.strip()
    if re.fullmatch(r"\d{4}", tok):  # 年 → 年末
        return pd.Timestamp(year=int(tok), month=12, day=31)
    if re.fullmatch(r"\d{4}-\d{2}", tok):  # 年月 → 月末
        return pd.Period(tok, freq="M").end_time.normalize()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", tok):
        return pd.Timestamp(tok)
    raise ValueError(f"日付形式が不正です: {tok!r}（YYYY / YYYY-MM / YYYY-MM-DD）")


def parse_level_csv(text: str) -> pd.Series:
    """手動配置CSV（見出し: date,value）→ Timestamp index の Series。

    'YYYY' は年末の水準として扱う（年次データは年末値を入れること）。
    """
    df = pd.read_csv(io.StringIO(text), dtype=str)
    cols = [c.strip().lower() for c in df.columns]
    if cols[:2] != ["date", "value"]:
        raise ValueError(f"見出しは 'date,value' にしてください（現在: {list(df.columns)}）")
    dates = [_parse_date_token(t) for t in df.iloc[:, 0]]
    values = pd.to_numeric(df.iloc[:, 1], errors="coerce")
    s = pd.Series(values.to_numpy(), index=pd.DatetimeIndex(dates)).sort_index()
    if s.index.has_duplicates:
        raise ValueError("手動CSV: 日付が重複しています")
    return s


# ---------- Damodaran: histretSP.xls（年次リターン表） ----------


def _norm(v) -> str:
    return " ".join(v.split()).lower() if isinstance(v, str) else ""


def read_damodaran_xls(path: Path) -> pd.DataFrame:
    """histretSP.xls の全シートを走査し、最初に解析できたシートを採用する（xlrd が必要）。"""
    sheets = pd.read_excel(path, sheet_name=None, header=None, engine="xlrd")
    errors: list[str] = []
    for name, raw in sheets.items():
        try:
            return parse_damodaran_returns(raw)
        except ValueError as e:
            errors.append(f"{name}: {e}")
    raise ValueError("Damodaran: 解析できるシートがありません\n" + "\n".join(errors))


def parse_damodaran_returns(raw: pd.DataFrame) -> pd.DataFrame:
    """年次リターン表 → index=年(int), 列 sp500 / gold / inflation（小数。inflation は無ければ NaN）。

    - 見出し行: 'S&P 500' で始まるセルと 'Gold' で始まるセルの両方がある最初の行。
    - 列: 最も左の 'Gold' 列までの名目リターンのブロックから読む（右側の累積値・実質値等は読まない）。
    - データ行: 年の列が整数の年（1800〜2100）の連続行。要約行（平均など）で終了。
    - 単位: 絶対値の最大が 5 を超える場合は % 表記とみなし 100 で割る。
    """
    header_row = None
    for i in range(min(len(raw), 80)):
        cells = [_norm(v) for v in raw.iloc[i]]
        if any(c.startswith("s&p 500") for c in cells) and any(c.startswith("gold") for c in cells):
            header_row = i
            break
    if header_row is None:
        raise ValueError("見出し行（S&P 500 と Gold を含む行）が見つかりません")
    cells = [_norm(v) for v in raw.iloc[header_row]]

    def pick(pred, label: str, required: bool = True) -> int | None:
        cols = [j for j, c in enumerate(cells) if pred(c)]
        if len(cols) > 1:
            raise ValueError(f"列 '{label}' が複数見つかりました: {cols}")
        if not cols:
            if required:
                raise ValueError(f"列 '{label}' が見つかりません")
            return None
        return cols[0]

    # 実ファイルは、名目リターンの右に累積値・実質リターン・リスクプレミアム等のブロックが続き、
    # 'S&P 500' や 'Gold' で始まる見出しが繰り返される。最も左（名目リターン）の Gold 列までを
    # 名目ブロックとみなし、その中の 'S&P 500' で始まる列が1つであることを要求する。
    gold_cols = [j for j, c in enumerate(cells) if c.startswith("gold")]
    if not gold_cols:
        raise ValueError("列 'Gold' が見つかりません")
    c_gold = gold_cols[0]
    sp_cols = [j for j, c in enumerate(cells[: c_gold + 1]) if c.startswith("s&p 500")]
    if not sp_cols:
        raise ValueError("列 'S&P 500' が Gold 列より左に見つかりません")
    if len(sp_cols) > 1:
        raise ValueError(f"列 'S&P 500' が複数見つかりました: {sp_cols}")
    c_sp = sp_cols[0]
    c_inf = pick(lambda c: "inflation" in c, "Inflation", required=False)
    year_cols = [j for j, c in enumerate(cells) if c == "year"]
    c_year = year_cols[0] if year_cols else 0

    def num(v) -> float:
        x = pd.to_numeric(v, errors="coerce")
        return float(x) if pd.notna(x) else float("nan")

    rows: dict[int, tuple[float, float, float]] = {}
    started = False
    for i in range(header_row + 1, len(raw)):
        y = pd.to_numeric(raw.iat[i, c_year], errors="coerce")
        is_year = pd.notna(y) and float(y) == int(y) and 1800 <= int(y) <= 2100
        if not is_year:
            if started:
                break
            continue
        started = True
        year = int(y)
        if year in rows:
            raise ValueError(f"年 {year} が重複しています")
        rows[year] = (
            num(raw.iat[i, c_sp]),
            num(raw.iat[i, c_gold]),
            num(raw.iat[i, c_inf]) if c_inf is not None else float("nan"),
        )
    if not rows:
        raise ValueError("年次データ行が見つかりません")

    df = pd.DataFrame.from_dict(rows, orient="index", columns=["sp500", "gold", "inflation"]).sort_index()
    if np.nanmax(np.abs(df.to_numpy())) > 5:  # % 表記
        df = df / 100.0
    return df


# ---------- JST Macrohistory Database（年次・国別パネル） ----------


def read_jst_xlsx(path: Path) -> pd.DataFrame:
    """JSTdatasetR6.xlsx の全シートから、year/country/eq_tr/xrusd を持つシートを採用する（openpyxl が必要）。"""
    sheets = pd.read_excel(path, sheet_name=None, engine="openpyxl")
    errors: list[str] = []
    for name, df in sheets.items():
        try:
            return parse_jst_panel(df)
        except ValueError as e:
            errors.append(f"{name}: {e}")
    raise ValueError("JST: 解析できるシートがありません\n" + "\n".join(errors))


def parse_jst_panel(df: pd.DataFrame) -> pd.DataFrame:
    """JST のパネル → 列 year(int), country(str), eq_tr, xrusd（小数・現地通貨/USD）。

    eq_tr: 株式総合リターン（名目・現地通貨、小数）、xrusd: 現地通貨/USD。欠損は NaN。
    """
    cols = {str(c).strip().lower(): c for c in df.columns}
    need = ("year", "country", "eq_tr", "xrusd")
    missing = [n for n in need if n not in cols]
    if missing:
        raise ValueError(f"列が見つかりません: {missing}")
    out = pd.DataFrame(
        {
            "year": pd.to_numeric(df[cols["year"]], errors="coerce"),
            "country": df[cols["country"]].astype(str).str.strip(),
            "eq_tr": pd.to_numeric(df[cols["eq_tr"]], errors="coerce"),
            "xrusd": pd.to_numeric(df[cols["xrusd"]], errors="coerce"),
        }
    ).dropna(subset=["year"])
    out["year"] = out["year"].astype(int)
    if out.duplicated(["year", "country"]).any():
        raise ValueError("year × country が重複しています")
    if out["eq_tr"].notna().sum() == 0:
        raise ValueError("eq_tr に有効な値がありません")
    # % 表記の疑い（リターンは小数のはず）。戦間期ドイツのハイパーインフレ等の極端な外れ値があるため、
    # 最大値ではなく中央値で判定する（実ファイルの中央値の絶対値は 0.1 前後）。
    if out["eq_tr"].abs().median() > 1.0:
        raise ValueError("eq_tr が小数表記ではない可能性があります（絶対値の中央値が大きすぎます）")
    return out.reset_index(drop=True)

"""年次化・リターン計算・通貨/実質の合成（純粋関数）。

規約:
  - 年次リターンは「暦年（前年末→当年末）」。データが年末まで揃わない年は捨てる。
  - リターンは小数（0.05 = 5%）。
  - 実質化と円建て化はここで一箇所に定義し、TS 実装（web/src/core）はこれと同じ式を使う。
"""

from __future__ import annotations

import numpy as np
import pandas as pd


def year_end_levels(levels: pd.Series) -> pd.Series:
    """Timestamp index の水準系列 → {年: 年末値}。

    年の最後の観測が 12/24 以降のときだけ「年末まで揃った」とみなす（日次データの年末休場を許容）。
    """
    s = levels.dropna().sort_index()
    if s.empty:
        return pd.Series(dtype=float)
    idx = pd.DatetimeIndex(s.index)
    out: dict[int, float] = {}
    for year, grp in s.groupby(idx.year):
        last = grp.index[-1]
        if last.month == 12 and last.day >= 24:
            out[int(year)] = float(grp.iloc[-1])
    return pd.Series(out, dtype=float).sort_index()


def annual_change(year_end: pd.Series) -> pd.Series:
    """年末値 → 年次変化率。前年の年末値が存在する年のみ。"""
    out: dict[int, float] = {}
    for year, value in year_end.items():
        prev = year_end.get(year - 1)
        if prev is not None and prev > 0:
            out[int(year)] = float(value / prev - 1.0)
    return pd.Series(out, dtype=float).sort_index()


def dm_equity_usd(panel: pd.DataFrame, min_countries: int) -> pd.Series:
    """国別パネル（year, country, eq_tr, xrusd）→ 先進国株式の年次USDリターン（等ウェイト平均）。

    国 c・年 t の USD リターン = (1 + eq_tr) × (xrusd[t-1] / xrusd[t]) − 1
    （xrusd は 現地通貨/USD。現地通貨高 = xrusd 低下 → USD リターンが上がる）。
    eq_tr と前年・当年の xrusd がそろう国だけを使い、その年に有効な国が min_countries 未満なら
    その年は捨てる。
    """
    df = panel.sort_values(["country", "year"]).copy()
    prev = df.groupby("country")["xrusd"].shift(1)
    prev_year = df.groupby("country")["year"].shift(1)
    consecutive = prev_year == df["year"] - 1
    df["usd"] = (1.0 + df["eq_tr"]) * (prev / df["xrusd"]) - 1.0
    df.loc[~consecutive, "usd"] = np.nan
    df = df[df["usd"].notna() & np.isfinite(df["usd"])]
    g = df.groupby("year")["usd"]
    out = g.mean()[g.count() >= min_countries]
    return out.astype(float).sort_index()


def real_return(nominal_usd, us_inflation, *, currency: str, fx_change=None, jp_inflation=None):
    """名目USDリターン → 実質リターン（スカラーでも numpy 配列でも可）。

    USD: (1+r) / (1+π_US) - 1
    JPY: (1+r) * (1+Δfx) / (1+π_JP) - 1   （Δfx = 円/ドルの年次変化率。円安で正）
    """
    if currency == "USD":
        return (1.0 + np.asarray(nominal_usd)) / (1.0 + np.asarray(us_inflation)) - 1.0
    if currency == "JPY":
        if fx_change is None or jp_inflation is None:
            raise ValueError("JPY には fx_change と jp_inflation が必要です")
        return (
            (1.0 + np.asarray(nominal_usd))
            * (1.0 + np.asarray(fx_change))
            / (1.0 + np.asarray(jp_inflation))
            - 1.0
        )
    raise ValueError(f"未対応の通貨: {currency}")

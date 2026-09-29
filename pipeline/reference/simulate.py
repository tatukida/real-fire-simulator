"""シミュレーションの Python 参照実装（ゴールデン生成用）。

根拠は docs/spec.md（v0.8）、docs/adr/0003-*.md、docs/golden-cases.md のみ。TS 実装は参照しない。
金額・リターンはすべて実質。系列は共通期間の実質リターン（信託報酬を引く前）。
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from reference.prng import Xoshiro128

BLOCK_LENGTH = 3
CAUTION_N = 20
STRONG_N = 10


@dataclass(frozen=True)
class EngineResult:
    balances: np.ndarray  # (paths, T+1)。年 0〜T の年末残高。破産後は 0
    ruin_year: np.ndarray  # (paths,)。破産した年（1〜T）。破産していなければ 0
    success: np.ndarray  # (paths,)。期間終了時に残高 > 0
    ended_at_zero: np.ndarray  # (paths,)。破産年を持たず、終了時に残高 0（T 年目に倍率 0）


def run_engine(returns: np.ndarray, initial: float, spending: float, fee: float) -> EngineResult:
    """returns は (paths, T) の実質リターン。年ごとに 期初に取り崩し → 倍率を掛ける（spec 3.1）。

    取り崩し後の残高が 0 以下なら、その年に破産し以降 0（spec 3.1）。
    倍率は max(0, 1 + r − fee)（決定済み 3）。倍率 0 の年の後は残高 0 で、翌年に破産する（決定済み 12）。
    """
    returns = np.asarray(returns, dtype=float)
    paths, years = returns.shape
    balances = np.zeros((paths, years + 1))
    balances[:, 0] = initial
    ruin_year = np.zeros(paths, dtype=np.int64)
    balance = balances[:, 0].copy()
    for t in range(1, years + 1):
        after = balance - spending
        newly = (ruin_year == 0) & (after <= 0)
        ruin_year[newly] = t
        multiplier = np.maximum(0.0, (1.0 + returns[:, t - 1]) - fee)
        balance = np.where(ruin_year > 0, 0.0, after * multiplier)
        balances[:, t] = balance
    success = balance > 0
    ended_at_zero = (ruin_year == 0) & ~success
    return EngineResult(balances, ruin_year, success, ended_at_zero)


def start_count(n_years: int, horizon: int) -> int:
    """ヒストリカルの開始年数 N = 共通期間の年数 − T + 1（spec 4章 項目9）。"""
    return n_years - horizon + 1


def warning_level(n: int) -> str:
    """注意段階（spec 4章 項目9、決定済み 10、ADR-0003 決定 4）。"""
    if n <= 0:
        return "noHistory"
    if n < STRONG_N:
        return "strong"
    if n < CAUTION_N:
        return "caution"
    return "none"


def historical_returns(series: np.ndarray, horizon: int) -> np.ndarray | None:
    """開始年 0〜N−1 の窓を順に並べる。N ≤ 0 なら None（決定済み 10）。"""
    series = np.asarray(series, dtype=float)
    n = start_count(len(series), horizon)
    if n <= 0:
        return None
    return np.array([series[s : s + horizon] for s in range(n)], dtype=float).reshape(n, horizon)


def bootstrap_returns(
    series: np.ndarray, horizon: int, paths: int, seed: int, block: int = BLOCK_LENGTH
) -> np.ndarray:
    """循環ブロック・ブートストラップ（決定済み 4・11）。

    パスごとに ceil(T / L) 個のブロック開始位置を next_int(n) で順に選び、(start + k) mod n をつないで
    先頭 T 年を使う。PRNG はこの手法専用にシードから初期化する。
    """
    series = np.asarray(series, dtype=float)
    n = len(series)
    rng = Xoshiro128.from_seed(seed)
    blocks = math.ceil(horizon / block)
    idx = np.empty((paths, blocks * block), dtype=np.int64)
    for p in range(paths):
        for b in range(blocks):
            start = rng.next_int(n)
            for k in range(block):
                idx[p, b * block + k] = (start + k) % n
    return series[idx[:, :horizon]]


def log_moments(series: np.ndarray) -> tuple[float, float]:
    """ln(1 + r_real) の標本平均と標本標準偏差（自由度 n−1）（決定済み 5）。"""
    series = np.asarray(series, dtype=float)
    if np.any(1.0 + series <= 0):
        # golden-cases.md 未確認事項 1: spec に定めがないため計算しない
        raise ValueError("1 + r_real ≤ 0 の年を含む系列はパラメトリックで扱いが未定義")
    logs = np.log(1.0 + series)
    return float(np.mean(logs)), float(np.std(logs, ddof=1))


def parametric_returns(series: np.ndarray, horizon: int, paths: int, seed: int) -> np.ndarray:
    """r = exp(z·σ + μ) − 1。z はパス 0 の 1〜T 年、パス 1 の 1〜T 年…の順に消費（決定済み 5・11）。"""
    mu, sigma = log_moments(series)
    rng = Xoshiro128.from_seed(seed)
    out = np.empty((paths, horizon))
    for p in range(paths):
        for t in range(horizon):
            out[p, t] = math.exp(rng.next_normal() * sigma + mu) - 1.0
    return out

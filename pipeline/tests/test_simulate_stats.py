"""reference.simulate のパーセンタイル・サンプルパス・破産年ヒストグラム・逆算の検査。"""

from __future__ import annotations

import numpy as np
import pytest
from reference.simulate import (
    historical_returns,
    percentiles,
    ruin_histogram,
    run_engine,
    sample_paths,
    solve_spending,
    success_rate,
)

# docs/golden-cases.md の D1 の合成系列（−100% を添字 4 と 9 に置く）
D1_SERIES = np.array([0.05, 0.03, 0.04, 0.02, -1.0, 0.06, 0.01, 0.05, 0.04, -1.0])


def test_percentiles_linear_interpolation_by_hand():
    balances = np.array([[0.0], [10.0], [20.0], [30.0], [40.0]])
    # 位置 = q/100·(5−1)。p10 → 0.4 → 4、p90 → 3.6 → 36
    assert percentiles(balances) == {
        "p10": [4.0],
        "p25": [10.0],
        "p50": [20.0],
        "p75": [30.0],
        "p90": [36.0],
    }


def test_percentiles_are_per_year_and_include_ruined_zeros():
    balances = np.array([[100.0, 0.0, 0.0], [100.0, 50.0, 60.0], [100.0, 30.0, 0.0]])
    p = percentiles(balances)
    assert p["p50"] == [100.0, 30.0, 0.0]
    assert p["p90"] == [100.0, 30.0 + 0.8 * 20.0, 0.0 + 0.8 * 60.0]


def test_sample_paths_limit_and_historical_all():
    balances = np.arange(250 * 2, dtype=float).reshape(250, 2)
    assert sample_paths(balances, historical=False).tolist() == balances[:200].tolist()
    assert sample_paths(balances[:7], historical=False).shape == (7, 2)
    assert sample_paths(balances, historical=True).shape == (250, 2)


def test_d1_historical_outcomes_from_case_list():
    res = run_engine(historical_returns(D1_SERIES, 3), 1000.0, 0.0, 0.0)
    counts, ended_at_zero = ruin_histogram(res)
    # 開始年 3 は 3 年目に破産、4 は 2 年目に破産。2 と 7 は endedAtZero。0, 1, 5, 6 は成功
    assert res.ruin_year.tolist() == [0, 0, 0, 3, 2, 0, 0, 0]
    assert counts == [0, 1, 1]
    assert ended_at_zero == 2
    assert res.success.tolist() == [True, True, False, False, False, True, True, False]
    assert success_rate(res) == 0.5


def test_histogram_partitions_paths():
    rng = np.random.default_rng(3)
    res = run_engine(rng.choice([-1.0, -0.4, 0.1], size=(300, 6)), 100.0, 20.0, 0.01)
    counts, ended_at_zero = ruin_histogram(res)
    assert len(counts) == 6
    assert sum(counts) + ended_at_zero + int(res.success.sum()) == 300


def test_histogram_empty_for_zero_horizon():
    assert ruin_histogram(run_engine(np.zeros((4, 0)), 1.0, 5.0, 0.0)) == ([], 0)


def test_solve_constant_zero_return_by_hand():
    # r = 0、T = 10、初期資産 100: 生活費 s < 10 なら成功。幅 100 を 2^14 > 10^4 回で 0.01 未満に
    res = solve_spending(np.zeros((5, 10)), 100.0, 0.0)
    assert res is not None
    assert not res.capped
    assert res.evaluations == 2 + 14
    assert res.spending < 10.0 <= res.upper
    assert res.upper - res.spending < 100.0 * 1e-4
    assert res.success_rate == 1.0


def test_solve_brackets_target():
    rng = np.random.default_rng(8)
    returns = rng.normal(0.05, 0.15, size=(400, 30))
    res = solve_spending(returns, 1000.0, 0.001)
    assert res is not None and not res.capped
    assert res.success_rate >= 0.9
    assert success_rate(run_engine(returns, 1000.0, res.spending, 0.001)) == res.success_rate
    assert success_rate(run_engine(returns, 1000.0, res.upper, 0.001)) < 0.9


def test_solve_fee_lowers_spending():
    returns = np.full((1, 20), 0.03)
    base = solve_spending(returns, 1000.0, 0.0)
    with_fee = solve_spending(returns, 1000.0, 0.02)
    assert base is not None and with_fee is not None
    assert with_fee.spending < base.spending


def test_solve_target_reached_exactly_counts_as_met():
    # 10 パス中 1 本だけ 1 年目に全損 → 生活費 0 でも成功率はちょうど 0.9
    returns = np.zeros((10, 2))
    returns[0, 0] = -1.0
    res = solve_spending(returns, 100.0, 0.0)
    assert res is not None and res.success_rate == 0.9
    # 中点でも成功率ちょうど 0.9 は目標以上。残り 9 本は 2 年で 2s < 100 なら成功
    assert 50.0 - 100.0 * 1e-4 < res.spending < 50.0 <= res.upper


def test_solve_returns_none_when_zero_spending_misses_target():
    returns = np.zeros((10, 2))
    returns[:2, 0] = -1.0  # 成功率 0.8
    assert solve_spending(returns, 100.0, 0.0) is None


def test_solve_capped_at_initial_for_zero_horizon():
    res = solve_spending(np.zeros((3, 0)), 500.0, 0.001)
    assert res is not None
    assert (res.spending, res.upper, res.capped, res.evaluations) == (500.0, 500.0, True, 2)
    assert res.success_rate == 1.0
    # 上端の成功率が目標ちょうどでも頭打ち
    exact = solve_spending(np.zeros((3, 0)), 500.0, 0.001, target=1.0)
    assert exact is not None and exact.capped


@pytest.mark.parametrize("initial", [1.0, 5e7])
def test_solve_stops_below_relative_width(initial):
    res = solve_spending(np.full((2, 5), 0.02), initial, 0.0)
    assert res is not None
    assert res.upper - res.spending < initial * 1e-4
    assert res.upper - res.spending >= initial * 1e-4 / 2

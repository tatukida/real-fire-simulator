"""reference.simulate のエンジン・パス生成・N の検査（手計算できるケース、性質、決定性）。"""

from __future__ import annotations

import math

import numpy as np
import pytest
from reference.prng import Xoshiro128
from reference.simulate import (
    bootstrap_returns,
    historical_returns,
    log_moments,
    parametric_returns,
    run_engine,
    start_count,
    warning_level,
)


def _engine(rows, initial=100.0, spending=10.0, fee=0.0):
    return run_engine(np.array(rows, dtype=float), initial, spending, fee)


def test_engine_withdraw_then_grow():
    res = _engine([[0.1, 0.0]])
    # 年1: (100 − 10)·1.1 = 99、年2: (99 − 10)·1 = 89
    assert res.balances.tolist() == [[100.0, (100.0 - 10.0) * 1.1, (100.0 - 10.0) * 1.1 - 10.0]]
    assert res.success.tolist() == [True]
    assert res.ruin_year.tolist() == [0]


def test_engine_fee_is_subtracted_from_multiplier():
    res = _engine([[0.05]], spending=0.0, fee=0.02)
    assert res.balances[0, 1] == 100.0 * ((1.0 + 0.05) - 0.02)


def test_engine_ruin_after_withdrawal_and_zero_after():
    res = _engine([[0.0, 0.5, 0.5]], spending=60.0)
    # 年1: 40、年2: 40 − 60 ≤ 0 → 破産、以降 0
    assert res.balances.tolist() == [[100.0, 40.0, 0.0, 0.0]]
    assert res.ruin_year.tolist() == [2]
    assert not res.success[0] and not res.ended_at_zero[0]


def test_engine_exact_zero_after_withdrawal_is_ruin():
    res = _engine([[0.0]], spending=100.0)
    assert res.ruin_year.tolist() == [1]
    assert res.balances[0, 1] == 0.0


def test_engine_zero_multiplier_before_last_year_ruins_next_year_even_without_spending():
    res = _engine([[-1.0, 0.1, 0.1]], spending=0.0)
    assert res.balances.tolist() == [[100.0, 0.0, 0.0, 0.0]]
    assert res.ruin_year.tolist() == [2]
    assert not res.ended_at_zero[0]


def test_engine_zero_multiplier_in_last_year_is_ended_at_zero():
    res = _engine([[0.1, 0.1, -1.0]], spending=0.0)
    assert res.ruin_year.tolist() == [0]
    assert res.ended_at_zero.tolist() == [True]
    assert not res.success[0]


def test_engine_multiplier_clamped_at_zero_by_fee():
    # 1 + (−0.5) − 0.6 < 0 → 倍率 0（負の残高にならない）
    res = _engine([[-0.5]], spending=0.0, fee=0.6)
    assert res.balances[0, 1] == 0.0
    assert res.ended_at_zero.tolist() == [True]


def test_engine_zero_horizon_succeeds():
    res = run_engine(np.zeros((3, 0)), 100.0, 1e9, 0.02)
    assert res.balances.tolist() == [[100.0]] * 3
    assert res.success.all()


def test_engine_outcomes_partition_paths():
    rng = np.random.default_rng(1)
    rows = rng.choice([-1.0, -0.3, 0.0, 0.2], size=(200, 5))
    res = _engine(rows, spending=25.0)
    ruined = res.ruin_year > 0
    assert (ruined.astype(int) + res.success + res.ended_at_zero == 1).all()


def test_engine_matches_closed_form_for_constant_return():
    r, b0, s, t = 0.03, 1000.0, 50.0, 10
    res = run_engine(np.full((1, t), r), b0, s, 0.0)
    g = 1.0 + r
    expected = b0 * g**t - s * g * (g**t - 1.0) / r
    assert res.balances[0, t] == pytest.approx(expected, rel=1e-12)


def test_warning_level_boundaries():
    got = [warning_level(n) for n in (42, 20, 19, 10, 9, 1, 0, -3)]
    assert got == ["none"] * 2 + ["caution"] * 2 + ["strong"] * 2 + ["noHistory"] * 2


def test_start_count_examples_from_spec():
    assert start_count(54, 50) == 5  # GOLD 1972〜2025・50 年
    assert start_count(71, 30) == 42  # WORLD_DM 1950〜2020・30 年
    assert start_count(98, 98) == 1
    assert start_count(98, 99) == 0
    assert start_count(98, 0) == 99


def test_historical_windows_in_start_order():
    series = np.arange(5, dtype=float)
    assert historical_returns(series, 3).tolist() == [[0, 1, 2], [1, 2, 3], [2, 3, 4]]
    assert historical_returns(series, 5).tolist() == [[0, 1, 2, 3, 4]]
    assert historical_returns(series, 6) is None
    assert historical_returns(series, 0).shape == (6, 0)


@pytest.mark.parametrize(("horizon", "blocks"), [(31, 11), (6, 2), (1, 1)])
def test_bootstrap_uses_circular_blocks_and_truncates_last_block(horizon, blocks):
    series = np.arange(10, dtype=float) / 100.0
    paths, seed = 3, 20260929
    out = bootstrap_returns(series, horizon, paths, seed)
    rng = Xoshiro128.from_seed(seed)
    for p in range(paths):
        idx = []
        for _ in range(blocks):  # ceil(T / 3)。パスごとにこの数だけ乱数を消費する
            s = rng.next_int(10)
            idx += [(s + k) % 10 for k in range(3)]
        assert out[p].tolist() == series[idx[:horizon]].tolist()


def test_bootstrap_wraps_around_end_of_series():
    series = np.array([0.1, 0.2])
    out = bootstrap_returns(series, 3, 50, 7)
    # 長さ 2 の系列では各ブロックが交互の並びになる
    assert all(row[0] != row[1] and row[0] == row[2] for row in out.tolist())


def test_bootstrap_is_deterministic_and_seed_dependent():
    series = np.linspace(-0.2, 0.3, 20)
    a = bootstrap_returns(series, 7, 20, 1)
    assert np.array_equal(a, bootstrap_returns(series, 7, 20, 1))
    assert not np.array_equal(a, bootstrap_returns(series, 7, 20, 2))


def test_log_moments_use_sample_std():
    series = np.array([0.1, -0.05, 0.2])
    logs = [math.log(1.0 + v) for v in series]
    mu = sum(logs) / 3
    sd = math.sqrt(sum((x - mu) ** 2 for x in logs) / 2)
    assert log_moments(series) == pytest.approx((mu, sd), rel=1e-12)


def test_log_moments_reject_total_loss_year():
    with pytest.raises(ValueError):
        log_moments(np.array([0.1, -1.0]))


def test_parametric_consumes_normals_path_major_and_pairs_cross_paths():
    series = np.array([0.1, -0.05, 0.2, 0.07])
    mu, sigma = log_moments(series)
    out = parametric_returns(series, 1, 2, 99)  # 2 パス × 1 年 = z0, z1 の 1 ペア
    rng = Xoshiro128.from_seed(99)
    u1, u2 = rng.next_float(), rng.next_float()
    r = math.sqrt(-2.0 * math.log(1.0 - u1))
    z0, z1 = r * math.cos(2.0 * math.pi * u2), r * math.sin(2.0 * math.pi * u2)
    assert out[:, 0].tolist() == [math.exp(z0 * sigma + mu) - 1.0, math.exp(z1 * sigma + mu) - 1.0]


def test_parametric_order_matches_single_stream():
    series = np.array([0.1, -0.05, 0.2, 0.07])
    mu, sigma = log_moments(series)
    out = parametric_returns(series, 3, 3, 5)  # 9 個（奇数）
    rng = Xoshiro128.from_seed(5)
    flat = [math.exp(rng.next_normal() * sigma + mu) - 1.0 for _ in range(9)]
    assert out.ravel().tolist() == flat


def test_parametric_constant_series_reproduces_constant_return():
    out = parametric_returns(np.full(5, 0.04), 4, 3, 11)
    assert np.allclose(out, 0.04, rtol=0, atol=1e-15)

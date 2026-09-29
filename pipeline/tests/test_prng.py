"""reference.prng の検査。TS 側（web/tests/unit/prng.test.ts）は同じベクタファイルと照合する。"""

from __future__ import annotations

import json
import math

import pytest
from reference.prng import MASK, VECTORS_FILE, Xoshiro128, make_vectors

# xoshiro128** の既知の出力（状態 s = [1, 2, 3, 4] から。Rust rand_xoshiro のテストベクタと同じ）。
KNOWN_1234 = [
    11520,
    0,
    5927040,
    70819200,
    2031721883,
    1637235492,
    1287239034,
    3734860849,
    3729100597,
    4258142804,
]


def test_xoshiro128ss_known_answer():
    rng = Xoshiro128((1, 2, 3, 4))
    assert [rng.next_uint32() for _ in range(10)] == KNOWN_1234


def test_vectors_file_is_up_to_date():
    """コミット済みベクタ = 現在の実装の出力（実装を変えたらベクタも再生成が必要）。"""
    saved = json.loads(VECTORS_FILE.read_text(encoding="utf-8"))
    assert saved == make_vectors()


def test_vectors_are_consecutive_draws_of_one_generator():
    """ベクタは 1 つの生成器から連続して引いた列であること（生成器の作り直しで同じ値が並ぶ誤りを検出）。"""
    saved = json.loads(VECTORS_FILE.read_text(encoding="utf-8"))
    for seed, values in saved["uint32_by_seed"].items():
        rng = Xoshiro128.from_seed(int(seed))
        assert values == [rng.next_uint32() for _ in range(len(values))]
        assert len(set(values)) > len(values) // 2


def test_same_seed_same_sequence_and_different_seeds_differ():
    a, b, c = Xoshiro128.from_seed(7), Xoshiro128.from_seed(7), Xoshiro128.from_seed(8)
    sa = [a.next_uint32() for _ in range(100)]
    assert sa == [b.next_uint32() for _ in range(100)]
    assert sa != [c.next_uint32() for _ in range(100)]


def test_float_range_and_int_range():
    rng = Xoshiro128.from_seed(1)
    fs = [rng.next_float() for _ in range(20000)]
    assert all(0.0 <= f < 1.0 for f in fs)
    assert abs(sum(fs) / len(fs) - 0.5) < 0.01
    ints = [rng.next_int(3) for _ in range(20000)]
    assert set(ints) == {0, 1, 2}


def test_normal_moments():
    rng = Xoshiro128.from_seed(2)
    zs = [rng.next_normal() for _ in range(40000)]
    mean = sum(zs) / len(zs)
    var = sum((z - mean) ** 2 for z in zs) / (len(zs) - 1)
    assert abs(mean) < 0.02
    assert abs(math.sqrt(var) - 1.0) < 0.02


def test_normal_pair_order_z0_then_z1():
    """spec.md 7章 決定済み 5: z0 → z1 の順に返し、z1 の後で新しい u1, u2 を引く。"""
    rng, raw = Xoshiro128.from_seed(3), Xoshiro128.from_seed(3)
    z = [rng.next_normal() for _ in range(4)]
    for k in range(2):
        u1, u2 = raw.next_float(), raw.next_float()
        r = math.sqrt(-2.0 * math.log(1.0 - u1))
        assert z[2 * k] == r * math.cos(2.0 * math.pi * u2)
        assert z[2 * k + 1] == r * math.sin(2.0 * math.pi * u2)


@pytest.mark.parametrize("seed", [-1, MASK + 1, 1.5])
def test_invalid_seed_rejected(seed):
    with pytest.raises(ValueError):
        Xoshiro128.from_seed(seed)

"""シード付き PRNG（xoshiro128**）。TS 実装（web/src/core/prng.ts）と同じ列を返す。

仕様は web/src/core/prng.ts の冒頭コメントと同一（splitmix32 で初期化、53 ビットの nextFloat、
floor(nextFloat()·n) の nextInt、z0 → z1 の順に返す Box–Muller）。変更するときは両方を同時に変え、
`python -m reference.prng` でベクタを再生成すること。
"""

from __future__ import annotations

import json
import math
from pathlib import Path

MASK = 0xFFFFFFFF
TWO_POW_26 = 1 << 26
TWO_POW_53 = 1 << 53

VECTORS_FILE = Path(__file__).parent / "fixtures" / "prng_vectors.json"


def _rotl(x: int, k: int) -> int:
    return ((x << k) | (x >> (32 - k))) & MASK


def splitmix32_sequence(seed: int, count: int) -> list[int]:
    x = seed & MASK
    out = []
    for _ in range(count):
        x = (x + 0x9E3779B9) & MASK
        z = x
        z = ((z ^ (z >> 16)) * 0x85EBCA6B) & MASK
        z = ((z ^ (z >> 13)) * 0xC2B2AE35) & MASK
        z = z ^ (z >> 16)
        out.append(z)
    return out


class Xoshiro128:
    def __init__(self, state: tuple[int, int, int, int]) -> None:
        self.s = [v & MASK for v in state]
        if not any(self.s):
            self.s[0] = 1
        self._spare: float | None = None

    @classmethod
    def from_seed(cls, seed: int) -> Xoshiro128:
        if not isinstance(seed, int) or not 0 <= seed <= MASK:
            raise ValueError(f"シードは 0〜{MASK} の整数: {seed}")
        a, b, c, d = splitmix32_sequence(seed, 4)
        return cls((a, b, c, d))

    def next_uint32(self) -> int:
        s0, s1, s2, s3 = self.s
        result = (_rotl((s1 * 5) & MASK, 7) * 9) & MASK
        t = (s1 << 9) & MASK
        s2 ^= s0
        s3 ^= s1
        s1 ^= s2
        s0 ^= s3
        s2 ^= t
        s3 = _rotl(s3, 11)
        self.s = [s0, s1, s2, s3]
        return result

    def next_float(self) -> float:
        a = self.next_uint32() >> 5
        b = self.next_uint32() >> 6
        return (a * TWO_POW_26 + b) / TWO_POW_53

    def next_int(self, n: int) -> int:
        return math.floor(self.next_float() * n)

    def next_normal(self) -> float:
        if self._spare is not None:
            z1 = self._spare
            self._spare = None
            return z1
        u1 = self.next_float()
        u2 = self.next_float()
        r = math.sqrt(-2.0 * math.log(1.0 - u1))
        theta = 2.0 * math.pi * u2
        self._spare = r * math.sin(theta)
        return r * math.cos(theta)


# ベクタ（TS と Python の一致確認用）。シードは 0・最大値・通常値を含める。
VECTOR_SEEDS = [0, 1, 42, 20260929, MASK]
VECTOR_COUNT = 1000
VECTOR_INT_N = 54


def make_vectors() -> dict:
    uint32_by_seed = {}
    for seed in VECTOR_SEEDS:
        rng = Xoshiro128.from_seed(seed)
        uint32_by_seed[str(seed)] = [rng.next_uint32() for _ in range(VECTOR_COUNT)]
    rng_f, rng_i, rng_n = (Xoshiro128.from_seed(42) for _ in range(3))
    return {
        "note": "python -m reference.prng で生成。手で編集しない。",
        "count": VECTOR_COUNT,
        "splitmix32_seed42": splitmix32_sequence(42, 8),
        "uint32_by_seed": uint32_by_seed,
        "seed42_float": [rng_f.next_float() for _ in range(VECTOR_COUNT)],
        "seed42_int_n": VECTOR_INT_N,
        "seed42_int": [rng_i.next_int(VECTOR_INT_N) for _ in range(VECTOR_COUNT)],
        "seed42_normal": [rng_n.next_normal() for _ in range(VECTOR_COUNT)],
    }


def main() -> int:
    VECTORS_FILE.parent.mkdir(parents=True, exist_ok=True)
    VECTORS_FILE.write_text(
        json.dumps(make_vectors(), separators=(",", ":")) + "\n", encoding="utf-8"
    )
    print(f"書き出し: {VECTORS_FILE}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

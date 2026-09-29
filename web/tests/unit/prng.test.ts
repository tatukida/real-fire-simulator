import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Xoshiro128, splitmix32Sequence } from '../../src/core/prng';

// Python リファレンス（pipeline/reference/prng.py）が出力したベクタ。TS と Python が同じ列を返すことを確認する。
interface Vectors {
  count: number;
  splitmix32_seed42: number[];
  uint32_by_seed: Record<string, number[]>;
  seed42_float: number[];
  seed42_int_n: number;
  seed42_int: number[];
  seed42_normal: number[];
}
const vectorsPath = fileURLToPath(
  new URL('../../../pipeline/reference/fixtures/prng_vectors.json', import.meta.url),
);
const V = JSON.parse(readFileSync(vectorsPath, 'utf-8')) as Vectors;

// xoshiro128** の既知の出力（状態 s = [1, 2, 3, 4] から。Rust rand_xoshiro のテストベクタと同じ）。
const KNOWN_1234 = [
  11520, 0, 5927040, 70819200, 2031721883, 1637235492, 1287239034, 3734860849, 3729100597, 4258142804,
];

function take(n: number, f: () => number): number[] {
  return Array.from({ length: n }, f);
}

describe('xoshiro128**', () => {
  it('既知の出力と一致する', () => {
    const rng = new Xoshiro128([1, 2, 3, 4]);
    expect(take(10, () => rng.nextUint32())).toEqual(KNOWN_1234);
  });

  it('splitmix32 が Python と一致する', () => {
    expect(splitmix32Sequence(42, V.splitmix32_seed42.length)).toEqual(V.splitmix32_seed42);
  });

  it.each(Object.keys(V.uint32_by_seed))('シード %s の先頭 1,000 個の uint32 が Python と完全一致する', (seed) => {
    const rng = Xoshiro128.fromSeed(Number(seed));
    expect(take(V.count, () => rng.nextUint32())).toEqual(V.uint32_by_seed[seed]);
  });

  it('nextFloat / nextInt の先頭 1,000 個が Python と完全一致する', () => {
    const f = Xoshiro128.fromSeed(42);
    expect(take(V.count, () => f.nextFloat())).toEqual(V.seed42_float);
    const i = Xoshiro128.fromSeed(42);
    expect(take(V.count, () => i.nextInt(V.seed42_int_n))).toEqual(V.seed42_int);
  });

  it('nextNormal の先頭 1,000 個が Python と一致する（log/cos/sin の実装差のみ許容）', () => {
    const rng = Xoshiro128.fromSeed(42);
    const zs = take(V.count, () => rng.nextNormal());
    zs.forEach((z, k) => {
      const want = V.seed42_normal[k] as number;
      expect(Math.abs(z - want)).toBeLessThanOrEqual(1e-12 * Math.max(1, Math.abs(want)));
    });
  });

  it('z0 → z1 の順に返し、z1 の後で新しい u1, u2 を引く', () => {
    const rng = Xoshiro128.fromSeed(3);
    const raw = Xoshiro128.fromSeed(3);
    const z = take(4, () => rng.nextNormal());
    for (let k = 0; k < 2; k++) {
      const u1 = raw.nextFloat();
      const u2 = raw.nextFloat();
      const r = Math.sqrt(-2 * Math.log(1 - u1));
      expect(z[2 * k]).toBe(r * Math.cos(2 * Math.PI * u2));
      expect(z[2 * k + 1]).toBe(r * Math.sin(2 * Math.PI * u2));
    }
  });

  it('nextFloat は [0, 1)、nextInt は 0〜n−1', () => {
    const rng = Xoshiro128.fromSeed(1);
    const fs = take(20000, () => rng.nextFloat());
    expect(fs.every((f) => f >= 0 && f < 1)).toBe(true);
    expect(new Set(take(20000, () => rng.nextInt(3)))).toEqual(new Set([0, 1, 2]));
  });

  it.each([-1, 2 ** 32, 1.5, Number.NaN])('不正なシード %s を拒否する', (seed) => {
    expect(() => Xoshiro128.fromSeed(seed)).toThrow(RangeError);
  });
});

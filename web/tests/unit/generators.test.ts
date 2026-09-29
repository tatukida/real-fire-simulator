import { describe, expect, it } from 'vitest';
import {
  bootstrapPaths,
  historicalPaths,
  logReturnMoments,
  parametricPaths,
} from '../../src/core/generators';
import { Xoshiro128 } from '../../src/core/prng';

/** 値 = 位置（0, 1, 2, …）の系列。どこから取ったかが値から分かる。 */
const indexSeries = (n: number): Float64Array => Float64Array.from({ length: n }, (_, i) => i / 100);
const row = (v: Float64Array, years: number, p: number): number[] => Array.from(v.subarray(p * years, (p + 1) * years));

describe('ヒストリカル', () => {
  it('開始年 i のパスは series[i..i+T−1]、N = n − T + 1', () => {
    const s = indexSeries(10);
    const r = historicalPaths(s, 4);
    expect(r?.paths).toBe(7);
    expect(row(r?.values ?? new Float64Array(), 4, 0)).toEqual([0, 0.01, 0.02, 0.03]);
    expect(row(r?.values ?? new Float64Array(), 4, 6)).toEqual([0.06, 0.07, 0.08, 0.09]);
  });
  it('T = 系列の年数なら N = 1', () => {
    expect(historicalPaths(indexSeries(10), 10)?.paths).toBe(1);
  });
  it('T > 系列の年数（N ≤ 0）なら null', () => {
    expect(historicalPaths(indexSeries(10), 11)).toBeNull();
    expect(historicalPaths(indexSeries(10), 60)).toBeNull();
  });
});

describe('循環ブロック・ブートストラップ', () => {
  it('ブロックは乱数の開始位置から連続し、mod n で先頭に戻る。T = 31, L = 3 は 11 ブロックで最後は 1 年分', () => {
    const n = 10;
    const T = 31;
    const seed = 42;
    const r = bootstrapPaths(indexSeries(n), T, 2, seed, 3);
    const rng = Xoshiro128.fromSeed(seed);
    for (let p = 0; p < 2; p++) {
      const want: number[] = [];
      for (let b = 0; b < 11; b++) {
        const start = rng.nextInt(n);
        for (let j = 0; j < 3 && want.length < T; j++) want.push(((start + j) % n) / 100);
      }
      expect(row(r.values, T, p)).toEqual(want);
    }
  });
  it('パスごとに ceil(T / L) 回だけ乱数を消費する（次のパスは続きの乱数から始まる）', () => {
    const one = bootstrapPaths(indexSeries(50), 7, 2, 7, 3);
    const rng = Xoshiro128.fromSeed(7);
    for (let k = 0; k < 3; k++) rng.nextInt(50); // パス 0 の 3 ブロック
    expect(one.values[7]).toBe(rng.nextInt(50) / 100);
  });
  it('同じシードなら同じ結果、違うシードなら違う結果', () => {
    const s = indexSeries(30);
    expect(bootstrapPaths(s, 30, 100, 1).values).toEqual(bootstrapPaths(s, 30, 100, 1).values);
    expect(bootstrapPaths(s, 30, 100, 1).values).not.toEqual(bootstrapPaths(s, 30, 100, 2).values);
  });
  it('T = 0 は空の行列', () => {
    const r = bootstrapPaths(indexSeries(5), 0, 3, 1);
    expect([r.paths, r.years, r.values.length]).toEqual([3, 0, 0]);
  });
});

describe('パラメトリック', () => {
  it('ln(1+r) の平均と標本標準偏差（n−1）', () => {
    const s = Float64Array.from([0.1, -0.05, 0.2, 0.03]);
    const logs = Array.from(s, (x) => Math.log(1 + x));
    const mean = logs.reduce((a, b) => a + b, 0) / logs.length;
    const sd = Math.sqrt(logs.reduce((a, b) => a + (b - mean) ** 2, 0) / (logs.length - 1));
    const m = logReturnMoments(s);
    expect(m.mu).toBeCloseTo(mean, 15);
    expect(m.sigma).toBeCloseTo(sd, 15);
  });
  it('r = exp(z·σ + μ) − 1。z はパスの境目をまたいで z0, z1 の順に消費する（T 奇数）', () => {
    const s = Float64Array.from([0.1, -0.05, 0.2, 0.03]);
    const { mu, sigma } = logReturnMoments(s);
    const r = parametricPaths(s, 3, 3, 9);
    const rng = Xoshiro128.fromSeed(9);
    const want = Array.from({ length: 9 }, () => Math.exp(rng.nextNormal() * sigma + mu) - 1);
    expect(Array.from(r.values)).toEqual(want);
  });
  it('σ = 0（一定の系列）なら全年が同じリターン', () => {
    const r = parametricPaths(new Float64Array(10).fill(0.05), 5, 4, 1);
    for (const v of r.values) expect(v).toBeCloseTo(0.05, 12);
  });
  it('標本の平均・標準偏差がおおむね μ, σ に近い', () => {
    const s = Float64Array.from([0.3, -0.2, 0.1, 0.05, -0.1, 0.25, 0.0, 0.15]);
    const { mu, sigma } = logReturnMoments(s);
    const r = parametricPaths(s, 40, 5000, 123);
    const logs = Array.from(r.values, (x) => Math.log(1 + x));
    const m = logs.reduce((a, b) => a + b, 0) / logs.length;
    const sd = Math.sqrt(logs.reduce((a, b) => a + (b - m) ** 2, 0) / (logs.length - 1));
    expect(Math.abs(m - mu)).toBeLessThan(0.01 * sigma);
    expect(Math.abs(sd / sigma - 1)).toBeLessThan(0.01);
  });
  it('系列が 2 年未満なら例外', () => {
    expect(() => parametricPaths(Float64Array.from([0.1]), 5, 1, 1)).toThrow(RangeError);
  });
});

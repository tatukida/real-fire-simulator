import { describe, expect, it } from 'vitest';
import { simulate, type ReturnPaths, type SimulationResult } from '../../src/core/engine';
import { balancePercentiles, percentileSorted, ruinHistogram, samplePaths } from '../../src/core/stats';

const rows = (...rs: number[][]): ReturnPaths => ({
  paths: rs.length,
  years: rs[0]?.length ?? 0,
  values: Float64Array.from(rs.flat()),
});

/** 残高・破産年を直接与えた結果（パーセンタイル等の検査用）。 */
const result = (years: number, balances: number[], ruinYears: number[], successCount: number): SimulationResult => ({
  paths: ruinYears.length,
  years,
  successCount,
  successRate: successCount / ruinYears.length,
  ruinYears: Int32Array.from(ruinYears),
  balances: Float64Array.from(balances),
});

const QS = [0, 10, 25, 50, 75, 90, 100];

describe('percentileSorted は NumPy percentile（linear）とビット単位で一致', () => {
  // 期待値は NumPy 2.5.3 の np.percentile で計算。90 パーセンタイルは a + (b − a)·γ の片側の式だけでは 1 ulp ずれる。
  it.each([
    [[27.559, 329.732, 409.199, 538.143, 549.594, 753.513, 788.429], [27.559, 208.86280000000005, 369.4655, 538.143, 651.5535, 767.4794, 788.429]],
    [[0, 0, 0, 5, 10], [0, 0, 0, 0, 5, 8, 10]],
    [[3], [3, 3, 3, 3, 3, 3, 3]],
  ])('%j', (sorted, expected) => {
    expect(QS.map((q) => percentileSorted(sorted, q))).toEqual(expected);
  });
  it('範囲外の q・空配列は例外', () => {
    expect(() => percentileSorted([1], -1)).toThrow(RangeError);
    expect(() => percentileSorted([1], 100.0001)).toThrow(RangeError);
    expect(() => percentileSorted([1], Number.NaN)).toThrow(RangeError);
    expect(() => percentileSorted([], 50)).toThrow(RangeError);
  });
});

describe('balancePercentiles', () => {
  it('年ごとに並べ替えて計算し、破産パスは 0 として含める', () => {
    // 年 1: 残高 [50, 0(破産), 200, 100, 0(破産)] を未整列で与える
    const r = result(1, [100, 50, 100, 0, 100, 200, 100, 100, 100, 0], [0, 1, 0, 0, 1], 3);
    const [p10, p50, p90] = balancePercentiles(r, [10, 50, 90]);
    expect(Array.from(p10 ?? [])).toEqual([100, percentileSorted([0, 0, 50, 100, 200], 10)]);
    expect(Array.from(p50 ?? [])).toEqual([100, 50]);
    expect(Array.from(p90 ?? [])).toEqual([100, percentileSorted([0, 0, 50, 100, 200], 90)]);
  });
  it('エンジンの出力に対して年 0..T の T+1 点を返す（既定は 10/25/50/75/90）', () => {
    const sim = simulate(rows([0.1, 0.1], [-0.5, -0.5], [0, 0]), { initialAssets: 100, annualSpending: 40, fee: 0 }, { recordBalances: true });
    const ps = balancePercentiles(sim);
    expect(ps).toHaveLength(5);
    for (const p of ps) expect(p).toHaveLength(3);
    // 年 2 末: [ (60·1.1−40)·1.1 = 28.6, 破産 0, 20 ] → 中央値 20
    expect(ps[2]?.[2]).toBe(20);
  });
  it('残高を記録していない結果は例外', () => {
    const sim = simulate(rows([0]), { initialAssets: 1, annualSpending: 0, fee: 0 });
    expect(() => balancePercentiles(sim)).toThrow(/記録/);
  });
});

describe('samplePaths', () => {
  const many = (paths: number): SimulationResult =>
    simulate({ paths, years: 2, values: new Float64Array(paths * 2) }, { initialAssets: 10, annualSpending: 1, fee: 0 }, { recordBalances: true });

  it.each([
    ['bootstrap', 1000, 200],
    ['parametric', 1000, 200],
    ['bootstrap', 200, 200],
    ['parametric', 7, 7],
    ['historical', 1000, 1000],
    ['historical', 1, 1],
  ] as const)('%s: %d 本 → %d 本', (method, paths, expected) => {
    const s = samplePaths(many(paths), method);
    expect(s.indices).toHaveLength(expected);
    expect(s.ruinYears).toHaveLength(expected);
    expect(s.balances).toHaveLength(expected * 3);
  });
  it('パス番号の先頭から取り、残高と破産年は元の結果と同じ', () => {
    const r = result(1, [10, 5, 10, 0, 10, 20], [0, 1, 0], 2);
    const s = samplePaths(r, 'historical');
    expect(Array.from(s.indices)).toEqual([0, 1, 2]);
    expect(Array.from(s.balances)).toEqual([10, 5, 10, 0, 10, 20]);
    expect(Array.from(s.ruinYears)).toEqual([0, 1, 0]);
  });
});

describe('ruinHistogram', () => {
  it('年 1..T ごとの破産数を数える', () => {
    const r = result(3, new Array<number>(20).fill(0), [0, 1, 3, 3, 0], 2);
    const h = ruinHistogram(r);
    expect(Array.from(h.counts)).toEqual([1, 0, 2]);
    expect(h.endedAtZero).toBe(0);
  });
  it('T 年目に倍率 0 で全損したパスは endedAtZero に数える（合計 = 全パス）', () => {
    // パス 0: 2 年目に −100%（倍率 0）で全損。破産年なし・成功でもない。パス 1: 成功。
    const sim = simulate(rows([0, -1], [0, 0]), { initialAssets: 100, annualSpending: 10, fee: 0 });
    expect(Array.from(sim.ruinYears)).toEqual([0, 0]);
    const h = ruinHistogram(sim);
    expect(Array.from(h.counts)).toEqual([0, 0]);
    expect(h.endedAtZero).toBe(1);
    expect(h.successCount).toBe(1);
  });
  it('T = 0 なら counts は空', () => {
    const sim = simulate({ paths: 3, years: 0, values: new Float64Array(0) }, { initialAssets: 1, annualSpending: 5, fee: 0 });
    const h = ruinHistogram(sim);
    expect(h.counts).toHaveLength(0);
    expect(h.successCount + h.endedAtZero).toBe(3);
  });
});

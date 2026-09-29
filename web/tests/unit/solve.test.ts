import { describe, expect, it } from 'vitest';
import { simulate, type ReturnPaths } from '../../src/core/engine';
import { bootstrapPaths } from '../../src/core/generators';
import { bisectSpending, solveSpending, solveSpendingForPaths, TARGET_SUCCESS_RATE } from '../../src/core/solve';

/** 決定的な合成系列（実質リターン −13%〜+23%）。 */
const series = Float64Array.from({ length: 40 }, (_, i) => 0.05 + 0.18 * Math.sin(i * 1.7));
const A = 10_000;
const rateOf = (r: ReturnPaths, s: number, fee = 0.001): number => simulate(r, { initialAssets: A, annualSpending: s, fee }).successRate;

describe('逆算の前提: リターン列を固定すると成功率は生活費について単調非増加', () => {
  it.each([0, 0.02])('信託報酬 %f', (fee) => {
    const r = bootstrapPaths(series, 30, 500, 7);
    let prev = 1;
    for (let s = 0; s <= A * 0.1; s += A * 0.0005) {
      const rate = rateOf(r, s, fee);
      expect(rate).toBeLessThanOrEqual(prev);
      prev = rate;
    }
  });
});

describe('solveSpendingForPaths', () => {
  const r = bootstrapPaths(series, 30, 1000, 42);
  const res = solveSpendingForPaths(r, A, 0.001);

  it('結果の生活費は目標以上、上端は目標未満。頭打ちではない（capped = false）', () => {
    expect(res).not.toBeNull();
    if (res === null) return;
    expect(res.capped).toBe(false);
    expect(res.successRate).toBe(rateOf(r, res.spending));
    expect(res.successRate).toBeGreaterThanOrEqual(TARGET_SUCCESS_RATE);
    expect(rateOf(r, res.upper)).toBeLessThan(TARGET_SUCCESS_RATE);
  });
  it('区間幅が初期資産 × 1e-4 未満になった時点で打ち切る（端 2 回 + 14 回の半分割）', () => {
    if (res === null) throw new Error('null');
    const width = res.upper - res.spending;
    expect(width).toBeLessThan(A * 1e-4);
    expect(width).toBeGreaterThanOrEqual((A * 1e-4) / 2);
    expect(res.evaluations).toBe(16);
  });
  it('一定リターン 0% なら上限は 初期資産 / T（取り崩し後の残高 0 は破産）', () => {
    const T = 30;
    const flat: ReturnPaths = { paths: 3, years: T, values: new Float64Array(3 * T) };
    const s = solveSpendingForPaths(flat, 1, 0);
    if (s === null) throw new Error('null');
    expect(s.spending).toBeLessThan(1 / T);
    expect(s.upper).toBeGreaterThanOrEqual(1 / T - 1e-15);
    expect(s.successRate).toBe(1);
    expect(s.capped).toBe(false);
  });
  it('生活費 0 でも目標未満（倍率 0 で全損するパスが 10% 超）なら null', () => {
    // 10 パス中 2 パスが 1 年目に −100%（倍率 0）→ 生活費 0 でも成功率 80%
    const values = new Float64Array(10 * 5);
    values[0] = -1;
    values[5] = -1;
    expect(solveSpendingForPaths({ paths: 10, years: 5, values }, A, 0)).toBeNull();
    // 1 パスだけなら 90% で目標以上
    values[5] = 0;
    expect(solveSpendingForPaths({ paths: 10, years: 5, values }, A, 0)?.successRate).toBe(0.9);
  });
  it('T = 0 なら生活費 = 初期資産でも成功率 100% なので初期資産を返す', () => {
    const s = solveSpendingForPaths({ paths: 4, years: 0, values: new Float64Array(0) }, A, 0.01);
    expect(s).toEqual({ spending: A, successRate: 1, upper: A, capped: true, evaluations: 2 });
  });
});

describe('solveSpending（代表手法 = ブートストラップ）', () => {
  it('リターン列はシードから 1 回だけ生成し、生活費だけを変える', () => {
    const input = { series, years: 25, paths: 800, seed: 123, initialAssets: A, fee: 0.001 };
    const expected = solveSpendingForPaths(bootstrapPaths(series, 25, 800, 123), A, 0.001);
    expect(solveSpending(input)).toEqual(expected);
    expect(solveSpending(input)).toEqual(solveSpending(input));
  });
  it('目標成功率の既定は 90%', () => {
    const input = { series, years: 25, paths: 800, seed: 5, initialAssets: A, fee: 0 };
    expect(solveSpending(input)).toEqual(solveSpending({ ...input, target: 0.9 }));
    expect(solveSpending(input)).not.toEqual(solveSpending({ ...input, target: 0.5 }));
  });
});

describe('非単調な成功率関数の扱い（bisectSpending は端の条件だけを使う）', () => {
  /** 区間 [a, b)（初期資産に対する比）で成功率 1、それ以外は 0。 */
  const islands =
    (...ranges: [number, number][]) =>
    (s: number): number =>
      ranges.some(([a, b]) => s >= a * A && s < b * A) ? 1 : 0;

  it('最初の中点が不成立の側に落ちると、下の境界（0.3）で止まり上の島（0.6〜0.8）は見ない', () => {
    const res = bisectSpending(islands([0, 0.3], [0.6, 0.8]), A);
    if (res === null) throw new Error('null');
    expect(res.spending).toBeLessThan(0.3 * A);
    expect(res.upper).toBeGreaterThanOrEqual(0.3 * A);
    expect(res.upper - res.spending).toBeLessThan(A * 1e-4);
  });
  it('最初の中点が上の島に落ちると、途中の不成立区間（0.2〜0.4）を飛び越えて 0.7 で止まる', () => {
    const f = islands([0, 0.2], [0.4, 0.7]);
    const res = bisectSpending(f, A);
    if (res === null) throw new Error('null');
    expect(res.spending).toBeLessThan(0.7 * A);
    expect(res.upper).toBeGreaterThanOrEqual(0.7 * A);
    expect(f(res.spending)).toBe(1); // 返す点は常に目標以上
    expect(f(0.3 * A)).toBe(0); // ただし、それより少ない生活費で目標を満たすとは限らない
  });
  it('成功率がちょうど目標（90%）の点は目標以上として扱う', () => {
    const res = bisectSpending((s) => (s < 0.7 * A ? 0.9 : 0), A);
    if (res === null) throw new Error('null');
    expect(res.successRate).toBe(0.9);
    expect(res.upper).toBeGreaterThanOrEqual(0.7 * A);
    expect(res.spending).toBeGreaterThan(0.7 * A - A * 1e-4);
  });
  it('生活費 0 で目標未満なら、上端で目標以上でも null（下端を先に判定する）', () => {
    expect(bisectSpending(islands([0.5, 1.01]), A)).toBeNull();
  });
});

describe('入力の検証', () => {
  const f = (): number => 1;
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('初期資産 %f は例外', (a) => {
    expect(() => bisectSpending(f, a)).toThrow(RangeError);
  });
  it.each([0, -0.1, 1.01, Number.NaN])('目標成功率 %f は例外', (t) => {
    expect(() => bisectSpending(f, A, t)).toThrow(RangeError);
  });
});

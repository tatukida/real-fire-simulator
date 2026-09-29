import { describe, expect, it } from 'vitest';
import { growthFactor, simulate, type ReturnPaths } from '../../src/core/engine';

/** 全パス・全年で同じリターン r の行列。 */
const constant = (paths: number, years: number, r: number): ReturnPaths => ({
  paths,
  years,
  values: new Float64Array(paths * years).fill(r),
});

const rows = (...rs: number[][]): ReturnPaths => ({
  paths: rs.length,
  years: rs[0]?.length ?? 0,
  values: Float64Array.from(rs.flat()),
});

describe('残高倍率 max(0, 1 + r_real − fee)', () => {
  it('通常は 1 + r − fee', () => {
    expect(growthFactor(0.05, 0.001)).toBe(1 + 0.05 - 0.001);
  });
  it('1 + r − fee ≤ 0 なら 0', () => {
    expect(growthFactor(-0.99, 0.02)).toBe(0);
    expect(growthFactor(-0.75, 0.25)).toBe(0); // ちょうど 0（2 進で正確に表せる値）
  });
  it('残高は取り崩し後の額に倍率を掛けたもの', () => {
    const res = simulate(rows([0.1, -0.2]), { initialAssets: 100, annualSpending: 10, fee: 0.01 }, { recordBalances: true });
    const b1 = (100 - 10) * (1 + 0.1 - 0.01);
    const b2 = (b1 - 10) * (1 + -0.2 - 0.01);
    expect(Array.from(res.balances ?? [])).toEqual([100, b1, b2]);
  });
  it('倍率 0 で残高 0 になったパスは、翌年の取り崩し後の残高 0 で破産する（生活費 0 でも）', () => {
    const res = simulate(rows([-0.99, 0.1, 0.1]), { initialAssets: 100, annualSpending: 0, fee: 0.02 }, { recordBalances: true });
    expect(res.ruinYears[0]).toBe(2);
    expect(res.successCount).toBe(0);
  });
});

describe('T = 0', () => {
  it('成功率 100%（生活費が初期資産を上回っても）', () => {
    const res = simulate(constant(5, 0, 0), { initialAssets: 1, annualSpending: 1e9, fee: 0.02 }, { recordBalances: true });
    expect(res.successRate).toBe(1);
    expect(Array.from(res.ruinYears)).toEqual([0, 0, 0, 0, 0]);
    expect(Array.from(res.balances ?? [])).toEqual([1, 1, 1, 1, 1]);
  });
});

describe('破産判定: 取り崩し後の残高 ≤ 0', () => {
  it('取り崩し後がちょうど 0 なら破産', () => {
    const res = simulate(rows([0, 0]), { initialAssets: 100, annualSpending: 50, fee: 0 });
    expect(res.ruinYears[0]).toBe(2);
    expect(res.successRate).toBe(0);
  });
  it('取り崩し後がわずかに正なら破産しない', () => {
    const res = simulate(rows([0, 0]), { initialAssets: 100.000001, annualSpending: 50, fee: 0 });
    expect(res.ruinYears[0]).toBe(0);
    expect(res.successRate).toBe(1);
  });
  it('破産年以降の残高は 0 固定', () => {
    const res = simulate(rows([0.5, 0.5, 0.5, 0.5]), { initialAssets: 10, annualSpending: 20, fee: 0 }, { recordBalances: true });
    expect(res.ruinYears[0]).toBe(1);
    expect(Array.from(res.balances ?? [])).toEqual([10, 0, 0, 0, 0]);
  });
  it('成功率 = 成功パス数 / 全パス数', () => {
    const res = simulate(rows([0, 0, 0], [1, 1, 1], [-0.5, -0.5, -0.5], [0.2, 0.2, 0.2]), {
      initialAssets: 100,
      annualSpending: 30,
      fee: 0,
    });
    // 0%: 70→40→10 で成功 / +100%: 成功 / −50%: 35→2.5→破産(3年目) / +20%: 成功
    expect(Array.from(res.ruinYears)).toEqual([0, 0, 3, 0]);
    expect(res.successCount).toBe(3);
    expect(res.successRate).toBe(0.75);
  });
});

describe('一定リターンの閉形式（年金現価の式）', () => {
  it.each([
    [0.04, 0.001, 30],
    [-0.02, 0.005, 20],
    [0.07, 0, 40],
  ])('r=%s fee=%s T=%s', (r, fee, T) => {
    const W0 = 1000;
    const S = 30;
    const g = r - fee;
    const res = simulate(constant(1, T, r), { initialAssets: W0, annualSpending: S, fee }, { recordBalances: true });
    const bal = res.balances ?? new Float64Array();
    for (let t = 0; t <= T; t++) {
      const k = (1 + g) ** t;
      const want = W0 * k - (S * (1 + g) * (k - 1)) / g;
      expect(bal[t]).toBeCloseTo(want, 8);
    }
  });
});

describe('入力検証', () => {
  const ok = { initialAssets: 100, annualSpending: 1, fee: 0.001 };
  it.each([
    ['初期資産 0', { ...ok, initialAssets: 0 }],
    ['生活費が負', { ...ok, annualSpending: -1 }],
    ['信託報酬が NaN', { ...ok, fee: Number.NaN }],
  ])('%s は例外', (_, p) => {
    expect(() => simulate(constant(1, 1, 0), p)).toThrow(RangeError);
  });
  it('values の長さが合わなければ例外', () => {
    expect(() => simulate({ paths: 2, years: 3, values: new Float64Array(5) }, ok)).toThrow(RangeError);
  });
  it('recordBalances なしなら balances は null', () => {
    expect(simulate(constant(1, 1, 0), ok).balances).toBeNull();
  });
});

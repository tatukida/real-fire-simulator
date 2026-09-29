/**
 * spec.md 6.1 のプロパティテスト（案）。承認後に web/tests/property/ へ移す想定。
 * 各プロパティについて、(a) 本物の実装で成り立ち、(b) わざと壊した実装（ミュータント）では反例が見つかることを確かめる。
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { engineMutant, jpyWithoutInflation, nondeterministicBootstrap, realImpl, type Impl } from './impl';
import {
  p1SpendingMonotone,
  p2AssetsMonotone,
  p3ZeroSpending,
  p4ZeroYears,
  p5ClosedForm,
  p6Deterministic,
  p7FxZero,
  p8FeeMonotone,
} from './properties';

type Prop = (impl: Impl) => fc.IProperty<never> | fc.IProperty<unknown[]>;

const cases: [string, Prop, [string, () => Impl][]][] = [
  ['1. 生活費↑ で成功率が上がらない', p1SpendingMonotone, [['成功判定を反転', () => engineMutant('invertSuccess')]]],
  ['2. 初期資産↑ で成功率が下がらない', p2AssetsMonotone, [['成功判定を反転', () => engineMutant('invertSuccess')]]],
  ['3. 生活費 0 で成功率 100%', p3ZeroSpending, [['元本維持を成功とする', () => engineMutant('preserveCapital')]]],
  ['4. 期間 0 で成功率 100%', p4ZeroYears, [['T = 0 でも取り崩し判定', () => engineMutant('withdrawAtYear0')]]],
  [
    '5. 一定リターンで閉形式と一致',
    p5ClosedForm,
    [
      ['取り崩しを運用の後にする', () => engineMutant('withdrawAfterGrowth')],
      ['信託報酬を足す', () => engineMutant('feeAdded')],
    ],
  ],
  ['6. 同一シードで完全一致', p6Deterministic, [['呼ぶたびにシードがずれる', nondeterministicBootstrap]]],
  ['7. 為替 0 なら JPY = USD', p7FxZero, [['JPY のインフレ調整を忘れる', () => jpyWithoutInflation]]],
  ['8. 信託報酬↑ で成功率が上がらない', p8FeeMonotone, [['信託報酬を足す', () => engineMutant('feeAdded')]]],
];

describe.each(cases)('%s', (_, prop, mutants) => {
  it('本物の実装で成り立つ', () => {
    fc.assert(prop(realImpl) as fc.IProperty<unknown[]>, { numRuns: 100 });
  });
  it.each(mutants)('壊した実装（%s）では反例が見つかる', (_m, make) => {
    const out = fc.check(prop(make()) as fc.IProperty<unknown[]>, { numRuns: 300, seed: 20260929 });
    expect(out.failed).toBe(true);
  });
});

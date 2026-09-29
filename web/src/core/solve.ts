/**
 * 逆算: 成功率の目標を満たす年間生活費の上限（spec.md 4章 項目6、7章 決定済み 2・9）。
 *
 * 代表手法（ブロック・ブートストラップ）のリターン列を同じシードで 1 回だけ生成し、生活費だけを変えて二分探索する。
 * 探索範囲は [0, 初期資産]。区間の幅が初期資産 × 1e-4 未満になったら打ち切り、目標以上の側の端（下端）を返す。
 *
 * 二分探索は「下端は目標以上・上端は目標未満」という端の条件だけを使い、成功率が生活費について単調非増加であることを前提とする。
 * リターン列を固定すれば engine の成功率は単調非増加になる（各パスの残高が生活費について単調非増加）。
 * 単調でない成功率関数を bisectSpending に渡した場合、結果は目標以上の点だが、上限とは限らない（テストで挙動を固定）。
 *
 * 端の扱い（2026-09-29 に人間が決定）:
 * - 生活費 0 でも目標未満なら null（該当なし）。
 * - 生活費 = 初期資産でも目標以上（T = 0 のとき）なら初期資産を返し、capped = true とする（ADR-0003）。
 */

import { simulate, type ReturnPaths } from './engine';
import { bootstrapPaths, DEFAULT_BLOCK_LENGTH } from './generators';

export const TARGET_SUCCESS_RATE = 0.9;
/** 打ち切りの区間幅（初期資産に対する比） */
export const SOLVE_RELATIVE_TOLERANCE = 1e-4;

export interface SolveResult {
  /** 目標以上を満たす側の端（結果の生活費） */
  readonly spending: number;
  /** spending での成功率 */
  readonly successRate: number;
  /** 打ち切り時の上端（目標未満の側）。capped のときは spending と同じ */
  readonly upper: number;
  /** 探索範囲の上端（初期資産）でも目標以上で、上端を返した（上限で頭打ち）なら true */
  readonly capped: boolean;
  /** 成功率を評価した回数 */
  readonly evaluations: number;
}

function checkInputs(initialAssets: number, target: number): void {
  if (!Number.isFinite(initialAssets) || initialAssets <= 0) throw new RangeError(`初期資産が不正: ${initialAssets}`);
  if (!(target > 0 && target <= 1)) throw new RangeError(`目標成功率が不正: ${target}`);
}

/** 成功率関数 rateAt（生活費 → 0〜1）に対する二分探索。目標を満たす生活費がなければ null。 */
export function bisectSpending(
  rateAt: (spending: number) => number,
  initialAssets: number,
  target: number = TARGET_SUCCESS_RATE,
): SolveResult | null {
  checkInputs(initialAssets, target);
  let evaluations = 0;
  const rate = (s: number): number => {
    evaluations++;
    return rateAt(s);
  };

  let lo = 0;
  let loRate = rate(lo);
  if (loRate < target) return null;
  let hi = initialAssets;
  const hiRate = rate(hi);
  if (hiRate >= target) return { spending: hi, successRate: hiRate, upper: hi, capped: true, evaluations };

  const tolerance = initialAssets * SOLVE_RELATIVE_TOLERANCE;
  while (hi - lo >= tolerance) {
    const mid = (lo + hi) / 2;
    const r = rate(mid);
    if (r >= target) {
      lo = mid;
      loRate = r;
    } else {
      hi = mid;
    }
  }
  return { spending: lo, successRate: loRate, upper: hi, capped: false, evaluations };
}

/** 固定したリターン列で、成功率が目標以上となる年間生活費の上限を探す。 */
export function solveSpendingForPaths(
  returns: ReturnPaths,
  initialAssets: number,
  fee: number,
  target: number = TARGET_SUCCESS_RATE,
): SolveResult | null {
  return bisectSpending((s) => simulate(returns, { initialAssets, annualSpending: s, fee }).successRate, initialAssets, target);
}

export interface SolveInput {
  /** 共通期間の実質リターン系列（信託報酬を引く前） */
  readonly series: Float64Array;
  readonly years: number;
  readonly paths: number;
  readonly seed: number;
  readonly initialAssets: number;
  readonly fee: number;
  readonly blockLength?: number;
  readonly target?: number;
}

/** 代表手法（ブロック・ブートストラップ）で逆算する。リターン列はシードから 1 回だけ生成する。 */
export function solveSpending(input: SolveInput): SolveResult | null {
  const returns = bootstrapPaths(input.series, input.years, input.paths, input.seed, input.blockLength ?? DEFAULT_BLOCK_LENGTH);
  return solveSpendingForPaths(returns, input.initialAssets, input.fee, input.target ?? TARGET_SUCCESS_RATE);
}

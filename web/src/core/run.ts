/**
 * 1 回の実行: 設定 → 3 手法の成功率・集計、逆算、N と注意段階（spec.md 4章、7章 決定済み）。
 *
 * - 3 手法それぞれで成功率・パーセンタイル・サンプルパス・破産年の分布を返す（UI で手法を切り替えても再計算しない）。
 * - ヒストリカルは N ≤ 0 なら null（7章 決定済み 10）。パラメトリックは 1 + r ≤ 0 または有限でない年を含む系列なら null（決定済み 20）。
 * - 逆算は代表手法（ブートストラップ）で、集計に使ったのと同じリターン列を使う（solveSpending と同じ結果）。
 * - 全パスの残高行列は返さない。
 *
 * 計測用の時計は引数で受け取る（core は performance などの環境に依存させない）。
 */

import { simulate, type ReturnPaths, type SimulationResult } from './engine';
import { bootstrapPaths, DEFAULT_BLOCK_LENGTH, historicalPaths, logReturnMoments, parametricPaths } from './generators';
import { solveSpendingForPaths, TARGET_SUCCESS_RATE, type SolveResult } from './solve';
import {
  balancePercentiles,
  FAN_PERCENTILES,
  ruinHistogram,
  samplePaths,
  type Method,
  type RuinHistogram,
  type SamplePaths,
} from './stats';
import { sampleWarning, type SampleWarning } from './warnings';

export const REPRESENTATIVE_METHOD = 'bootstrap' satisfies Method;

export interface RunInput {
  /** 共通期間の実質リターン系列（信託報酬を引く前） */
  readonly series: Float64Array;
  /** FIRE 期間 T */
  readonly years: number;
  readonly paths: number;
  readonly seed: number;
  readonly initialAssets: number;
  readonly annualSpending: number;
  readonly fee: number;
  readonly blockLength?: number;
  readonly target?: number;
}

export interface MethodSummary {
  readonly paths: number;
  readonly successCount: number;
  readonly successRate: number;
  /** percentiles[k][t] は FAN_PERCENTILES[k] パーセンタイルの年 t 末残高 */
  readonly percentiles: Float64Array[];
  readonly samplePaths: SamplePaths;
  readonly ruinHistogram: RuinHistogram;
}

/** 各段階の所要時間（ミリ秒）。時計を渡さなければ null。 */
export interface RunTimings {
  readonly generate: number;
  readonly simulate: number;
  readonly aggregate: number;
  readonly solve: number;
  readonly total: number;
}

export interface RunResult {
  readonly methods: Readonly<Record<Method, MethodSummary | null>>;
  readonly representative: typeof REPRESENTATIVE_METHOD;
  /** 逆算（成功率が目標以上となる年間生活費の上限）。解がなければ null */
  readonly solve: SolveResult | null;
  readonly warning: SampleWarning;
  readonly timings: RunTimings | null;
}

/** パラメトリックが扱える系列か（generators.ts の logReturnMoments と同じ条件）。 */
function parametricAccepts(series: Float64Array): boolean {
  try {
    logReturnMoments(series);
    return true;
  } catch (e) {
    if (e instanceof RangeError) return false;
    throw e;
  }
}

function summarize(r: SimulationResult, method: Method): MethodSummary {
  return {
    paths: r.paths,
    successCount: r.successCount,
    successRate: r.successRate,
    percentiles: balancePercentiles(r, FAN_PERCENTILES),
    samplePaths: samplePaths(r, method),
    ruinHistogram: ruinHistogram(r),
  };
}

export function run(input: RunInput, now?: () => number): RunResult {
  const clock = now ?? ((): number => 0);
  const { series, years, paths, seed, initialAssets, annualSpending, fee } = input;
  const blockLength = input.blockLength ?? DEFAULT_BLOCK_LENGTH;
  const warning = sampleWarning(series.length, years);

  const t0 = clock();
  const returns: Record<Method, ReturnPaths | null> = {
    historical: warning.historicalAvailable ? historicalPaths(series, years) : null,
    bootstrap: bootstrapPaths(series, years, paths, seed, blockLength),
    parametric: parametricAccepts(series) ? parametricPaths(series, years, paths, seed) : null,
  };

  const t1 = clock();
  const params = { initialAssets, annualSpending, fee };
  const sims: Record<Method, SimulationResult | null> = { historical: null, bootstrap: null, parametric: null };
  for (const m of Object.keys(returns) as Method[]) {
    const rp = returns[m];
    sims[m] = rp === null ? null : simulate(rp, params, { recordBalances: true });
  }

  const t2 = clock();
  const methods: Record<Method, MethodSummary | null> = { historical: null, bootstrap: null, parametric: null };
  for (const m of Object.keys(sims) as Method[]) {
    const s = sims[m];
    methods[m] = s === null ? null : summarize(s, m);
  }

  const t3 = clock();
  const solve = solveSpendingForPaths(returns.bootstrap as ReturnPaths, initialAssets, fee, input.target ?? TARGET_SUCCESS_RATE);
  const t4 = clock();

  const timings =
    now === undefined
      ? null
      : { generate: t1 - t0, simulate: t2 - t1, aggregate: t3 - t2, solve: t4 - t3, total: t4 - t0 };
  return { methods, representative: REPRESENTATIVE_METHOD, solve, warning, timings };
}

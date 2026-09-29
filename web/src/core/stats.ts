/**
 * シミュレーション結果の集計（spec.md 4章 項目2〜4、7章 決定済み 6・7）。
 *
 * - パーセンタイル: 年 0〜T の各年末残高について、NumPy の既定（method='linear'）と同じ計算。破産パスは残高 0 として含める。
 * - サンプルパス: ブートストラップ・パラメトリックは先頭から最大 200 本、ヒストリカルは全パス。
 * - 破産年の分布: 年 1〜T ごとの破産パス数。
 */

import type { SimulationResult } from './engine';

export const METHODS = ['historical', 'bootstrap', 'parametric'] as const;
export type Method = (typeof METHODS)[number];

export const FAN_PERCENTILES = [10, 25, 50, 75, 90] as const;
export const MAX_SAMPLE_PATHS = 200;

/**
 * 昇順に並んだ values の q パーセンタイル（0 ≤ q ≤ 100）。
 * NumPy の percentile(method='linear') と同じ演算順: 仮想添字 v = (n − 1)·(q / 100)、
 * 下側 a = values[floor(v)]、上側 b = values[floor(v) + 1]、γ = v − floor(v) として
 * γ < 0.5 なら a + (b − a)·γ、γ ≥ 0.5 なら b − (b − a)·(1 − γ)。v ≥ n − 1 なら最大値。
 */
export function percentileSorted(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length;
  if (n === 0) throw new RangeError('空の配列のパーセンタイルは計算できません');
  if (!(q >= 0 && q <= 100)) throw new RangeError(`パーセンタイルが不正: ${q}`);
  const v = (n - 1) * (q / 100);
  if (v >= n - 1) return sorted[n - 1] as number;
  const lo = Math.floor(v);
  const a = sorted[lo] as number;
  const b = sorted[lo + 1] as number;
  const gamma = v - lo;
  const diff = b - a;
  return gamma >= 0.5 ? b - diff * (1 - gamma) : a + diff * gamma;
}

function requireBalances(r: SimulationResult): Float64Array {
  if (r.balances === null) throw new Error('残高が記録されていません（simulate の recordBalances を指定する）');
  return r.balances;
}

/** 年 0〜T の各年末残高のパーセンタイル。result[k][t] は qs[k] パーセンタイルの年 t 末残高。 */
export function balancePercentiles(r: SimulationResult, qs: readonly number[] = FAN_PERCENTILES): Float64Array[] {
  const balances = requireBalances(r);
  const { paths, years } = r;
  const stride = years + 1;
  const out = qs.map(() => new Float64Array(stride));
  const column = new Float64Array(paths);
  for (let t = 0; t < stride; t++) {
    for (let p = 0; p < paths; p++) column[p] = balances[p * stride + t] as number;
    column.sort();
    qs.forEach((q, k) => {
      (out[k] as Float64Array)[t] = percentileSorted(column, q);
    });
  }
  return out;
}

export interface SamplePaths {
  /** 元の結果でのパス番号 */
  readonly indices: Int32Array;
  readonly years: number;
  /** balances[i * (years + 1) + t] は indices[i] のパスの年 t 末残高 */
  readonly balances: Float64Array;
  /** indices[i] のパスの破産年（1..T、破産しなければ 0） */
  readonly ruinYears: Int32Array;
}

/** スパゲッティ図に描くパス。ヒストリカルは全パス、それ以外は先頭から最大 200 本。 */
export function samplePaths(r: SimulationResult, method: Method): SamplePaths {
  const balances = requireBalances(r);
  const count = method === 'historical' ? r.paths : Math.min(MAX_SAMPLE_PATHS, r.paths);
  const stride = r.years + 1;
  const indices = new Int32Array(count);
  for (let i = 0; i < count; i++) indices[i] = i;
  return {
    indices,
    years: r.years,
    balances: balances.slice(0, count * stride),
    ruinYears: r.ruinYears.slice(0, count),
  };
}

export interface RuinHistogram {
  /** counts[t − 1] は t 年目（1..T）に破産したパス数 */
  readonly counts: Int32Array;
  /**
   * 破産年はないが成功でもないパス数。T 年目に倍率 0 で全損し、期間終了時の残高が 0 のパス
   * （spec.md 7章 決定済み 12。破産は翌年の扱いなので期間内の破産年を持たない）。
   */
  readonly endedAtZero: number;
  readonly successCount: number;
  readonly paths: number;
}

/** 破産年の分布。counts の合計 + endedAtZero + successCount = paths。 */
export function ruinHistogram(r: SimulationResult): RuinHistogram {
  const counts = new Int32Array(r.years);
  let ruined = 0;
  for (let p = 0; p < r.paths; p++) {
    const y = r.ruinYears[p] as number;
    if (y > 0) {
      counts[y - 1] = (counts[y - 1] as number) + 1;
      ruined++;
    }
  }
  return { counts, endedAtZero: r.paths - r.successCount - ruined, successCount: r.successCount, paths: r.paths };
}

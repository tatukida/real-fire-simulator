/**
 * リターン列の生成器（spec.md 3.2、7章 決定済み 4・5・10）。
 *
 * 入力は共通期間の実質リターン系列（信託報酬を引く前）。出力は engine.ts の ReturnPaths。
 * 信託報酬はここでは引かない（engine が max(0, 1 + r_real − fee) で適用する）。
 *
 * 乱数を使う生成器は、引数のシードから新しい Xoshiro128 を作り、それだけを使う（Python リファレンスも同じ手順）。
 */

import { historicalStartCount } from './data';
import type { ReturnPaths } from './engine';
import { Xoshiro128 } from './prng';

export const DEFAULT_BLOCK_LENGTH = 3;

function checkYears(years: number): void {
  if (!Number.isInteger(years) || years < 0) throw new RangeError(`期間が不正: ${years}`);
}

function checkPaths(paths: number): void {
  if (!Number.isInteger(paths) || paths < 1) throw new RangeError(`パス数が不正: ${paths}`);
}

function checkSeries(series: Float64Array, min: number): void {
  if (series.length < min) throw new RangeError(`系列が短すぎます（${series.length} 年 < ${min} 年）`);
}

/**
 * ヒストリカル: 開始年 i = 0..N−1 について series[i .. i+T−1] を再現する。パス i は i 番目の開始年。
 * N = 系列の年数 − T + 1 ≤ 0 なら計算せず null（spec.md 7章 決定済み 10）。
 */
export function historicalPaths(series: Float64Array, years: number): ReturnPaths | null {
  checkYears(years);
  checkSeries(series, 1);
  const paths = historicalStartCount(series.length, years);
  if (paths <= 0) return null;
  const values = new Float64Array(paths * years);
  for (let i = 0; i < paths; i++) values.set(series.subarray(i, i + years), i * years);
  return { paths, years, values };
}

/**
 * 循環ブロック・ブートストラップ（spec.md 7章 決定済み 4）。
 * 各パスで ceil(T / L) 個のブロックを順に選ぶ。開始位置は rng.nextInt(n)、位置は mod n で先頭に戻る。
 * 先頭 T 年分を使い、最後のブロックの余りは切り捨てる。乱数はパス 0 のブロック 1..、パス 1 の … の順に消費する。
 */
export function bootstrapPaths(
  series: Float64Array,
  years: number,
  paths: number,
  seed: number,
  blockLength: number = DEFAULT_BLOCK_LENGTH,
): ReturnPaths {
  checkYears(years);
  checkPaths(paths);
  checkSeries(series, 1);
  if (!Number.isInteger(blockLength) || blockLength < 1) throw new RangeError(`ブロック長が不正: ${blockLength}`);
  const n = series.length;
  const rng = Xoshiro128.fromSeed(seed);
  const values = new Float64Array(paths * years);
  for (let p = 0; p < paths; p++) {
    const base = p * years;
    for (let t = 0; t < years; t += blockLength) {
      const start = rng.nextInt(n);
      const len = Math.min(blockLength, years - t);
      for (let j = 0; j < len; j++) values[base + t + j] = series[(start + j) % n] as number;
    }
  }
  return { paths, years, values };
}

/**
 * ln(1 + r) の標本平均と標本標準偏差（自由度 n−1）。NumPy の mean / std(ddof=1) と同じ 2 パス計算。
 * 1 + r ≤ 0 の年（ln が定義できない）や有限でない値を含む系列は RangeError で拒否する（ADR-0003 決定 8）。
 */
export function logReturnMoments(series: Float64Array): { mu: number; sigma: number } {
  checkSeries(series, 2);
  const n = series.length;
  for (let i = 0; i < n; i++) {
    const r = series[i] as number;
    if (!Number.isFinite(r) || 1 + r <= 0) {
      throw new RangeError(`パラメトリックは 1 + r ≤ 0 または有限でない値を含む系列を扱えません（添字 ${i}: ${r}）`);
    }
  }
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.log(1 + (series[i] as number));
  const mu = sum / n;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.log(1 + (series[i] as number)) - mu;
    ss += d * d;
  }
  return { mu, sigma: Math.sqrt(ss / (n - 1)) };
}

/**
 * パラメトリック（spec.md 7章 決定済み 5）: r = exp(z·σ + μ) − 1、z は Box–Muller の標準正規乱数。
 * z はパス 0 の 1..T 年目、パス 1 の 1..T 年目…の順に消費し、z0, z1 のペアはパスの境目をまたぐ。
 * 総数が奇数なら最後の z1 は使われない（rng はこの呼び出し専用なので捨てられる）。
 */
export function parametricPaths(series: Float64Array, years: number, paths: number, seed: number): ReturnPaths {
  checkYears(years);
  checkPaths(paths);
  const { mu, sigma } = logReturnMoments(series);
  const rng = Xoshiro128.fromSeed(seed);
  const values = new Float64Array(paths * years);
  for (let k = 0; k < values.length; k++) values[k] = Math.exp(rng.nextNormal() * sigma + mu) - 1;
  return { paths, years, values };
}

/**
 * ゴールデンテスト（フェーズ2 手順⑦）。golden/ は Python 参照実装から人間が生成した正解データで、ここでは読むだけ。
 * 構造と許容誤差は docs/golden-cases.md。各ケースの input から TS 実装で 3 手法・逆算・N と注意段階を計算し、
 * output と比べる。不一致はケース ID・項目・両方の値を並べて報告する。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  balancePercentiles,
  bootstrapPaths,
  FAN_PERCENTILES,
  historicalPaths,
  historicalStartCount,
  parametricPaths,
  ruinHistogram,
  sampleWarning,
  samplePaths,
  simulate,
  SOLVE_RELATIVE_TOLERANCE,
  solveSpending,
  type Method,
  type ReturnPaths,
} from '../../src/core/index';

interface MethodTolerance {
  readonly successRateAbs: number;
  readonly valuesRel: number;
  readonly counts: 'exact' | 'successRate';
}

interface MethodOutput {
  readonly successRate: number;
  readonly successCount: number;
  readonly paths: number;
  readonly percentiles?: Readonly<Record<string, readonly number[]>>;
  readonly samplePaths?: { readonly count: number; readonly first: readonly number[]; readonly last: readonly number[] };
  readonly ruinHistogram?: { readonly counts: readonly number[]; readonly endedAtZero: number };
}

interface SolveOutput {
  readonly spending: number;
  readonly successRate: number;
  readonly upper: number;
  readonly capped: boolean;
  readonly evaluations: number;
}

interface GoldenCase {
  readonly id: string;
  readonly outputs: 'all' | 'success_rate_only';
  readonly input: {
    readonly series: { readonly name: string; readonly values: readonly number[] };
    readonly initial: number;
    readonly spending: number;
    readonly fee: number;
    readonly horizon: number;
    readonly seed: number;
    readonly paths: number;
    readonly blockLength: number;
    readonly targetRate: number;
    readonly solveRelWidth: number;
  };
  readonly tolerance: Readonly<Record<Method, MethodTolerance>> & {
    readonly solve: { readonly spendingRel: number; readonly upperRel: number; readonly successRateAbs: number };
  };
  readonly output: Readonly<Record<Method, MethodOutput | null>> & {
    readonly n: number;
    readonly warningLevel: string;
    readonly solve?: SolveOutput | null;
  };
}

const goldenDir = fileURLToPath(new URL('../../../golden/', import.meta.url));
const readJson = (rel: string): unknown => JSON.parse(readFileSync(goldenDir + rel, 'utf-8'));
const index = readJson('index.json') as { readonly cases: readonly string[] };
const cases = index.cases.map((id) => readJson(`cases/${id}.json`) as GoldenCase);

/** 相対比較 |a − b| ≤ rel · max(|a|, |b|)（両方 0 なら一致。rel = 0 なら厳密一致）。 */
function relClose(a: number, b: number, rel: number): boolean {
  return a === b || Math.abs(a - b) <= rel * Math.max(Math.abs(a), Math.abs(b));
}

/** 不一致を集める。項目名・TS の値・ゴールデンの値を記録する。 */
class Diff {
  readonly items: string[] = [];
  constructor(private readonly id: string) {}
  add(field: string, ts: unknown, golden: unknown): void {
    this.items.push(`${this.id} ${field}: TS=${JSON.stringify(ts)} golden=${JSON.stringify(golden)}`);
  }
  exact(field: string, ts: unknown, golden: unknown): void {
    if (ts !== golden) this.add(field, ts, golden);
  }
  abs(field: string, ts: number, golden: number, tol: number): void {
    if (!(Math.abs(ts - golden) <= tol)) this.add(field, ts, golden);
  }
  rel(field: string, ts: number, golden: number, rel: number): void {
    if (!relClose(ts, golden, rel)) this.add(field, ts, golden);
  }
  relArray(field: string, ts: ArrayLike<number>, golden: readonly number[], rel: number): void {
    if (ts.length !== golden.length) return this.add(`${field}.length`, ts.length, golden.length);
    for (let i = 0; i < golden.length; i++) this.rel(`${field}[${i}]`, ts[i] as number, golden[i] as number, rel);
  }
}

/** パラメトリックを計算しないケース（−100% の年を含む系列）。ゴールデンでは parametric: null。 */
const PARAMETRIC_REJECTED = ['D1'];

function generate(c: GoldenCase, method: Method, series: Float64Array): ReturnPaths | null {
  const { horizon, paths, seed, blockLength } = c.input;
  if (method === 'historical') return historicalPaths(series, horizon);
  if (method === 'bootstrap') return bootstrapPaths(series, horizon, paths, seed, blockLength);
  // パラメトリックは 1 + r_real ≤ 0 の年を含む系列を入力検証で拒否する（ADR-0003 決定 8）。
  // 拒否するケースだけ RangeError を明示して確かめ、ゴールデンの null に対応させる。それ以外の例外はテストを失敗させる。
  if (PARAMETRIC_REJECTED.includes(c.id)) {
    expect(() => parametricPaths(series, horizon, paths, seed)).toThrow(RangeError);
    return null;
  }
  return parametricPaths(series, horizon, paths, seed);
}

function checkMethod(d: Diff, c: GoldenCase, method: Method, series: Float64Array): void {
  const want = c.output[method];
  const tol = c.tolerance[method];
  const returns = generate(c, method, series);
  if (returns === null || want === null) {
    if ((returns === null) !== (want === null)) d.add(`${method} is null`, returns === null, want === null);
    return;
  }
  const r = simulate(returns, { initialAssets: c.input.initial, annualSpending: c.input.spending, fee: c.input.fee }, { recordBalances: true });
  // counts = "successRate": 件数の差を成功率の許容誤差 × パス数まで認める。
  const countTol = tol.counts === 'exact' ? 0 : tol.successRateAbs * r.paths + 1e-9;
  d.exact(`${method}.paths`, r.paths, want.paths);
  d.abs(`${method}.successRate`, r.successRate, want.successRate, tol.successRateAbs);
  d.abs(`${method}.successCount`, r.successCount, want.successCount, countTol);
  if (c.outputs !== 'all') return;

  const pcts = balancePercentiles(r);
  FAN_PERCENTILES.forEach((q, k) => {
    d.relArray(`${method}.percentiles.p${q}`, pcts[k] as Float64Array, want.percentiles?.[`p${q}`] ?? [], tol.valuesRel);
  });

  const sp = samplePaths(r, method);
  const wantSp = want.samplePaths;
  d.exact(`${method}.samplePaths.count`, sp.indices.length, wantSp?.count);
  const stride = sp.years + 1;
  const lastStart = (sp.indices.length - 1) * stride;
  d.relArray(`${method}.samplePaths.first`, sp.balances.subarray(0, stride), wantSp?.first ?? [], tol.valuesRel);
  d.relArray(`${method}.samplePaths.last`, sp.balances.subarray(lastStart, lastStart + stride), wantSp?.last ?? [], tol.valuesRel);

  const h = ruinHistogram(r);
  const wantH = want.ruinHistogram;
  if (h.counts.length !== (wantH?.counts.length ?? -1)) {
    d.add(`${method}.ruinHistogram.counts.length`, h.counts.length, wantH?.counts.length);
  } else {
    wantH?.counts.forEach((w, t) => d.abs(`${method}.ruinHistogram.counts[${t}]`, h.counts[t] as number, w, countTol));
  }
  d.abs(`${method}.ruinHistogram.endedAtZero`, h.endedAtZero, wantH?.endedAtZero ?? NaN, countTol);
}

function checkSolve(d: Diff, c: GoldenCase, series: Float64Array): void {
  const want = c.output.solve;
  if (want === undefined) return;
  const got = solveSpending({
    series,
    years: c.input.horizon,
    paths: c.input.paths,
    seed: c.input.seed,
    initialAssets: c.input.initial,
    fee: c.input.fee,
    blockLength: c.input.blockLength,
    target: c.input.targetRate,
  });
  if (got === null || want === null) {
    if ((got === null) !== (want === null)) d.add('solve is null', got === null, want === null);
    return;
  }
  const tol = c.tolerance.solve;
  d.rel('solve.spending', got.spending, want.spending, tol.spendingRel);
  d.rel('solve.upper', got.upper, want.upper, tol.upperRel);
  d.abs('solve.successRate', got.successRate, want.successRate, tol.successRateAbs);
  d.exact('solve.capped', got.capped, want.capped);
  d.exact('solve.evaluations', got.evaluations, want.evaluations);
}

describe('ゴールデン（golden/index.json の全ケース）', () => {
  it('ケース一覧がすべて読める（24 件）', () => {
    expect(cases.map((c) => c.id)).toEqual(index.cases);
    expect(cases).toHaveLength(24);
  });

  it.each(cases.map((c) => [c.id, c] as const))('%s', (_id, c) => {
    // 逆算の打ち切り幅は TS では定数。ゴールデンの入力と同じであることを先に確かめる。
    expect(SOLVE_RELATIVE_TOLERANCE).toBe(c.input.solveRelWidth);
    const series = Float64Array.from(c.input.series.values);
    const d = new Diff(c.id);
    d.exact('n', historicalStartCount(series.length, c.input.horizon), c.output.n);
    d.exact('warningLevel', sampleWarning(series.length, c.input.horizon).level, c.output.warningLevel);
    for (const m of ['historical', 'bootstrap', 'parametric'] as const) checkMethod(d, c, m, series);
    if (c.outputs === 'all') checkSolve(d, c, series);
    expect(d.items).toEqual([]);
  });
});

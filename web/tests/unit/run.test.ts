import { describe, expect, it } from 'vitest';
import { simulate } from '../../src/core/engine';
import { bootstrapPaths, historicalPaths, parametricPaths } from '../../src/core/generators';
import { run, type RunInput } from '../../src/core/run';
import { solveSpending } from '../../src/core/solve';
import { balancePercentiles, FAN_PERCENTILES, MAX_SAMPLE_PATHS, METHODS, ruinHistogram } from '../../src/core/stats';

/** 決定的な合成系列（実質リターン −13%〜+23%）。 */
const series = Float64Array.from({ length: 40 }, (_, i) => 0.05 + 0.18 * Math.sin(i * 1.7));
const base: RunInput = { series, years: 30, paths: 500, seed: 7, initialAssets: 10_000, annualSpending: 400, fee: 0.001 };
const params = { initialAssets: base.initialAssets, annualSpending: base.annualSpending, fee: base.fee };

describe('run', () => {
  const res = run(base);

  it('各手法の結果は生成器 + simulate + 集計を個別に呼んだ結果と一致する', () => {
    const direct = {
      historical: historicalPaths(series, 30),
      bootstrap: bootstrapPaths(series, 30, 500, 7),
      parametric: parametricPaths(series, 30, 500, 7),
    };
    for (const m of METHODS) {
      const rp = direct[m];
      const got = res.methods[m];
      expect(rp).not.toBeNull();
      expect(got).not.toBeNull();
      if (rp === null || got === null) continue;
      const sim = simulate(rp, params, { recordBalances: true });
      expect(got.successRate).toBe(sim.successRate);
      expect(got.successCount).toBe(sim.successCount);
      expect(got.paths).toBe(sim.paths);
      expect(got.percentiles).toEqual(balancePercentiles(sim, FAN_PERCENTILES));
      expect(got.ruinHistogram).toEqual(ruinHistogram(sim));
    }
  });

  it('逆算は solveSpending と同じ（同じシードのブートストラップ列）', () => {
    expect(res.solve).toEqual(
      solveSpending({ series, years: 30, paths: 500, seed: 7, initialAssets: base.initialAssets, fee: base.fee }),
    );
  });

  it('サンプルパスはヒストリカルが全開始年、他は最大 200 本。残高行列の全体は返さない', () => {
    expect(res.methods.historical?.samplePaths.indices.length).toBe(11);
    expect(res.methods.bootstrap?.samplePaths.indices.length).toBe(MAX_SAMPLE_PATHS);
    expect(res.methods.parametric?.samplePaths.balances.length).toBe(MAX_SAMPLE_PATHS * 31);
    expect(Object.keys(res.methods.bootstrap ?? {})).not.toContain('balances');
  });

  it('代表手法はブートストラップ。N と注意段階を返す', () => {
    expect(res.representative).toBe('bootstrap');
    expect(res.warning.startCount).toBe(11);
    expect(res.warning.level).toBe('caution');
  });

  it('同じ入力なら同じ結果（時計なしでは timings は null）', () => {
    expect(run(base)).toEqual(res);
    expect(res.timings).toBeNull();
  });

  it('N ≤ 0 ならヒストリカルは null、他の 2 手法と逆算は計算する', () => {
    const r = run({ ...base, years: 45 });
    expect(r.methods.historical).toBeNull();
    expect(r.warning.level).toBe('noHistory');
    expect(r.methods.bootstrap).not.toBeNull();
    expect(r.methods.parametric).not.toBeNull();
  });

  it('1 + r ≤ 0 の年を含む系列ではパラメトリックだけ null（決定済み 20）', () => {
    const withTotalLoss = Float64Array.from(series, (v, i) => (i === 5 ? -1 : v));
    const r = run({ ...base, series: withTotalLoss });
    expect(r.methods.parametric).toBeNull();
    expect(r.methods.historical).not.toBeNull();
    expect(r.methods.bootstrap).not.toBeNull();
  });

  it('時計を渡すと各段階の時間を返す（合計 = 各段階の和）', () => {
    let t = 0;
    const r = run(base, () => (t += 10));
    expect(r.timings).toEqual({ generate: 10, simulate: 10, aggregate: 10, solve: 10, total: 40 });
  });
});

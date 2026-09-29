/**
 * プロパティテストが検査する実装の差し替え口と、わざと壊した実装（ミュータント）。
 * 本物の実装でプロパティが通り、ミュータントでは失敗することを spec61.test.ts で確かめる。
 */
import { commonPeriod, realReturnSeries, type RealReturnSeries } from '../../src/core/data';
import { growthFactor, simulate, type SimulationResult } from '../../src/core/engine';
import { bootstrapPaths, historicalPaths, parametricPaths } from '../../src/core/generators';

export interface Impl {
  readonly simulate: typeof simulate;
  readonly historicalPaths: typeof historicalPaths;
  readonly bootstrapPaths: typeof bootstrapPaths;
  readonly parametricPaths: typeof parametricPaths;
  readonly realReturnSeries: typeof realReturnSeries;
}

export const realImpl: Impl = { simulate, historicalPaths, bootstrapPaths, parametricPaths, realReturnSeries };

export type EngineMutant =
  | 'invertSuccess' // 成功判定を反転
  | 'preserveCapital' // 「最終残高 ≥ 初期資産」を成功とする
  | 'withdrawAtYear0' // T = 0 でも期初に取り崩しの判定をする
  | 'withdrawAfterGrowth' // 取り崩しを運用の後にする
  | 'feeAdded'; // 信託報酬を足してしまう

/** engine.simulate と同じループを、1 か所だけ壊して書き直したもの。 */
function mutantSimulate(kind: EngineMutant): typeof simulate {
  return (r, p, opts = {}): SimulationResult => {
    const { paths, years, values } = r;
    const { initialAssets, annualSpending: S, fee } = p;
    const stride = years + 1;
    const balances = opts.recordBalances ? new Float64Array(paths * stride) : null;
    const ruinYears = new Int32Array(paths);
    let successCount = 0;
    for (let i = 0; i < paths; i++) {
      let b = initialAssets;
      if (balances) balances[i * stride] = b;
      if (kind === 'withdrawAtYear0' && b - S <= 0) ruinYears[i] = 1;
      for (let t = 0; t < years && ruinYears[i] === 0; t++) {
        const g = kind === 'feeAdded' ? growthFactor(values[i * years + t] as number, -fee) : growthFactor(values[i * years + t] as number, fee);
        const next = kind === 'withdrawAfterGrowth' ? b * g - S : b - S;
        if (next <= 0) {
          ruinYears[i] = t + 1;
          b = 0;
          break;
        }
        b = kind === 'withdrawAfterGrowth' ? next : next * g;
        if (balances) balances[i * stride + t + 1] = b;
      }
      let ok = ruinYears[i] === 0 && b > 0;
      if (kind === 'invertSuccess') ok = !ok;
      if (kind === 'preserveCapital') ok = ruinYears[i] === 0 && b >= initialAssets;
      if (ok) successCount++;
    }
    return { paths, years, successCount, successRate: successCount / paths, ruinYears, balances };
  };
}

export const engineMutant = (kind: EngineMutant): Impl => ({ ...realImpl, simulate: mutantSimulate(kind) });

/** 呼ぶたびにシードがずれるブートストラップ（再現性の破れ）。 */
export function nondeterministicBootstrap(): Impl {
  let calls = 0;
  return {
    ...realImpl,
    bootstrapPaths: (s, y, p, seed, l) => bootstrapPaths(s, y, p, (seed + calls++) >>> 0, l),
  };
}

/** JPY の実質化でインフレ調整を忘れる: (1 + r)(1 + Δfx) − 1。 */
export const jpyWithoutInflation: Impl = {
  ...realImpl,
  realReturnSeries: (data, asset, currency): RealReturnSeries => {
    const got = realReturnSeries(data, asset, currency);
    const period = commonPeriod(data, asset, currency);
    if (currency === 'USD' || period === null) return got;
    const a = data.assets[asset];
    const fx = data.macro.usdjpy_change;
    const values = got.values.map((_, i) => {
      const y = period.startYear + i;
      return (1 + (a.values[y - a.startYear] as number)) * (1 + (fx.values[y - fx.startYear] as number)) - 1;
    });
    return { ...got, values };
  },
};

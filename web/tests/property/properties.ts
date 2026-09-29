/**
 * spec.md 6.1 の 8 件のプロパティ（案）。各関数は検査対象の実装 Impl を受け取り、fast-check のプロパティを返す。
 * 3 手法（ヒストリカル・ブートストラップ・パラメトリック）すべてについて検査する（ヒストリカルは N ≤ 0 なら対象外）。
 */
import fc from 'fast-check';
import type { AnnualSeries, ReturnsData } from '../../src/core/data';
import type { ReturnPaths, SimulationParams, SimulationResult } from '../../src/core/engine';
import type { Impl } from './impl';

const PATHS = 100;
const METHODS = ['historical', 'bootstrap', 'parametric'] as const;

/** 共通期間の実質リターン系列（10〜40 年）。 */
const seriesArb = fc
  .array(fc.double({ min: -0.4, max: 0.6, noNaN: true }), { minLength: 10, maxLength: 40 })
  .map((a) => Float64Array.from(a));
const seedArb = fc.integer({ min: 0, max: 0xffff_ffff });
const yearsArb = fc.integer({ min: 1, max: 40 });
const assetsArb = fc.double({ min: 100, max: 1e4, noNaN: true });
const ratioArb = fc.double({ min: 0, max: 0.2, noNaN: true }); // 生活費 / 初期資産
const feeArb = fc.double({ min: 0, max: 0.02, noNaN: true });

function generate(impl: Impl, m: (typeof METHODS)[number], s: Float64Array, years: number, seed: number): ReturnPaths | null {
  if (m === 'historical') return impl.historicalPaths(s, years);
  if (m === 'bootstrap') return impl.bootstrapPaths(s, years, PATHS, seed);
  return impl.parametricPaths(s, years, PATHS, seed);
}

/** 手法ごとの成功率。リターン列は生活費・初期資産・信託報酬によらず同じシードで作る。 */
function rates(impl: Impl, s: Float64Array, years: number, seed: number, p: SimulationParams): (number | null)[] {
  return METHODS.map((m) => {
    const r = generate(impl, m, s, years, seed);
    return r === null ? null : impl.simulate(r, p).successRate;
  });
}

/** 1. 年間生活費を増やしても成功率は上がらない。 */
export const p1SpendingMonotone = (impl: Impl) =>
  fc.property(seriesArb, yearsArb, seedArb, assetsArb, ratioArb, ratioArb, feeArb, (s, T, seed, W0, a, b, fee) => {
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    const r1 = rates(impl, s, T, seed, { initialAssets: W0, annualSpending: W0 * lo, fee });
    const r2 = rates(impl, s, T, seed, { initialAssets: W0, annualSpending: W0 * hi, fee });
    return r1.every((x, i) => x === null || (r2[i] as number) <= x);
  });

/** 2. 初期資産を増やしても成功率は下がらない。 */
export const p2AssetsMonotone = (impl: Impl) =>
  fc.property(seriesArb, yearsArb, seedArb, assetsArb, assetsArb, ratioArb, feeArb, (s, T, seed, x, y, ratio, fee) => {
    const [lo, hi] = x <= y ? [x, y] : [y, x];
    const S = lo * ratio;
    const r1 = rates(impl, s, T, seed, { initialAssets: lo, annualSpending: S, fee });
    const r2 = rates(impl, s, T, seed, { initialAssets: hi, annualSpending: S, fee });
    return r1.every((v, i) => v === null || (r2[i] as number) >= v);
  });

/** 3. 生活費 0 のとき成功率 100%。前提: 全パス・全年で 1 + r_real − fee > 0。 */
export const p3ZeroSpending = (impl: Impl) =>
  fc.property(seriesArb, yearsArb, seedArb, assetsArb, feeArb, (s, T, seed, W0, fee) =>
    METHODS.every((m) => {
      const r = generate(impl, m, s, T, seed);
      if (r === null) return true;
      fc.pre(r.values.every((v) => 1 + v - fee > 0));
      return impl.simulate(r, { initialAssets: W0, annualSpending: 0, fee }).successRate === 1;
    }),
  );

/**
 * 4. 期間 0 のとき成功率 100%（生活費が初期資産以上でも）。前提（1 + r_real − fee > 0）は期間 0 では自明に満たす。
 * 「生活費 ≤ 0 かつ初期資産 > 0」のうち生活費 0 は 3 で検査する。負の生活費は入力検証で拒否する（2章）。
 */
export const p4ZeroYears = (impl: Impl) =>
  fc.property(seriesArb, seedArb, assetsArb, fc.double({ min: 0, max: 3, noNaN: true }), feeArb, (s, seed, W0, k, fee) =>
    METHODS.every((m) => {
      const r = generate(impl, m, s, 0, seed);
      return r === null || impl.simulate(r, { initialAssets: W0, annualSpending: W0 * k, fee }).successRate === 1;
    }),
  );

/** 5. 一定リターン r のとき B_T = B0·g^T − S·(g + g² + … + g^T)、g = max(0, 1 + r − fee)。破産しない範囲で照合。 */
export const p5ClosedForm = (impl: Impl) =>
  fc.property(
    fc.double({ min: -0.3, max: 0.3, noNaN: true }),
    yearsArb,
    assetsArb,
    ratioArb,
    feeArb,
    (r, T, B0, ratio, fee) => {
      const S = B0 * ratio;
      const g = Math.max(0, 1 + r - fee);
      let expected = B0;
      for (let t = 1; t <= T; t++) {
        fc.pre(expected - S > 0); // 途中で破産するケースは式の対象外
        expected = B0 * g ** t - S * Array.from({ length: t }, (_, k) => g ** (k + 1)).reduce((x, y) => x + y, 0);
      }
      const res = impl.simulate(
        { paths: 1, years: T, values: new Float64Array(T).fill(r) },
        { initialAssets: B0, annualSpending: S, fee },
        { recordBalances: true },
      );
      const got = res.balances?.[T] as number;
      const scale = B0 * g ** T + S * T * Math.max(1, g ** T);
      return Math.abs(got - expected) <= 1e-9 * scale;
    },
  );

const sameResult = (a: SimulationResult, b: SimulationResult): boolean =>
  a.successCount === b.successCount &&
  a.ruinYears.every((v, i) => v === b.ruinYears[i]) &&
  (a.balances ?? []).every((v, i) => Object.is(v, b.balances?.[i]));

/** 6. 同一シード・同一入力で結果が完全一致（ブートストラップ・パラメトリック。ヒストリカルは乱数を使わない）。 */
export const p6Deterministic = (impl: Impl) =>
  fc.property(seriesArb, yearsArb, seedArb, assetsArb, ratioArb, feeArb, (s, T, seed, W0, ratio, fee) =>
    METHODS.every((m) => {
      const p = { initialAssets: W0, annualSpending: W0 * ratio, fee };
      const a = generate(impl, m, s, T, seed);
      const b = generate(impl, m, s, T, seed);
      if (a === null || b === null) return a === b;
      return sameResult(impl.simulate(a, p, { recordBalances: true }), impl.simulate(b, p, { recordBalances: true }));
    }),
  );

/** 7. 為替変化率が全期間 0、日米のインフレが同一なら、JPY の実質リターン系列と結果は USD と一致。 */
export const p7FxZero = (impl: Impl) =>
  fc.property(
    fc.array(fc.tuple(fc.double({ min: -0.4, max: 0.6, noNaN: true }), fc.double({ min: -0.02, max: 0.15, noNaN: true })), {
      minLength: 10,
      maxLength: 40,
    }),
    yearsArb,
    seedArb,
    assetsArb,
    ratioArb,
    (rows, T, seed, W0, ratio) => {
      const ser = (values: number[]): AnnualSeries => ({ startYear: 1970, values });
      const asset = { ...ser(rows.map(([r]) => r)), label: 'x' };
      const infl = ser(rows.map(([, i]) => i));
      const data: ReturnsData = {
        assets: { SP500: asset, WORLD_DM: asset, GOLD: asset },
        macro: { us_inflation: infl, jp_inflation: infl, usdjpy_change: ser(rows.map(() => 0)) },
        noticeJa: 'x',
      };
      const usd = impl.realReturnSeries(data, 'SP500', 'USD').values;
      const jpy = impl.realReturnSeries(data, 'SP500', 'JPY').values;
      if (!usd.every((v, i) => Object.is(v, jpy[i]))) return false;
      const p = { initialAssets: W0, annualSpending: W0 * ratio, fee: 0.001 };
      return METHODS.every((m) => {
        const a = generate(impl, m, usd, T, seed);
        const b = generate(impl, m, jpy, T, seed);
        return a === null || b === null ? a === b : sameResult(impl.simulate(a, p), impl.simulate(b, p));
      });
    },
  );

/**
 * 8. 信託報酬を増やしても成功率は上がらない。
 * 報酬 0〜2% の差では成功率が動かないことが多いため、より強い「各パスの最終残高も増えない」も併せて検査する
 * （パスごとに残高が増えなければ成功率も上がらないので、仕様の性質を含む）。
 */
export const p8FeeMonotone = (impl: Impl) =>
  fc.property(seriesArb, yearsArb, seedArb, assetsArb, ratioArb, feeArb, feeArb, (s, T, seed, W0, ratio, f1, f2) => {
    const [lo, hi] = f1 <= f2 ? [f1, f2] : [f2, f1];
    return METHODS.every((m) => {
      const r = generate(impl, m, s, T, seed);
      if (r === null) return true;
      const a = impl.simulate(r, { initialAssets: W0, annualSpending: W0 * ratio, fee: lo }, { recordBalances: true });
      const b = impl.simulate(r, { initialAssets: W0, annualSpending: W0 * ratio, fee: hi }, { recordBalances: true });
      const last = (x: SimulationResult, p: number) => x.balances?.[p * (T + 1) + T] as number;
      return b.successRate <= a.successRate && Array.from({ length: r.paths }, (_, p) => last(b, p) <= last(a, p)).every(Boolean);
    });
  });

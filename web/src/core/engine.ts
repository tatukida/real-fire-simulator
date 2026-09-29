/**
 * 取り崩しシミュレーションのエンジン（spec.md 3.1、7章 決定済み 3）。
 *
 * 各パス・各年 t = 1..T について:
 *   1. 期初に生活費 S を取り崩す: b = B − S
 *   2. b ≤ 0 なら破産（破産年 = t）。以降の残高は 0 固定。
 *   3. そうでなければ B = b · max(0, 1 + r_real − fee)
 * 成功 = 破産せず、期間終了時の残高 > 0。T = 0 のときは全パス成功（成功率 100%）。
 * 金額はすべて実質（spec.md 3.1）。r_real は信託報酬を引く前の実質リターン。
 */

/** リターン列の行列。values[p * years + t] はパス p の t+1 年目の実質リターン（信託報酬を引く前）。 */
export interface ReturnPaths {
  readonly paths: number;
  readonly years: number;
  readonly values: Float64Array;
}

export interface SimulationParams {
  /** 初期資産（> 0） */
  readonly initialAssets: number;
  /** 年間生活費（実質、≥ 0） */
  readonly annualSpending: number;
  /** 信託報酬（年率、小数。0.001 = 0.1%。≥ 0） */
  readonly fee: number;
}

export interface SimulationResult {
  readonly paths: number;
  readonly years: number;
  readonly successCount: number;
  /** 成功パス数 / 全パス数（0〜1） */
  readonly successRate: number;
  /** パスごとの破産年（1..T）。破産しなかったパスは 0。 */
  readonly ruinYears: Int32Array;
  /** recordBalances のとき、balances[p * (years + 1) + t] は年 t 末（t = 0 は初期資産）の残高。それ以外は null。 */
  readonly balances: Float64Array | null;
}

export function validateReturnPaths(r: ReturnPaths): void {
  if (!Number.isInteger(r.paths) || r.paths < 1) throw new RangeError(`パス数が不正: ${r.paths}`);
  if (!Number.isInteger(r.years) || r.years < 0) throw new RangeError(`期間が不正: ${r.years}`);
  if (r.values.length !== r.paths * r.years) {
    throw new RangeError(`values の長さ ${r.values.length} ≠ パス数 × 期間 ${r.paths * r.years}`);
  }
}

function validateParams(p: SimulationParams): void {
  if (!Number.isFinite(p.initialAssets) || p.initialAssets <= 0) throw new RangeError(`初期資産が不正: ${p.initialAssets}`);
  if (!Number.isFinite(p.annualSpending) || p.annualSpending < 0) {
    throw new RangeError(`年間生活費が不正: ${p.annualSpending}`);
  }
  if (!Number.isFinite(p.fee) || p.fee < 0) throw new RangeError(`信託報酬が不正: ${p.fee}`);
}

/** 1 年分の残高倍率 max(0, 1 + r_real − fee)（spec.md 7章 決定済み 3）。 */
export function growthFactor(realReturn: number, fee: number): number {
  return Math.max(0, 1 + realReturn - fee);
}

export function simulate(
  r: ReturnPaths,
  p: SimulationParams,
  opts: { readonly recordBalances?: boolean } = {},
): SimulationResult {
  validateReturnPaths(r);
  validateParams(p);
  const { paths, years, values } = r;
  const { initialAssets, annualSpending, fee } = p;
  const stride = years + 1;
  const balances = opts.recordBalances ? new Float64Array(paths * stride) : null;
  const ruinYears = new Int32Array(paths);
  let successCount = 0;

  for (let i = 0; i < paths; i++) {
    const base = i * years;
    let b = initialAssets;
    if (balances) balances[i * stride] = b;
    for (let t = 0; t < years; t++) {
      const afterWithdrawal = b - annualSpending;
      if (afterWithdrawal <= 0) {
        ruinYears[i] = t + 1;
        b = 0;
        break;
      }
      b = afterWithdrawal * growthFactor(values[base + t] as number, fee);
      if (balances) balances[i * stride + t + 1] = b;
    }
    // 破産後の残高は 0 固定（Float64Array の初期値 0 のまま）。
    if (ruinYears[i] === 0 && b > 0) successCount++;
  }

  return { paths, years, successCount, successRate: successCount / paths, ruinYears, balances };
}

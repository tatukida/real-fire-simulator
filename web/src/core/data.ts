/**
 * 配信データ（returns.json）の型・検証と、実質リターン系列の合成。
 *
 * 実質化の式は Python の fire_data.transform.real_return と同一（演算順も同じにして、ビット単位で一致させる）:
 *   USD: (1 + r) / (1 + π_US) − 1
 *   JPY: (1 + r) · (1 + Δfx) / (1 + π_JP) − 1   （Δfx = 円/ドルの年次変化率。円安で正）
 */

export const RETURNS_SCHEMA_VERSION = 1;

export const CURRENCIES = ['USD', 'JPY'] as const;
export type Currency = (typeof CURRENCIES)[number];

export const ASSET_IDS = ['SP500', 'WORLD_DM', 'GOLD'] as const;
export type AssetId = (typeof ASSET_IDS)[number];

const MACRO_IDS = ['us_inflation', 'usdjpy_change', 'jp_inflation'] as const;
type MacroId = (typeof MACRO_IDS)[number];

export interface AnnualSeries {
  readonly startYear: number;
  readonly values: readonly number[];
}

export interface AssetSeries extends AnnualSeries {
  readonly label: string;
}

export interface ReturnsData {
  readonly assets: Readonly<Record<AssetId, AssetSeries>>;
  readonly macro: Readonly<Record<MacroId, AnnualSeries>>;
  readonly noticeJa: string;
}

/** 通貨・資産ごとの実質リターン系列（共通期間）。values[i] は startYear + i 年のリターン。 */
export interface RealReturnSeries {
  readonly currency: Currency;
  readonly asset: AssetId;
  readonly startYear: number;
  readonly endYear: number;
  readonly values: Float64Array;
}

function record(v: unknown, where: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`${where}: オブジェクトではありません`);
  return v as Record<string, unknown>;
}

function series(v: unknown, where: string): AnnualSeries {
  const r = record(v, where);
  const { start_year: startYear, values } = r;
  if (typeof startYear !== 'number' || !Number.isInteger(startYear)) throw new Error(`${where}: start_year が不正`);
  if (!Array.isArray(values) || values.length === 0) throw new Error(`${where}: values が空`);
  for (const x of values) {
    if (typeof x !== 'number' || !Number.isFinite(x) || x <= -1) throw new Error(`${where}: 値が不正 (${String(x)})`);
  }
  return { startYear, values: values as number[] };
}

/** fetch した JSON を検証して ReturnsData にする。形が違えば例外。 */
export function parseReturnsData(json: unknown): ReturnsData {
  const root = record(json, 'returns.json');
  if (root.schema_version !== RETURNS_SCHEMA_VERSION) {
    throw new Error(`returns.json: schema_version ${String(root.schema_version)} は未対応`);
  }
  const assetsIn = record(root.assets, 'assets');
  const macroIn = record(root.macro, 'macro');
  const assets = {} as Record<AssetId, AssetSeries>;
  for (const id of ASSET_IDS) {
    const label = record(assetsIn[id], `assets.${id}`).label;
    if (typeof label !== 'string') throw new Error(`assets.${id}: label が不正`);
    assets[id] = { ...series(assetsIn[id], `assets.${id}`), label };
  }
  const macro = {} as Record<MacroId, AnnualSeries>;
  for (const id of MACRO_IDS) macro[id] = series(macroIn[id], `macro.${id}`);
  const noticeJa = record(root.attribution, 'attribution').notice_ja;
  if (typeof noticeJa !== 'string' || noticeJa.length === 0) throw new Error('attribution.notice_ja が空');
  return { assets, macro, noticeJa };
}

export function endYear(s: AnnualSeries): number {
  return s.startYear + s.values.length - 1;
}

function at(s: AnnualSeries, year: number): number {
  return s.values[year - s.startYear] as number;
}

/** 1 年分の実質リターン。 */
export function realReturn(
  nominalUsd: number,
  currency: Currency,
  m: { usInflation?: number; fxChange?: number; jpInflation?: number },
): number {
  if (currency === 'USD') {
    if (m.usInflation === undefined) throw new Error('USD には usInflation が必要');
    return (1 + nominalUsd) / (1 + m.usInflation) - 1;
  }
  if (m.fxChange === undefined || m.jpInflation === undefined) throw new Error('JPY には fxChange と jpInflation が必要');
  return ((1 + nominalUsd) * (1 + m.fxChange)) / (1 + m.jpInflation) - 1;
}

/** 通貨・資産の組み合わせで必要な系列（資産 + マクロ）。 */
function requiredSeries(data: ReturnsData, asset: AssetId, currency: Currency): AnnualSeries[] {
  const a = data.assets[asset];
  return currency === 'USD' ? [a, data.macro.us_inflation] : [a, data.macro.usdjpy_change, data.macro.jp_inflation];
}

/** 必要な系列がすべてそろう共通期間。重なりがなければ null。 */
export function commonPeriod(
  data: ReturnsData,
  asset: AssetId,
  currency: Currency,
): { startYear: number; endYear: number; years: number } | null {
  const req = requiredSeries(data, asset, currency);
  const start = Math.max(...req.map((s) => s.startYear));
  const end = Math.min(...req.map(endYear));
  return end < start ? null : { startYear: start, endYear: end, years: end - start + 1 };
}

/** 共通期間の実質リターン系列（信託報酬を引く前）。 */
export function realReturnSeries(data: ReturnsData, asset: AssetId, currency: Currency): RealReturnSeries {
  const p = commonPeriod(data, asset, currency);
  if (p === null) throw new Error(`${asset} × ${currency}: 共通期間がありません`);
  const values = new Float64Array(p.years);
  const { assets, macro } = data;
  for (let i = 0; i < p.years; i++) {
    const y = p.startYear + i;
    values[i] =
      currency === 'USD'
        ? realReturn(at(assets[asset], y), 'USD', { usInflation: at(macro.us_inflation, y) })
        : realReturn(at(assets[asset], y), 'JPY', {
            fxChange: at(macro.usdjpy_change, y),
            jpInflation: at(macro.jp_inflation, y),
          });
  }
  return { currency, asset, startYear: p.startYear, endYear: p.endYear, values };
}

/**
 * ヒストリカル手法の開始年数 N = 共通期間の年数 − FIRE期間 + 1（spec.md 4章 項目9）。
 * 期間が共通期間より長いと 0 以下になる（その場合の扱いは spec.md の未決事項で確定させる）。
 */
export function historicalStartCount(periodYears: number, fireYears: number): number {
  return periodYears - fireYears + 1;
}

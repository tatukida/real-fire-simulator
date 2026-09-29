import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ASSET_IDS,
  CURRENCIES,
  commonPeriod,
  historicalStartCount,
  parseReturnsData,
  realReturn,
  realReturnSeries,
  type AssetId,
  type Currency,
} from '../../src/core/data';

const readJson = (rel: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8'));

const raw = readJson('../../../data/processed/returns.json');
const data = parseReturnsData(raw);

// Python（fire_data.transform.real_return）が出力したベクタ。生成: pipeline/reference/real_vectors.py
interface RealVectors {
  combos: Record<string, { start_year: number; end_year: number; values: number[] }>;
}
const V = readJson('../../../pipeline/reference/fixtures/real_returns_vectors.json') as RealVectors;

const combos: [Currency, AssetId][] = CURRENCIES.flatMap((c) => ASSET_IDS.map((a): [Currency, AssetId] => [c, a]));

describe('実質リターンの合成（Python と照合）', () => {
  it.each(combos)('%s × %s: 共通期間と全年の実質リターンが Python と完全一致する', (currency, asset) => {
    const want = V.combos[`${currency}_${asset}`];
    if (want === undefined) throw new Error('ベクタがありません');
    const got = realReturnSeries(data, asset, currency);
    expect([got.startYear, got.endYear]).toEqual([want.start_year, want.end_year]);
    expect(Array.from(got.values)).toEqual(want.values);
  });

  it('為替変化 0・日米インフレが同じなら JPY と USD は一致する', () => {
    for (const r of [-0.4, -0.01, 0, 0.07, 1.2]) {
      for (const pi of [-0.02, 0, 0.03, 0.12]) {
        const usd = realReturn(r, 'USD', { usInflation: pi });
        const jpy = realReturn(r, 'JPY', { fxChange: 0, jpInflation: pi });
        expect(jpy).toBe(usd);
      }
    }
  });

  it('必要なマクロ系列がなければ例外', () => {
    expect(() => realReturn(0.1, 'USD', {})).toThrow();
    expect(() => realReturn(0.1, 'JPY', { fxChange: 0 })).toThrow();
  });
});

describe('共通期間と N（ヒストリカルの開始年数）', () => {
  it.each([
    // [通貨, 資産, FIRE期間, 開始年, 終了年, 年数, N]
    ['USD', 'SP500', 30, 1928, 2025, 98, 69],
    ['JPY', 'WORLD_DM', 30, 1972, 2020, 49, 20],
    ['JPY', 'SP500', 30, 1972, 2025, 54, 25],
    ['JPY', 'GOLD', 30, 1972, 2025, 54, 25],
    // spec.md 4章 項目9 の例
    ['USD', 'WORLD_DM', 30, 1950, 2020, 71, 42],
    ['USD', 'GOLD', 50, 1972, 2025, 54, 5],
  ] as const)('%s × %s・%i 年: %i〜%i 年（%i 年）で N = %i', (currency, asset, T, start, end, years, n) => {
    const p = commonPeriod(data, asset, currency);
    expect(p).toEqual({ startYear: start, endYear: end, years });
    expect(historicalStartCount(years, T)).toBe(n);
  });

  it('期間が共通期間と同じなら N = 1、1 年でも長ければ N = 0', () => {
    expect(historicalStartCount(54, 54)).toBe(1);
    expect(historicalStartCount(54, 55)).toBe(0);
    expect(historicalStartCount(54, 60)).toBe(-5);
  });
});

describe('parseReturnsData', () => {
  const clone = (): Record<string, unknown> => JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;

  it('出所表記を内容を変えずに保持する', () => {
    const notice = ((raw as Record<string, unknown>).attribution as Record<string, unknown>).notice_ja;
    expect(data.noticeJa).toBe(notice);
  });

  it('schema_version が違えば例外', () => {
    const d = clone();
    d.schema_version = 2;
    expect(() => parseReturnsData(d)).toThrow(/schema_version/);
  });

  it('資産が欠けていれば例外', () => {
    const d = clone();
    delete (d.assets as Record<string, unknown>).GOLD;
    expect(() => parseReturnsData(d)).toThrow(/GOLD/);
  });

  it('−100% 以下や非数の値があれば例外', () => {
    for (const bad of [-1, Number.NaN, '0.1']) {
      const d = clone();
      ((d.macro as Record<string, { values: unknown[] }>).jp_inflation as { values: unknown[] }).values[3] = bad;
      expect(() => parseReturnsData(d)).toThrow(/jp_inflation/);
    }
  });

  it('出所表記が空なら例外', () => {
    const d = clone();
    (d.attribution as Record<string, unknown>).notice_ja = '';
    expect(() => parseReturnsData(d)).toThrow(/notice_ja/);
  });
});

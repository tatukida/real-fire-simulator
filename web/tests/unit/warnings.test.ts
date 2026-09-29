import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { commonPeriod, parseReturnsData } from '../../src/core/data';
import { historicalPaths } from '../../src/core/generators';
import { CAUTION_TEXT, NO_HISTORY_LABEL, REFERENCE_LABEL, sampleWarning, STRONG_TEXT } from '../../src/core/warnings';

const Y = 54; // 共通期間の年数（GOLD × USD の 1972〜2025 と同じ長さ）

describe('N の境界（共通期間 54 年、N = 54 − T + 1）', () => {
  it.each([
    // [N, 段階, ヒストリカルを計算するか, ラベル, 文言]
    [20, 'none', true, null, null],
    [19, 'caution', true, null, CAUTION_TEXT],
    [10, 'caution', true, null, CAUTION_TEXT],
    [9, 'strong', true, REFERENCE_LABEL, STRONG_TEXT],
    [1, 'strong', true, REFERENCE_LABEL, STRONG_TEXT],
    [0, 'noHistory', false, NO_HISTORY_LABEL, STRONG_TEXT],
    [-5, 'noHistory', false, NO_HISTORY_LABEL, STRONG_TEXT],
  ] as const)('N = %d → %s', (n, level, available, label, message) => {
    const w = sampleWarning(Y, Y - n + 1);
    expect(w).toEqual({ startCount: n, level, historicalAvailable: available, historicalLabel: label, message });
  });

  it('T == 共通期間の年数 なら N = 1: ヒストリカルは計算し、強い注意と「参考値」', () => {
    const w = sampleWarning(Y, Y);
    expect(w.startCount).toBe(1);
    expect(w.level).toBe('strong');
    expect(w.historicalLabel).toBe('参考値');
  });
  it('T > 共通期間の年数 なら N ≤ 0: ヒストリカルは計算せず「過去実績が不足」と強い注意', () => {
    for (const t of [Y + 1, Y + 2, 60]) {
      const w = sampleWarning(Y, t);
      expect(w.historicalAvailable).toBe(false);
      expect(w.historicalLabel).toBe('過去実績が不足');
      expect(w.message).toBe(STRONG_TEXT);
    }
  });
  it('T = 0 なら N = 期間 + 1', () => {
    expect(sampleWarning(5, 0)).toMatchObject({ startCount: 6, level: 'strong' });
  });
});

describe('文言（spec.md 4章 項目9）', () => {
  it('注意は spec の文言を含み、どちらも窓の重なりに触れる', () => {
    expect(CAUTION_TEXT).toContain('過去実績の標本が少ないため、参考程度に見てください');
    for (const t of [CAUTION_TEXT, STRONG_TEXT]) expect(t).toContain('独立な標本の数は N よりさらに少なく');
  });
});

describe('ヒストリカル生成器との整合', () => {
  it.each([1, 5, 9, 10, 11, 12, 30])('共通期間 10 年・T = %d: 計算の有無と開始年数が一致', (t) => {
    const w = sampleWarning(10, t);
    const h = historicalPaths(new Float64Array(10), t);
    expect(h !== null).toBe(w.historicalAvailable);
    if (h !== null) expect(h.paths).toBe(w.startCount);
  });
});

describe('実データ（spec.md 4章 項目9 の例）', () => {
  const path = fileURLToPath(new URL('../../../data/processed/returns.json', import.meta.url));
  const data = parseReturnsData(JSON.parse(readFileSync(path, 'utf-8')));
  it('GOLD × USD（1972〜2025）・50 年は N = 5 で強い注意', () => {
    const p = commonPeriod(data, 'GOLD', 'USD');
    expect(p).toEqual({ startYear: 1972, endYear: 2025, years: 54 });
    expect(sampleWarning(p?.years ?? 0, 50)).toMatchObject({ startCount: 5, level: 'strong' });
  });
  it('WORLD_DM × USD（1950〜2020）・30 年は N = 42 で表示なし', () => {
    const p = commonPeriod(data, 'WORLD_DM', 'USD');
    expect(p?.years).toBe(71);
    expect(sampleWarning(p?.years ?? 0, 30)).toMatchObject({ startCount: 42, level: 'none' });
  });
});

describe('入力の検証', () => {
  it.each([
    [0, 10],
    [1.5, 10],
    [10, -1],
    [10, 2.5],
    [Number.NaN, 1],
  ])('共通期間 %f・T = %f は例外', (y, t) => {
    expect(() => sampleWarning(y, t)).toThrow(RangeError);
  });
});

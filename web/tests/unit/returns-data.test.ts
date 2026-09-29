import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RETURNS_SCHEMA_VERSION } from '../../src/core/index';

// 配信データ（data/processed/returns.json）と core が前提とする形が一致していることを確認する。
const path = fileURLToPath(new URL('../../../data/processed/returns.json', import.meta.url));
const doc: unknown = JSON.parse(readFileSync(path, 'utf-8'));

interface Series {
  start_year: number;
  values: number[];
}

function asRecord(v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null) throw new Error('object expected');
  return v as Record<string, unknown>;
}

function asSeries(v: unknown): Series {
  const r = asRecord(v);
  if (typeof r.start_year !== 'number' || !Array.isArray(r.values)) throw new Error('series expected');
  return { start_year: r.start_year, values: r.values as number[] };
}

describe('returns.json', () => {
  const root = asRecord(doc);

  it('schema_version が core の想定と一致する', () => {
    expect(root.schema_version).toBe(RETURNS_SCHEMA_VERSION);
  });

  it('3資産と3つのマクロ系列がそろい、値はすべて有限で -100% より大きい', () => {
    const assets = asRecord(root.assets);
    const macro = asRecord(root.macro);
    expect(Object.keys(assets).sort()).toEqual(['GOLD', 'SP500', 'WORLD_DM']);
    expect(Object.keys(macro).sort()).toEqual(['jp_inflation', 'us_inflation', 'usdjpy_change']);
    for (const s of [...Object.values(assets), ...Object.values(macro)].map(asSeries)) {
      expect(Number.isInteger(s.start_year)).toBe(true);
      expect(s.values.length).toBeGreaterThan(0);
      for (const v of s.values) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThan(-1);
      }
    }
  });

  it('attribution.notice_ja が空でない（画面に常時表示するため）', () => {
    const notice = asRecord(root.attribution).notice_ja;
    expect(typeof notice).toBe('string');
    expect((notice as string).length).toBeGreaterThan(0);
  });
});

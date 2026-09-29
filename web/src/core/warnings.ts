/**
 * 標本不足の注意表示（spec.md 4章 項目9、7章 決定済み 10）。
 *
 * N = 共通期間の年数 − FIRE期間 + 1（ヒストリカル手法の開始年数）。
 * - N ≥ 20: 表示なし
 * - 10 ≤ N < 20: 注意
 * - 1 ≤ N < 10: 強い注意。ヒストリカルの成功率に「参考値」ラベル
 * - N ≤ 0: ヒストリカルは計算しない。成功率の代わりに「過去実績が不足」と表示し、強い注意を出す
 * 閾値（20 / 10）は暫定値（spec.md 7章 未決事項 5）。
 * 強い注意の文言は spec に定めがないため、2026-09-29 に人間が承認した案を使う。
 */

import { historicalStartCount } from './data';

export const CAUTION_THRESHOLD = 20;
export const STRONG_THRESHOLD = 10;

const OVERLAP_NOTE = '開始年の期間は互いに重なっているため、独立な標本の数は N よりさらに少なくなります。';
export const CAUTION_TEXT = `過去実績の標本が少ないため、参考程度に見てください。${OVERLAP_NOTE}`;
export const STRONG_TEXT = `過去実績の標本が非常に少ないため、ヒストリカルの成功率は参考値です。${OVERLAP_NOTE}`;
export const REFERENCE_LABEL = '参考値';
export const NO_HISTORY_LABEL = '過去実績が不足';

export type SampleWarningLevel = 'none' | 'caution' | 'strong' | 'noHistory';

export interface SampleWarning {
  /** ヒストリカル手法の開始年数 N（0 以下もありうる） */
  readonly startCount: number;
  readonly level: SampleWarningLevel;
  /** ヒストリカル手法を計算するか（N ≥ 1） */
  readonly historicalAvailable: boolean;
  /** ヒストリカルの成功率に付けるラベル（または成功率の代わりの表示）。なければ null */
  readonly historicalLabel: typeof REFERENCE_LABEL | typeof NO_HISTORY_LABEL | null;
  /** 成功率の近くに出す注意文。なければ null */
  readonly message: typeof CAUTION_TEXT | typeof STRONG_TEXT | null;
}

/** 共通期間の年数 periodYears（≥ 1）と FIRE期間 fireYears（≥ 0）から注意表示を決める。 */
export function sampleWarning(periodYears: number, fireYears: number): SampleWarning {
  if (!Number.isInteger(periodYears) || periodYears < 1) throw new RangeError(`共通期間の年数が不正: ${periodYears}`);
  if (!Number.isInteger(fireYears) || fireYears < 0) throw new RangeError(`FIRE期間が不正: ${fireYears}`);
  const n = historicalStartCount(periodYears, fireYears);
  if (n <= 0) {
    return { startCount: n, level: 'noHistory', historicalAvailable: false, historicalLabel: NO_HISTORY_LABEL, message: STRONG_TEXT };
  }
  if (n < STRONG_THRESHOLD) {
    return { startCount: n, level: 'strong', historicalAvailable: true, historicalLabel: REFERENCE_LABEL, message: STRONG_TEXT };
  }
  if (n < CAUTION_THRESHOLD) {
    return { startCount: n, level: 'caution', historicalAvailable: true, historicalLabel: null, message: CAUTION_TEXT };
  }
  return { startCount: n, level: 'none', historicalAvailable: true, historicalLabel: null, message: null };
}

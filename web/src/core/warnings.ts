/**
 * 標本不足の注意表示（spec.md 4章 項目9、7章 決定済み 10）。
 *
 * N = 共通期間の年数 − FIRE期間 + 1（ヒストリカル手法の開始年数）。
 * - N ≥ 20: 表示なし
 * - 10 ≤ N < 20: 注意
 * - 1 ≤ N < 10: 強い注意。ヒストリカルの成功率に「参考値」ラベル
 * - N ≤ 0: ヒストリカルは計算しない。成功率の代わりに「過去実績が不足」と表示し、他の 2 手法を見るよう促す
 * 閾値（20 / 10）は暫定値（spec.md 7章 未決事項 5）。
 * 強い注意と N ≤ 0 の文言は spec に定めがないため、人間が承認した文言を使う（ADR-0003）。
 */

import { historicalStartCount } from './data';

export const CAUTION_THRESHOLD = 20;
export const STRONG_THRESHOLD = 10;

/** 注意表示の文言（spec.md 4章 項目9、7章 決定済み 10）。n は開始年数 N。 */
export const WARNING_TEXTS = {
  caution: (n: number): string => `過去実績の標本が少ないため、参考程度に見てください。${overlapNote(n)}`,
  strong: (n: number): string => `過去実績の標本が非常に少ないため、ヒストリカルの成功率は参考値です。${overlapNote(n)}`,
  noHistory: '過去実績が不足しているため、過去実績方式は計算できません。ブートストラップとパラメトリックの結果をご覧ください。',
  referenceLabel: '参考値',
  noHistoryLabel: '過去実績が不足',
} as const;

function overlapNote(n: number): string {
  return `開始年の期間は互いに重なっているため、独立な標本の数は開始年の数（${n}）よりさらに少なくなります。`;
}

export type SampleWarningLevel = 'none' | 'caution' | 'strong' | 'noHistory';

export interface SampleWarning {
  /** ヒストリカル手法の開始年数 N（0 以下もありうる） */
  readonly startCount: number;
  readonly level: SampleWarningLevel;
  /** ヒストリカル手法を計算するか（N ≥ 1） */
  readonly historicalAvailable: boolean;
  /** ヒストリカルの成功率に付けるラベル（または成功率の代わりの表示）。なければ null */
  readonly historicalLabel: typeof WARNING_TEXTS.referenceLabel | typeof WARNING_TEXTS.noHistoryLabel | null;
  /** 成功率の近くに出す注意文。なければ null */
  readonly message: string | null;
}

/** 共通期間の年数 periodYears（≥ 1）と FIRE期間 fireYears（≥ 0）から注意表示を決める。 */
export function sampleWarning(periodYears: number, fireYears: number): SampleWarning {
  if (!Number.isInteger(periodYears) || periodYears < 1) throw new RangeError(`共通期間の年数が不正: ${periodYears}`);
  if (!Number.isInteger(fireYears) || fireYears < 0) throw new RangeError(`FIRE期間が不正: ${fireYears}`);
  const n = historicalStartCount(periodYears, fireYears);
  if (n <= 0) {
    return { startCount: n, level: 'noHistory', historicalAvailable: false, historicalLabel: WARNING_TEXTS.noHistoryLabel, message: WARNING_TEXTS.noHistory };
  }
  if (n < STRONG_THRESHOLD) {
    return { startCount: n, level: 'strong', historicalAvailable: true, historicalLabel: WARNING_TEXTS.referenceLabel, message: WARNING_TEXTS.strong(n) };
  }
  if (n < CAUTION_THRESHOLD) {
    return { startCount: n, level: 'caution', historicalAvailable: true, historicalLabel: null, message: WARNING_TEXTS.caution(n) };
  }
  return { startCount: n, level: 'none', historicalAvailable: true, historicalLabel: null, message: null };
}

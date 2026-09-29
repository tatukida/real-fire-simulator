/**
 * Worker とのメッセージの型と、入口での入力検証（spec.md 2章）。
 * 結果は集計値だけ（core/run.ts の RunResult）。全パスの残高行列は送らない。
 */

import type { RunInput, RunResult } from '../core/run';

export const MAX_FIRE_YEARS = 60;
export const MAX_PATHS = 50_000;
export const MAX_FEE = 0.02;
const U32 = 2 ** 32;

export interface RunRequest {
  readonly type: 'run';
  /** リクエスト ID。応答に同じ値が付く。クライアントは最新の ID 以外の応答を捨てる */
  readonly id: number;
  readonly input: RunInput;
}

export type WorkerRequest = RunRequest;

export interface RunResponse {
  readonly type: 'result';
  readonly id: number;
  readonly result: RunResult;
}

export interface ErrorResponse {
  readonly type: 'error';
  /** リクエスト ID が読めなかった場合は null */
  readonly id: number | null;
  readonly message: string;
}

export type WorkerResponse = RunResponse | ErrorResponse;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const isNum = (v: unknown, min: number, max: number = Infinity): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

function toSeries(v: unknown): Float64Array | null {
  const arr = v instanceof Float64Array ? v : Array.isArray(v) && v.every((x) => typeof x === 'number') ? Float64Array.from(v) : null;
  if (arr === null || arr.length < 2) return null;
  return arr.every(Number.isFinite) ? arr : null;
}

/** リクエスト ID（非負の整数）。読めなければ null。 */
export function requestId(msg: unknown): number | null {
  return isRecord(msg) && isInt(msg.id, 0, Number.MAX_SAFE_INTEGER) ? msg.id : null;
}

/** 入力を検証する。不正なら理由の文字列の配列（空でない）を返す。 */
export function validateRunInput(v: unknown): RunInput | string[] {
  if (!isRecord(v)) return ['入力がオブジェクトではありません'];
  const errors: string[] = [];
  const series = toSeries(v.series);
  if (series === null) errors.push('リターン系列は 2 年以上の有限な数値の配列にしてください');
  if (!isInt(v.years, 1, MAX_FIRE_YEARS)) errors.push(`FIRE 期間は 1〜${MAX_FIRE_YEARS} 年の整数にしてください`);
  if (!isInt(v.paths, 1, MAX_PATHS)) errors.push(`パス数は 1〜${MAX_PATHS} の整数にしてください`);
  if (!isInt(v.seed, 0, U32 - 1)) errors.push(`シードは 0〜${U32 - 1} の整数にしてください`);
  if (!isNum(v.initialAssets, 0) || v.initialAssets <= 0) errors.push('初期資産は 0 より大きい数値にしてください');
  if (!isNum(v.annualSpending, 0)) errors.push('年間生活費は 0 以上の数値にしてください');
  if (!isNum(v.fee, 0, MAX_FEE)) errors.push(`信託報酬は 0〜${MAX_FEE * 100}% にしてください`);
  if (v.blockLength !== undefined && !isInt(v.blockLength, 1, Number.MAX_SAFE_INTEGER)) {
    errors.push('ブロック長は 1 以上の整数にしてください');
  }
  if (v.target !== undefined && (!isNum(v.target, 0, 1) || v.target === 0)) errors.push('目標成功率は 0 より大きく 1 以下にしてください');
  if (errors.length > 0 || series === null) return errors;
  return {
    series,
    years: v.years as number,
    paths: v.paths as number,
    seed: v.seed as number,
    initialAssets: v.initialAssets as number,
    annualSpending: v.annualSpending as number,
    fee: v.fee as number,
    ...(v.blockLength === undefined ? {} : { blockLength: v.blockLength as number }),
    ...(v.target === undefined ? {} : { target: v.target as number }),
  };
}

/**
 * Worker のメッセージ処理。環境（self / worker_threads）に依存しない純粋な関数で、Node のテストやベンチマークからも呼べる。
 * 不正な入力や計算中の例外は、例外で落とさずエラー応答にする。
 */

import { run } from '../core/run';
import { requestId, validateRunInput, type WorkerResponse } from './protocol';

export function handleMessage(msg: unknown, now?: () => number): WorkerResponse {
  const id = requestId(msg);
  if (id === null) return { type: 'error', id: null, message: 'リクエスト ID が不正です' };
  const m = msg as Record<string, unknown>;
  if (m.type !== 'run') return { type: 'error', id, message: `未対応のメッセージ種別です: ${String(m.type)}` };
  const input = validateRunInput(m.input);
  if (Array.isArray(input)) return { type: 'error', id, message: input.join('\n') };
  try {
    return { type: 'result', id, result: run(input, now) };
  } catch (e) {
    return { type: 'error', id, message: `計算中にエラーが発生しました: ${e instanceof Error ? e.message : String(e)}` };
  }
}

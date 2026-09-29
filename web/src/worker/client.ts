/**
 * メインスレッド側のクライアント。リクエストごとに ID を振り、最新でない ID の応答は結果として使わない（'stale'）。
 * Worker は postMessage / onmessage を持つものなら何でもよい（テストでは偽物を渡す）。
 */

import type { RunInput, RunResult } from '../core/run';
import type { WorkerRequest, WorkerResponse } from './protocol';

export interface WorkerLike {
  postMessage(msg: WorkerRequest): void;
  onmessage: ((ev: { readonly data: WorkerResponse }) => void) | null;
}

export type RunOutcome =
  | { readonly status: 'ok'; readonly result: RunResult }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'stale' };

export class SimulationClient {
  private readonly worker: WorkerLike;
  private readonly pending = new Map<number, (o: RunOutcome) => void>();
  private latest = 0;

  constructor(worker: WorkerLike) {
    this.worker = worker;
    worker.onmessage = (ev) => this.receive(ev.data);
  }

  /** 計算を依頼する。後から別のリクエストを出した場合、この結果は 'stale' になる。 */
  run(input: RunInput): Promise<RunOutcome> {
    const id = ++this.latest;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.worker.postMessage({ type: 'run', id, input });
    });
  }

  private receive(res: WorkerResponse): void {
    // ID が読めない応答（送信側の不具合）は、最新のリクエストの失敗として扱う。
    const id = res.id ?? this.latest;
    if (id !== this.latest) return this.settle(id, { status: 'stale' });
    this.settle(id, res.type === 'result' ? { status: 'ok', result: res.result } : { status: 'error', message: res.message });
  }

  private settle(id: number, outcome: RunOutcome): void {
    const resolve = this.pending.get(id);
    this.pending.delete(id);
    resolve?.(outcome);
  }
}

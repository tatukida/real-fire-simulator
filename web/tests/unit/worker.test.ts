import { describe, expect, it } from 'vitest';
import { run, type RunInput } from '../../src/core/run';
import { SimulationClient, type WorkerLike } from '../../src/worker/client';
import { handleMessage } from '../../src/worker/handler';
import type { WorkerRequest, WorkerResponse } from '../../src/worker/protocol';

const series = Float64Array.from({ length: 40 }, (_, i) => 0.05 + 0.18 * Math.sin(i * 1.7));
const input: RunInput = { series, years: 30, paths: 300, seed: 7, initialAssets: 10_000, annualSpending: 400, fee: 0.001 };

describe('handleMessage', () => {
  it('正しいリクエストには同じ ID で run の結果を返す', () => {
    const res = handleMessage({ type: 'run', id: 3, input });
    expect(res).toEqual({ type: 'result', id: 3, result: run(input) });
  });

  it('系列は数値の配列でも受け付ける（Float64Array と同じ結果）', () => {
    const res = handleMessage({ type: 'run', id: 1, input: { ...input, series: Array.from(series) } });
    expect(res).toEqual({ type: 'result', id: 1, result: run(input) });
  });

  it('時計を渡すと timings が付く', () => {
    let t = 0;
    const res = handleMessage({ type: 'run', id: 1, input }, () => (t += 1));
    expect(res.type === 'result' && res.result.timings?.total).toBe(4);
  });

  it('ID が読めなければ id: null のエラー', () => {
    expect(handleMessage(null)).toMatchObject({ type: 'error', id: null });
    expect(handleMessage({ type: 'run', id: -1, input })).toMatchObject({ type: 'error', id: null });
    expect(handleMessage({ type: 'run', id: 1.5, input })).toMatchObject({ type: 'error', id: null });
  });

  it('未対応の種別はエラー', () => {
    expect(handleMessage({ type: 'cancel', id: 2 })).toMatchObject({ type: 'error', id: 2 });
  });

  it.each([
    ['系列が短い', { series: [0.1] }],
    ['系列に NaN', { series: [0.1, Number.NaN, 0.2] }],
    ['系列が数値でない', { series: ['0.1', '0.2'] }],
    ['期間 0', { years: 0 }],
    ['期間 61', { years: 61 }],
    ['期間が小数', { years: 30.5 }],
    ['パス数 0', { paths: 0 }],
    ['パス数 50,001', { paths: 50_001 }],
    ['シードが負', { seed: -1 }],
    ['シードが 2^32', { seed: 2 ** 32 }],
    ['初期資産 0', { initialAssets: 0 }],
    ['初期資産 Infinity', { initialAssets: Infinity }],
    ['生活費が負', { annualSpending: -1 }],
    ['生活費が文字列', { annualSpending: '400' }],
    ['信託報酬 2% 超', { fee: 0.0201 }],
    ['信託報酬が負', { fee: -0.001 }],
    ['ブロック長 0', { blockLength: 0 }],
    ['目標 0', { target: 0 }],
    ['目標 1 超', { target: 1.01 }],
  ])('不正な入力はエラー応答（例外にしない）: %s', (_, patch) => {
    const res = handleMessage({ type: 'run', id: 9, input: { ...input, ...patch } });
    expect(res.type).toBe('error');
    expect(res.id).toBe(9);
  });

  it('入力がオブジェクトでなければエラー', () => {
    expect(handleMessage({ type: 'run', id: 1, input: null })).toMatchObject({ type: 'error', id: 1 });
  });

  it('複数の誤りはまとめて返す', () => {
    const res = handleMessage({ type: 'run', id: 1, input: { ...input, years: 0, paths: 0 } });
    expect(res.type === 'error' && res.message.split('\n')).toHaveLength(2);
  });

  it('境界値（期間 60・パス数 50,000 の上限、信託報酬 2%）は受け付ける', () => {
    const res = handleMessage({ type: 'run', id: 1, input: { ...input, years: 60, paths: 1, fee: 0.02 } });
    expect(res.type).toBe('result');
  });
});

/** postMessage を記録し、応答を任意の順で返せる偽の Worker。 */
class FakeWorker implements WorkerLike {
  onmessage: ((ev: { readonly data: WorkerResponse }) => void) | null = null;
  readonly sent: WorkerRequest[] = [];
  postMessage(msg: WorkerRequest): void {
    this.sent.push(msg);
  }
  reply(i: number): void {
    this.onmessage?.({ data: handleMessage(this.sent[i]) });
  }
}

describe('SimulationClient', () => {
  it('ID を 1 から振り、最新の応答は ok', async () => {
    const w = new FakeWorker();
    const c = new SimulationClient(w);
    const p = c.run(input);
    expect(w.sent[0]).toMatchObject({ type: 'run', id: 1 });
    w.reply(0);
    await expect(p).resolves.toEqual({ status: 'ok', result: run(input) });
  });

  it('新しいリクエストを出した後に届いた古い応答は stale（順不同でも）', async () => {
    const w = new FakeWorker();
    const c = new SimulationClient(w);
    const first = c.run(input);
    const second = c.run({ ...input, annualSpending: 500 });
    w.reply(1);
    w.reply(0);
    await expect(first).resolves.toEqual({ status: 'stale' });
    await expect(second).resolves.toMatchObject({ status: 'ok' });
  });

  it('エラー応答は error', async () => {
    const w = new FakeWorker();
    const c = new SimulationClient(w);
    const p = c.run({ ...input, years: 0 });
    w.reply(0);
    await expect(p).resolves.toMatchObject({ status: 'error' });
  });
});

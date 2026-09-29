/**
 * 性能ベンチマーク（spec.md 5章: 50,000 パス × 40 年 ≤ 2 秒）。
 *
 * 計測範囲は 1 リクエスト全体（2026-09-29, 人間の決定）: Worker への送信から応答の受信まで。
 * 3 手法の生成・シミュレーション・集計と逆算、メッセージの往復を含む。判定は RUNS 回の往復時間の中央値。
 * 1 回目（JIT が温まる前）は参考として別に表示する。ブラウザでの計測はフェーズ4で行う。
 *
 * 実行: cd web && npm run bench（基準を満たさなければ終了コード 1）
 */
import './register.ts';
import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { Worker } from 'node:worker_threads';
import type { RunInput, RunTimings } from '../../src/core/run';
import type { WorkerResponse } from '../../src/worker/protocol';

const { parseReturnsData, realReturnSeries } = await import('../../src/core/index');

const LIMIT_MS = 2000;
const RUNS = 8;
const STAGES = ['generate', 'simulate', 'aggregate', 'solve', 'total'] as const;

// 既定の入力（spec.md 2章: JPY・SP500・5,000万円・200万円・0.1%）で、パス数 50,000・期間 40 年。
const data = parseReturnsData(JSON.parse(readFileSync(new URL('../../../data/processed/returns.json', import.meta.url), 'utf-8')));
const s = realReturnSeries(data, 'SP500', 'JPY');
const input: RunInput = {
  series: s.values,
  years: 40,
  paths: 50_000,
  seed: 20260929,
  initialAssets: 50_000_000,
  annualSpending: 2_000_000,
  fee: 0.001,
};

const worker = new Worker(new URL('./bench-worker.ts', import.meta.url));
const roundTrip = (id: number): Promise<{ ms: number; timings: RunTimings }> =>
  new Promise((resolve, reject) => {
    const start = performance.now();
    worker.once('message', (res: WorkerResponse) => {
      const ms = performance.now() - start;
      if (res.type === 'error') return reject(new Error(res.message));
      if (res.id !== id || res.result.timings === null) return reject(new Error('応答が不正です'));
      resolve({ ms, timings: res.result.timings });
    });
    worker.postMessage({ type: 'run', id, input });
  });

const results: { ms: number; timings: RunTimings }[] = [];
for (let i = 1; i <= RUNS; i++) results.push(await roundTrip(i));
await worker.terminate();

const median = (xs: number[]): number => {
  const v = [...xs].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 === 1 ? (v[m] as number) : ((v[m - 1] as number) + (v[m] as number)) / 2;
};
const fmt = (ms: number): string => ms.toFixed(0).padStart(6);

console.log(`Node ${process.version} / ${cpus()[0]?.model ?? '?'} / ${cpus().length} スレッド`);
console.log(`入力: ${s.currency}_${s.asset}（${s.startYear}〜${s.endYear}）, ${input.years} 年, ${input.paths} パス, ${RUNS} 回`);
console.log(`\n回  ${STAGES.map((k) => k.padStart(10)).join('')}  往復(ms)`);
results.forEach((r, i) => console.log(`${String(i + 1).padStart(2)}  ${STAGES.map((k) => fmt(r.timings[k]).padStart(10)).join('')}  ${fmt(r.ms)}`));
const med = Object.fromEntries(STAGES.map((k) => [k, median(results.map((r) => r.timings[k]))])) as Record<(typeof STAGES)[number], number>;
const medRoundTrip = median(results.map((r) => r.ms));
console.log(`中央値${STAGES.map((k) => fmt(med[k]).padStart(10)).join('')}  ${fmt(medRoundTrip)}`);

const pass = medRoundTrip <= LIMIT_MS;
console.log(`\n往復時間の中央値 ${medRoundTrip.toFixed(0)} ms（1 回目 ${results[0]?.ms.toFixed(0)} ms）: ${pass ? '合格' : '不合格'}（基準 ≤ ${LIMIT_MS} ms）`);
process.exitCode = pass ? 0 : 1;

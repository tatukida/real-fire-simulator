/** ベンチマーク用の worker_threads の入口。ブラウザの worker.ts と同じく、handler.ts を結び付けるだけ。 */
import './register.ts';
import { parentPort } from 'node:worker_threads';

const { handleMessage } = await import('../../src/worker/handler');
const port = parentPort;
if (port === null) throw new Error('worker_threads から起動してください');
port.on('message', (msg: unknown) => {
  port.postMessage(handleMessage(msg, () => performance.now()));
});

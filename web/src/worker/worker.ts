/** ブラウザの Web Worker の入口。処理は handler.ts に任せ、ここでは self への結び付けだけを行う。 */

import { handleMessage } from './handler';

const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = (ev: MessageEvent<unknown>) => {
  scope.postMessage(handleMessage(ev.data, () => performance.now()));
};

/**
 * Vite worker entry for interactive WASI runs (dev mode, cross-origin
 * isolated). All logic lives in worker-runner.ts; this file only adapts the
 * web worker global to the port interface.
 */
import { startWasiWorker, type WasiWorkerInit, type WasiWorkerMessage } from "./worker-runner.ts";

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<WasiWorkerInit>) => void) | null;
  postMessage(message: WasiWorkerMessage, transfer?: Transferable[]): void;
};

startWasiWorker({
  postMessage: (message, transfer) => scope.postMessage(message, transfer ?? []),
  setHandler: (handler) => {
    scope.onmessage = (event) => handler(event.data);
  },
});

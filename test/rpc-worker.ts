/**
 * Node worker_threads wrapper for the WASI worker runner (test-only;
 * mirrors what runner.worker.ts does for the browser/vite).
 */
import { parentPort } from "node:worker_threads";
import { startWasiWorker, type WasiWorkerInit, type WasiWorkerMessage } from "../src/wasi/worker-runner.ts";

if (!parentPort) throw new Error("must run as a worker thread");
const port = parentPort;

startWasiWorker({
  postMessage: (message: WasiWorkerMessage, transfer?: Transferable[]) =>
    port.postMessage(message, transfer as never),
  setHandler: (handler: (message: WasiWorkerInit) => void) => {
    port.on("message", handler);
  },
});

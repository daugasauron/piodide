import { WebWorkerMLCEngineHandler } from "@mlc-ai/web-llm";

const handler = new WebWorkerMLCEngineHandler();

globalThis.onmessage = (event: MessageEvent) => {
  handler.onmessage(event);
};

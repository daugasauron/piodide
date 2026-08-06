export type LocalModelPhase =
  | "idle"
  | "preparing"
  | "downloading"
  | "importing"
  | "loading"
  | "ready"
  | "generating"
  | "unloading"
  | "error";

export interface LocalModelStatus {
  phase: LocalModelPhase;
  modelId?: string;
  loadedBytes?: number;
  totalBytes?: number;
  backend?: "wasm" | "webgpu";
  threads?: number;
  contextSize?: number;
  message?: string;
}

export interface LocalModelDef {
  id: string;
  label: string;
  bytes: number;
  quantization: string;
  contextWindow: number;
  maxTokens: number;
  tools: boolean;
  thinking?: boolean;
  license: string;
}

export interface LocalModelRuntime {
  readonly status: LocalModelStatus;
  subscribe(listener: (status: LocalModelStatus) => void): () => void;
  isCached(modelId: string): Promise<boolean>;
  cachedModelIds(): Promise<Set<string>>;
  storageHeadroom(): Promise<number | undefined>;
  requestPersistentStorage(): Promise<boolean | undefined>;
  ensureLoaded(modelId: string, signal?: AbortSignal): Promise<void>;
  unload(): Promise<void>;
  removeCached(modelId: string): Promise<void>;
  clearCache(): Promise<void>;
}

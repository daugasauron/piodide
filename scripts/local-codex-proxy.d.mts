import type { Server } from "node:http";

export const DEFAULT_PROXY_HOST: string;
export const DEFAULT_PROXY_PORT: number;
export const DEFAULT_PIODIDE_URL: string;
export const CODEX_UPSTREAM_URL: string;

export function createCapabilityToken(): string;
export function extractAccountId(accessToken: string): string;
export function createPiodideConnectionLocation(
  piodideUrl: string,
  capability: string,
): string;

export interface LocalCodexProxyOptions {
  capability: string;
  getAccessToken: () => Promise<string | undefined>;
  allowedOrigins?: readonly string[];
  connectTarget?: string;
  upstreamFetch?: typeof fetch;
  upstreamUrl?: string;
  maxRequestBytes?: number;
  onShutdown?: () => void;
  shutdownSignal?: AbortSignal;
}

export function createLocalCodexProxyServer(
  options: LocalCodexProxyOptions,
): Server;

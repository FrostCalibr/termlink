import { loadEnvFile } from "../../shared/env.js";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
} from "../../shared/protocol/constants.js";
import { parseTls, type ClientTlsConfig } from "../../shared/tlsconfig.js";

export const CLIENT_CONFIG_ERROR = "ClientConfigError";

export class ClientConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = CLIENT_CONFIG_ERROR;
  }
}

export interface ClientConfig {
  host: string;
  port: number;
  token?: string;
  username?: string;
  password?: string;
  connectTimeoutMs: number;
  idleTimeoutMs: number;
  maxFrameSize: number;
  reconnect: boolean;
  reconnectDelayMs: number;
  maxReconnectAttempts: number;
  /** Optional TLS for the outbound connection (enabled via TLS_ENABLED). */
  tls?: ClientTlsConfig;
}

const DEFAULTS = {
  CONNECT_TIMEOUT_MS: 10_000,
  IDLE_TIMEOUT_MS: 60_000,
  MAX_FRAME_SIZE: 1024 * 1024,
  RECONNECT_DELAY_MS: 1000,
  MAX_RECONNECT_ATTEMPTS: 5,
};

export function loadClientConfig(env: NodeJS.ProcessEnv = process.env): ClientConfig {
  if (env === process.env) {
    loadEnvFile();
  }
  const host = str(env.SERVER_HOST ?? env.HOST, DEFAULT_HOST);
  const port = int(env.SERVER_PORT ?? env.PORT, DEFAULT_PORT, "SERVER_PORT");
  const connectTimeoutMs = int(
    env.CONNECT_TIMEOUT_MS,
    DEFAULTS.CONNECT_TIMEOUT_MS,
    "CONNECT_TIMEOUT_MS",
  );
  const idleTimeoutMs = int(
    env.CLIENT_IDLE_TIMEOUT_MS ?? env.IDLE_TIMEOUT_MS,
    DEFAULTS.IDLE_TIMEOUT_MS,
    "CLIENT_IDLE_TIMEOUT_MS",
  );
  const maxFrameSize = int(
    env.CLIENT_MAX_FRAME_SIZE ?? env.MAX_FRAME_SIZE,
    DEFAULTS.MAX_FRAME_SIZE,
    "CLIENT_MAX_FRAME_SIZE",
  );
  const reconnect = bool(env.RECONNECT, true);
  const reconnectDelayMs = int(
    env.RECONNECT_DELAY_MS,
    DEFAULTS.RECONNECT_DELAY_MS,
    "RECONNECT_DELAY_MS",
  );
  const maxReconnectAttempts = int(
    env.MAX_RECONNECT_ATTEMPTS,
    DEFAULTS.MAX_RECONNECT_ATTEMPTS,
    "MAX_RECONNECT_ATTEMPTS",
  );

  const token = env.AUTH_TOKEN ?? env.CLIENT_TOKEN;
  const username = env.USERNAME;
  const password = env.PASSWORD;

  if (maxFrameSize < 1 || maxFrameSize > 64 * 1024 * 1024) {
    throw new ClientConfigError("MAX_FRAME_SIZE out of range");
  }
  if (!(port >= 0 && port <= 65535)) {
    throw new ClientConfigError(`SERVER_PORT ${port} out of range 0-65535`);
  }
  if (connectTimeoutMs < 1 || idleTimeoutMs < 1) {
    throw new ClientConfigError("timeouts must be >= 1");
  }

  let tls: ClientTlsConfig | undefined;
  if (env.TLS_ENABLED !== undefined) {
    try {
      tls = parseTls(env, { role: "client", name: "client" }) as
        | ClientTlsConfig
        | undefined;
    } catch (err) {
      throw new ClientConfigError((err as Error).message);
    }
  }

  return {
    host,
    port,
    token,
    username,
    password,
    connectTimeoutMs,
    idleTimeoutMs,
    maxFrameSize,
    reconnect,
    reconnectDelayMs,
    maxReconnectAttempts,
    tls,
  };
}

function str(value: string | undefined, fallback: string): string {
  const v = value?.trim();
  return v && v.length > 0 ? v : fallback;
}

function int(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${name} must be an integer, got "${value}"`);
  }
  return parsed;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

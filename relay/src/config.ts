import { existsSync, readFileSync, statSync } from "node:fs";
import { loadEnvFile } from "../../shared/env.js";
import {
  DEFAULT_AUTH_BACKOFF_MS,
  DEFAULT_HOST,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_AUTH_ATTEMPTS,
  DEFAULT_MAX_CONNECTIONS,
  DEFAULT_MAX_FRAME_SIZE,
  DEFAULT_PORT,
} from "../../shared/protocol/constants.js";
import { parseTls, type ClientTlsConfig, type ServerTlsConfig } from "../../shared/tlsconfig.js";
import {
  assertNoIdCollisions,
  parseAgents,
  type AgentDeviceConfig,
} from "./device-config.js";

export const AUTH_TIMEOUT_DEFAULT_MS = 10_000;
export const AUTH_RATE_WINDOW_DEFAULT_MS = 60_000;
export const AUTH_RATE_LIMIT_DEFAULT = 0;
export const AUTH_PER_IP_RATE_LIMIT_DEFAULT = 0;
export const SESSION_TTL_DEFAULT_MS = 0;

/**
 * A static backend target the relay is authorized to forward to.
 *
 * Both the relay-client and relay-backend connections speak the framed
 * relay protocol; the backend is expected to implement the server side of
 * that protocol.
 */
export const TARGET_TYPE_SHELL = "shell";
export const TARGET_TYPE_SSH = "ssh";
export const TARGET_TYPE_ANDROID = "android";

export type TargetType = "shell" | "ssh" | "android";

/** True when the string is a known target session type. */
export function isTargetType(value: string): value is TargetType {
  return (
    value === TARGET_TYPE_SHELL ||
    value === TARGET_TYPE_SSH ||
    value === TARGET_TYPE_ANDROID
  );
}

export interface Target {
  /** Unique id used when describing/selecting the target. */
  id: string;
  host: string;
  port: number;
  /**
   * Optional human-friendly device name shown in the web GUI. Defaults to
   * the target id. Declared via `id|Name|type`; never client-supplied.
   */
  name?: string;
  /**
   * The session type this device offers: `shell` (PTY/local shell) or `ssh`
   * (SSH remote shell). Defaults to `shell`. Declared via `id|Name|type`.
   */
  type?: TargetType;
  /** Credentials the relay uses to authenticate TO the backend. */
  token?: string;
  username?: string;
  password?: string;
}

/** Browser-facing WebSocket front door of the relay. */
export interface WebSocketConfig {
  host: string;
  port: number;
  /** Max concurrent WebSocket connections (session limit). */
  maxConnections: number;
  /** Max bytes per WebSocket message (text or binary). */
  maxMessageSize: number;
  /** Time a connection has to authenticate before it is dropped. */
  authTimeoutMs: number;
  /** Idle timeout for authenticated connections. */
  idleTimeoutMs: number;
  /**
   * Allowed origins. Empty means "accept any" (only with a startup warning);
   * otherwise the Origin header must match one of these exactly.
   */
  allowedOrigins: string[];
  /** Outbound buffered bytes before the bridge signals backpressure. */
  sendHighWaterMark: number;
  /** Outbound buffered bytes below which backpressure is released. */
  sendLowWaterMark: number;
  /** Optional TLS listener config (enabled via TLS_ENABLED → WSS). */
  tls?: ServerTlsConfig;
  /** Optional static web root to serve (the built web client). */
  webroot?: string;
}

export interface RelayConfig {
  host: string;
  port: number;
  maxFrameSize: number;
  maxConnections: number;
  idleTimeoutMs: number;
  maxAuthAttempts: number;
  authBackoffMs: number;
  /** Credentials clients must present to authenticate to the relay. */
  tokens: string[];
  passwordUsers: Map<string, string>;
  /**
   * Static authorized targets. Phase 3 routes every authenticated session to
   * the first configured target; the list shape leaves room for later routing
   * without a redesign.
   */
  targets: Target[];
  /**
   * Phase 9 device agents (pre-authorized outbound-connecting devices). A
   * device registers on first contact with its own secret; the relay stores
   * only an scrypt hash and never dials the device.
   */
  agents: AgentDeviceConfig[];
  /** Optional browser-facing WebSocket front door. */
  websocket?: WebSocketConfig;
  /** Optional TLS for the relay → backend connections (enabled via TLS_ENABLED). */
  tls?: ClientTlsConfig;
  /** Time a front-door connection has to authenticate (0 = disabled). */
  authTimeoutMs: number;
  /** Global auth attempts allowed per window (0 = disabled). */
  authRateLimit: number;
  /** Auth attempts allowed per client IP per window (0 = disabled). */
  authRateLimitPerIp: number;
  /** Rate-limiter window in ms. */
  authRateWindowMs: number;
  /** Max authenticated session lifetime in ms (0 = disabled). */
  sessionTtlMs: number;
}

const WS_DEFAULTS = {
  PORT: 19001,
  AUTH_TIMEOUT_MS: 10_000,
  SEND_HIGH_WATER: 1024 * 1024,
  SEND_LOW_WATER: 256 * 1024,
};

export function loadRelayConfig(
  env: NodeJS.ProcessEnv = process.env,
): RelayConfig {
  if (env === process.env) {
    loadEnvFile();
  }

  // ── Render auto-detection ──────────────────────────────────────────────
  // Render provides a single `PORT` that is the only publicly-routable
  // listener, and injects platform env vars (RENDER/RENDER_SERVICE_ID/
  // RENDER_INSTANCE_ID/...) on every instance. On Render the WebSocket front
  // door MUST live on `PORT`, so it is enabled and mapped unconditionally,
  // the internal TCP relay selects an ephemeral port unless one is explicitly
  // configured, and the web GUI is served from ./web by default.
  const onRender =
    env.RENDER === "true" ||
    env.RENDER === "1" ||
    Boolean(
      env.RENDER_SERVICE_ID ||
        env.RENDER_INSTANCE_ID ||
        env.RENDER_SERVICE_TYPE ||
        env.RENDER_EXTERNAL_URL ||
        env.RENDER_APP_ID,
    );
  if (onRender) {
    env = { ...env, WS_ENABLED: "true" };
    if (env.PORT) {
      env = { ...env, WS_PORT: env.PORT };
    }
    if (env.RELAY_PORT === undefined) {
      env = { ...env, RELAY_PORT: "0" };
    }
    if (env.WS_STATIC_DIR === undefined && existsSync("web")) {
      env = { ...env, WS_STATIC_DIR: "web" };
    }
  }

  const host = str(env.RELAY_HOST ?? env.HOST, DEFAULT_HOST);
  const port = int(env.RELAY_PORT ?? env.PORT, DEFAULT_PORT, "RELAY_PORT");
  const maxFrameSize = int(
    env.MAX_FRAME_SIZE,
    DEFAULT_MAX_FRAME_SIZE,
    "MAX_FRAME_SIZE",
  );
  const maxConnections = int(
    env.MAX_CONNECTIONS,
    DEFAULT_MAX_CONNECTIONS,
    "MAX_CONNECTIONS",
  );
  const idleTimeoutMs = int(
    env.IDLE_TIMEOUT_MS,
    DEFAULT_IDLE_TIMEOUT_MS,
    "IDLE_TIMEOUT_MS",
  );
  const maxAuthAttempts = int(
    env.MAX_AUTH_ATTEMPTS,
    DEFAULT_MAX_AUTH_ATTEMPTS,
    "MAX_AUTH_ATTEMPTS",
  );
  const authBackoffMs = int(
    env.AUTH_BACKOFF_MS,
    DEFAULT_AUTH_BACKOFF_MS,
    "AUTH_BACKOFF_MS",
  );
  const authTimeoutMs = int(
    env.AUTH_TIMEOUT_MS,
    AUTH_TIMEOUT_DEFAULT_MS,
    "AUTH_TIMEOUT_MS",
  );
  const authRateWindowMs = int(
    env.AUTH_RATE_WINDOW_MS,
    AUTH_RATE_WINDOW_DEFAULT_MS,
    "AUTH_RATE_WINDOW_MS",
  );
  const authRateLimit = int(
    env.AUTH_RATE_LIMIT,
    AUTH_RATE_LIMIT_DEFAULT,
    "AUTH_RATE_LIMIT",
  );
  const authRateLimitPerIp = int(
    env.AUTH_PER_IP_RATE_LIMIT,
    AUTH_PER_IP_RATE_LIMIT_DEFAULT,
    "AUTH_PER_IP_RATE_LIMIT",
  );
  const sessionTtlMs = int(
    env.SESSION_TTL_MS,
    SESSION_TTL_DEFAULT_MS,
    "SESSION_TTL_MS",
  );

  const tokens = parseTokens(env.AUTH_TOKENS, env.AUTH_TOKENS_FILE);
  const passwordUsers = parsePasswordUsers(env.PASSWORD_USERS, env.PASSWORD_USERS_FILE);
  const targets = parseTargets(env.TARGETS);
  const agents = parseAgents(env.DEVICES);
  const websocket = parseWebSocket(env);
  const tls = (() => {
    try {
      return parseTls(env, { role: "client", name: "relay → backend" }) as
        | ClientTlsConfig
        | undefined;
    } catch (err) {
      throw new ConfigError((err as Error).message);
    }
  })();

  if (tokens.length === 0 && passwordUsers.size === 0) {
    throw new ConfigError(
      "No relay client authentication credentials configured. Set AUTH_TOKENS and/or PASSWORD_USERS.",
    );
  }
  if (targets.length === 0 && agents.length === 0) {
    throw new ConfigError(
      "No relay targets or devices configured. Set TARGETS and/or DEVICES.",
    );
  }
  assertNoIdCollisions(
    agents,
    targets.map((t) => t.id),
  );
  if (maxFrameSize < 1) {
    throw new ConfigError("MAX_FRAME_SIZE must be >= 1");
  }
  if (maxFrameSize > 64 * 1024 * 1024) {
    throw new ConfigError("MAX_FRAME_SIZE exceeds practical limit of 64 MB");
  }
  if (maxConnections < 1) {
    throw new ConfigError("MAX_CONNECTIONS must be >= 1");
  }
  if (idleTimeoutMs < 1) {
    throw new ConfigError("IDLE_TIMEOUT_MS must be >= 1");
  }
  if (maxAuthAttempts < 1) {
    throw new ConfigError("MAX_AUTH_ATTEMPTS must be >= 1");
  }
  if (authBackoffMs < 1) {
    throw new ConfigError("AUTH_BACKOFF_MS must be >= 1");
  }
  if (authTimeoutMs < 0) {
    throw new ConfigError("AUTH_TIMEOUT_MS must be >= 0");
  }
  if (authRateLimit < 0) {
    throw new ConfigError("AUTH_RATE_LIMIT must be >= 0");
  }
  if (authRateLimitPerIp < 0) {
    throw new ConfigError("AUTH_PER_IP_RATE_LIMIT must be >= 0");
  }
  if (authRateWindowMs < 1) {
    throw new ConfigError("AUTH_RATE_WINDOW_MS must be >= 1");
  }
  if (sessionTtlMs < 0) {
    throw new ConfigError("SESSION_TTL_MS must be >= 0");
  }
  if (!(port >= 0 && port <= 65535)) {
    throw new ConfigError(`RELAY_PORT ${port} out of range 0-65535`);
  }
  if (websocket && websocket.port === port && websocket.port !== 0) {
    throw new ConfigError(
      "WS_PORT must differ from RELAY_PORT when both front doors are enabled",
    );
  }

  return {
    host,
    port,
    maxFrameSize,
    maxConnections,
    idleTimeoutMs,
    maxAuthAttempts,
    authBackoffMs,
    tokens,
    passwordUsers,
    targets,
    agents,
    websocket,
    tls,
    authTimeoutMs,
    authRateLimit,
    authRateLimitPerIp,
    authRateWindowMs,
    sessionTtlMs,
  };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function str(value: string | undefined, fallback: string): string {
  const v = value?.trim();
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

function int(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new ConfigError(`${name} must be an integer, got "${value}"`);
  }
  return parsed;
}

function parseTokens(
  value: string | undefined,
  file: string | undefined,
): string[] {
  const content = value ?? readSecretFile(file, "AUTH_TOKENS_FILE");
  if (!content) return [];
  const tokens = content
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  return tokens;
}

function readSecretFile(
  path: string | undefined,
  name: string,
): string | undefined {
  if (path === undefined || path.trim() === "") return undefined;
  try {
    return readFileSync(path.trim(), "utf-8");
  } catch (err) {
    throw new ConfigError(
      `cannot read ${name} at "${path}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

function parsePasswordUsers(
  value: string | undefined,
  file: string | undefined,
): Map<string, string> {
  const map = new Map<string, string>();
  const content = value ?? readSecretFile(file, "PASSWORD_USERS_FILE");
  if (!content) return map;
  for (const entry of content.split(",")) {
    const idx = entry.indexOf(":");
    if (idx === -1) {
      throw new ConfigError(
        `PASSWORD_USERS entry "${entry}" is not of form username:password`,
      );
    }
    const username = entry.slice(0, idx).trim();
    const password = entry.slice(idx + 1);
    if (username.length === 0 || password.length === 0) {
      throw new ConfigError(
        `PASSWORD_USERS entry "${entry}" has empty username or password`,
      );
    }
    if (map.has(username)) {
      throw new ConfigError(`PASSWORD_USERS duplicate username "${username}"`);
    }
    map.set(username, password);
  }
  return map;
}

/**
 * Parse TARGETS as a comma-separated list of `targetId=[creds@]host:port`
 * entries. The target id may carry optional GUI metadata as
 * `targetId|Display Name|type`, where `type` is `shell` or `ssh` (default:
 * `shell`). The optional `creds@` prefix carries the relay → backend
 * authentication credentials and is never shared with clients: it is either a
 * token (`backendtok@host:port`) or `username:password`. Credentials must not
 * contain `@`; token credentials must not contain `:`.
 */
function parseTargets(value: string | undefined): Target[] {
  const targets: Target[] = [];
  if (!value) return targets;
  const seen = new Set<string>();
  for (const raw of value.split(",")) {
    const entry = raw.trim();
    if (entry.length === 0) continue;
    const eq = entry.indexOf("=");
    if (eq === -1) {
      throw new ConfigError(
        `TARGETS entry "${entry}" is not of form targetId=host:port`,
      );
    }
    const spec = entry.slice(0, eq).trim();
    const hp = entry.slice(eq + 1).trim();
    if (spec.length === 0) {
      throw new ConfigError(
        `TARGETS entry has empty target id in "${entry}"`,
      );
    }

    // Optional GUI metadata: id | Display Name | session type
    const meta = spec.split("|").map((part) => part.trim());
    const id = meta[0];
    let name: string | undefined;
    let type: TargetType | undefined;
    if (meta.length > 1) {
      name = meta[1];
      if (name.length === 0) {
        throw new ConfigError(
          `TARGETS entry has empty display name in "${entry}"`,
        );
      }
    }
    if (meta.length > 2) {
      if (!isTargetType(meta[2])) {
        throw new ConfigError(
          `TARGETS entry "${entry}" has unknown type "${meta[2]}" (expected shell or ssh)`,
        );
      }
      type = meta[2];
    }
    if (meta.length > 3) {
      throw new ConfigError(
        `TARGETS entry "${entry}" has too many '|' segments`,
      );
    }

    if (seen.has(id)) {
      throw new ConfigError(`TARGETS contains duplicate target id "${id}"`);
    }
    seen.add(id);

    let hostPort = hp;
    let creds: string | undefined;
    const at = hp.indexOf("@");
    if (at !== -1) {
      creds = hp.slice(0, at).trim();
      hostPort = hp.slice(at + 1).trim();
      if (creds.length === 0) {
        throw new ConfigError(
          `TARGETS entry "${entry}" has empty credentials before "@"`,
        );
      }
    }

    const colon = hostPort.lastIndexOf(":");
    if (colon === -1) {
      throw new ConfigError(
        `TARGETS entry "${entry}" has no port (form targetId=host:port)`,
      );
    }
    const tHost = hostPort.slice(0, colon).trim();
    const tPort = Number(hostPort.slice(colon + 1).trim());
    if (tHost.length === 0) {
      throw new ConfigError(`TARGETS entry "${entry}" has empty host`);
    }
    if (!Number.isInteger(tPort) || tPort < 0 || tPort > 65535) {
      throw new ConfigError(
        `TARGETS entry "${entry}" has invalid port "${hostPort.slice(colon + 1).trim()}"`,
      );
    }

    const target: Target = { id, host: tHost, port: tPort };
    if (name !== undefined) target.name = name;
    if (type !== undefined) target.type = type;
    if (creds !== undefined) {
      const colonIdx = creds.indexOf(":");
      if (colonIdx === -1) {
        target.token = creds;
      } else {
        const username = creds.slice(0, colonIdx).trim();
        const password = creds.slice(colonIdx + 1);
        if (username.length === 0 || password.length === 0) {
          throw new ConfigError(
            `TARGETS entry "${entry}" has empty username or password`,
          );
        }
        target.username = username;
        target.password = password;
      }
    }
    targets.push(target);
  }
  return targets;
}

/**
 * Parse the optional WebSocket front-door configuration. Returns undefined
 * when the WS front door is disabled, or a fully validated WebSocketConfig.
 * Enabled via WS_ENABLED=true and/or an explicit WS_PORT/RWS vars.
 */
function parseWebSocket(env: NodeJS.ProcessEnv): WebSocketConfig | undefined {
  const explicitPort =
    env.WS_PORT !== undefined && env.WS_PORT.trim() !== "";
  const enabled = env.WS_ENABLED !== undefined && bool(env.WS_ENABLED, false);
  if (!enabled && !explicitPort) return undefined;

  const host = str(env.WS_HOST ?? env.HOST, DEFAULT_HOST);
  const port = int(env.WS_PORT, WS_DEFAULTS.PORT, "WS_PORT");
  const maxConnections = int(
    env.WS_MAX_CONNECTIONS ?? env.MAX_CONNECTIONS,
    DEFAULT_MAX_CONNECTIONS,
    "WS_MAX_CONNECTIONS",
  );
  const maxMessageSize = int(
    env.WS_MAX_MESSAGE_SIZE ?? env.MAX_FRAME_SIZE,
    DEFAULT_MAX_FRAME_SIZE,
    "WS_MAX_MESSAGE_SIZE",
  );
  const authTimeoutMs = int(
    env.WS_AUTH_TIMEOUT_MS,
    WS_DEFAULTS.AUTH_TIMEOUT_MS,
    "WS_AUTH_TIMEOUT_MS",
  );
  const idleTimeoutMs = int(
    env.WS_IDLE_TIMEOUT_MS ?? env.IDLE_TIMEOUT_MS,
    DEFAULT_IDLE_TIMEOUT_MS,
    "WS_IDLE_TIMEOUT_MS",
  );
  const sendHighWaterMark = int(
    env.WS_SEND_HIGH_WATER,
    WS_DEFAULTS.SEND_HIGH_WATER,
    "WS_SEND_HIGH_WATER",
  );
  const sendLowWaterMark = int(
    env.WS_SEND_LOW_WATER,
    WS_DEFAULTS.SEND_LOW_WATER,
    "WS_SEND_LOW_WATER",
  );
  const allowedOrigins = parseOrigins(env.WS_ALLOWED_ORIGINS);

  let tls: ServerTlsConfig | undefined;
  if (env.TLS_ENABLED !== undefined) {
    try {
      tls = parseTls(env, {
        role: "server",
        name: "WebSocket front door",
      }) as ServerTlsConfig | undefined;
    } catch (err) {
      throw new ConfigError((err as Error).message);
    }
  }
  const webroot = strOrUndef(env.WS_STATIC_DIR ?? env.WEB_STATIC_DIR);
  if (webroot) {
    try {
      const st = statSync(webroot);
      if (!st.isDirectory()) {
        throw new ConfigError(`WS_STATIC_DIR "${webroot}" is not a directory`);
      }
    } catch (err) {
      if (err instanceof ConfigError) throw err;
      // Gracefully skip if the directory does not exist yet (e.g. the build
      // has not run on the deployment platform). The HTTP handler will serve
      // 404 until the directory is created.
    }
  }

  if (!(port >= 0 && port <= 65535)) {
    throw new ConfigError(`WS_PORT ${port} out of range 0-65535`);
  }
  if (maxConnections < 1) {
    throw new ConfigError("WS_MAX_CONNECTIONS must be >= 1");
  }
  if (maxMessageSize < 1 || maxMessageSize > 64 * 1024 * 1024) {
    throw new ConfigError("WS_MAX_MESSAGE_SIZE out of range 1..64 MB");
  }
  if (authTimeoutMs < 1) {
    throw new ConfigError("WS_AUTH_TIMEOUT_MS must be >= 1");
  }
  if (idleTimeoutMs < 1) {
    throw new ConfigError("WS_IDLE_TIMEOUT_MS must be >= 1");
  }
  if (sendHighWaterMark < 1) {
    throw new ConfigError("WS_SEND_HIGH_WATER must be >= 1");
  }
  if (sendLowWaterMark < 1) {
    throw new ConfigError("WS_SEND_LOW_WATER must be >= 1");
  }
  if (sendLowWaterMark > sendHighWaterMark) {
    throw new ConfigError(
      "WS_SEND_LOW_WATER must not exceed WS_SEND_HIGH_WATER",
    );
  }

  return {
    host,
    port,
    maxConnections,
    maxMessageSize,
    authTimeoutMs,
    idleTimeoutMs,
    allowedOrigins,
    sendHighWaterMark,
    sendLowWaterMark,
    tls,
    webroot,
  };
}

/**
 * Normalize an Origin header value for allow-list comparison:
 * lowercase scheme/host, drop trailing slashes, strip any query/fragment.
 */
export function normalizeOrigin(origin: string): string {
  let o = origin.trim();
  if (!o) return o;
  try {
    const url = new URL(o);
    let out = `${url.protocol}//${url.host}`.toLowerCase();
    if (url.pathname !== "/" && url.pathname !== "") out += url.pathname;
    return out;
  } catch {
    return o.toLowerCase().replace(/\/+$/, "");
  }
}

function parseOrigins(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((o) => normalizeOrigin(o))
    .filter((o) => o.length > 0);
}

function bool(value: string, fallback: boolean): boolean {
  const v = value.trim().toLowerCase();
  if (v === "") return fallback;
  return v === "1" || v === "true";
}

function strOrUndef(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v && v.length > 0 ? v : undefined;
}

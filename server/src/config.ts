import { readFileSync } from "node:fs";
import { loadEnvFile } from "../../shared/env.js";
import {
  DEFAULT_AUTH_BACKOFF_MS,
  DEFAULT_HOST,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_AUTH_ATTEMPTS,
  DEFAULT_MAX_CONNECTIONS,
  DEFAULT_MAX_FRAME_SIZE,
  DEFAULT_PORT,
  PROTOCOL_VERSION,
} from "../../shared/protocol/constants.js";
import { parseTls, type ServerTlsConfig } from "../../shared/tlsconfig.js";
import {
  parseFingerprint,
  parseKnownHosts,
  type KnownHostEntry,
} from "../../shared/known-hosts.js";
import type { PtyConfig } from "./pty.js";
import {
  SSH_DEFAULT_TERM,
  validatePrivateKey,
  type SshConfig,
} from "./ssh-backend.js";

export const AUTH_TIMEOUT_DEFAULT_MS = 10_000;
export const AUTH_RATE_WINDOW_DEFAULT_MS = 60_000;
export const AUTH_RATE_LIMIT_DEFAULT = 0;
export const AUTH_PER_IP_RATE_LIMIT_DEFAULT = 0;
export const SESSION_TTL_DEFAULT_MS = 0;

export interface Config {
  host: string;
  port: number;
  protocolVersion: number;
  maxFrameSize: number;
  maxConnections: number;
  idleTimeoutMs: number;
  maxAuthAttempts: number;
  authBackoffMs: number;
  tokens: string[];
  passwordUsers: Map<string, string>;
  echoData: boolean;
  /** Optional interactive PTY backend (enabled via PTY_ENABLED). */
  pty?: PtyConfig;
  /** Optional SSH backend: front a remote shell (enabled via SSH_ENABLED). */
  ssh?: SshConfig;
  /** Optional TLS listener configuration (enabled via TLS_ENABLED). */
  tls?: ServerTlsConfig;
  /** Time an unauthenticated connection has to authenticate (0 = disabled). */
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (env === process.env) {
    loadEnvFile();
  }
  const host = str(env.HOST, DEFAULT_HOST);
  const port = int(env.PORT, DEFAULT_PORT, "PORT");
  const protocolVersion = int(
    env.PROTOCOL_VERSION,
    PROTOCOL_VERSION,
    "PROTOCOL_VERSION",
  );
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
  const echoData = bool(env.ECHO_DATA, false);
  const pty = parsePty(env);
  const ssh = parseSsh(env);
  if (pty && ssh) {
    throw new ConfigError("PTY_ENABLED and SSH_ENABLED are mutually exclusive");
  }
  const tls = (() => {
    try {
      return parseTls(env, { role: "server", name: "TCP server" });
    } catch (err) {
      throw new ConfigError((err as Error).message);
    }
  })() as ServerTlsConfig | undefined;

  if (tokens.length === 0 && passwordUsers.size === 0) {
    throw new ConfigError(
      "No authentication credentials configured. Set AUTH_TOKENS and/or PASSWORD_USERS.",
    );
  }
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
  if (protocolVersion !== PROTOCOL_VERSION) {
    throw new ConfigError(
      `PROTOCOL_VERSION ${protocolVersion} not supported (expected ${PROTOCOL_VERSION})`,
    );
  }
  if (!(port >= 0 && port <= 65535)) {
    throw new ConfigError(`PORT ${port} out of range 0-65535`);
  }

  return {
    host,
    port,
    protocolVersion,
    maxFrameSize,
    maxConnections,
    idleTimeoutMs,
    maxAuthAttempts,
    authBackoffMs,
    tokens,
    passwordUsers,
    echoData,
    pty,
    ssh,
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

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === "1" || value.toLowerCase() === "true";
}

function readSecretFile(path: string | undefined, name: string): string | undefined {
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
  return content
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
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
 * Parse the optional PTY backend configuration. Every authenticated
 * connection spawns an isolated shell whose executable comes only from this
 * trusted server configuration — never from a client.
 */
function parsePty(env: NodeJS.ProcessEnv): PtyConfig | undefined {
  if (!bool(env.PTY_ENABLED, false)) return undefined;

  const cols = int(env.PTY_COLS, 80, "PTY_COLS");
  const rows = int(env.PTY_ROWS, 24, "PTY_ROWS");
  if (!(cols >= 1 && cols <= 1000)) {
    throw new ConfigError("PTY_COLS must be in 1..1000");
  }
  if (!(rows >= 1 && rows <= 1000)) {
    throw new ConfigError("PTY_ROWS must be in 1..1000");
  }

  return {
    shell: str(env.PTY_SHELL, env.SHELL ?? "/bin/sh"),
    cols,
    rows,
    cwd: str(env.PTY_CWD, process.env.HOME ?? process.cwd()),
  };
}

const SSH_PORT_DEFAULT = 22;
const SSH_CONNECT_TIMEOUT_DEFAULT_MS = 15_000;

/**
 * Parse the optional SSH backend configuration. Every authenticated
 * connection gets an interactive shell on the configured remote host. The
 * host, port, username, credentials, and host-key trust anchors all come only
 * from this trusted server configuration — never from a client.
 */
function parseSsh(env: NodeJS.ProcessEnv): SshConfig | undefined {
  if (!bool(env.SSH_ENABLED, false)) return undefined;

  const host = str(env.SSH_HOST, "");
  if (!host) {
    throw new ConfigError("SSH_ENABLED requires SSH_HOST");
  }

  const port = int(env.SSH_PORT, SSH_PORT_DEFAULT, "SSH_PORT");
  if (!(port >= 1 && port <= 65535)) {
    throw new ConfigError(`SSH_PORT ${port} out of range 1-65535`);
  }

  const username = str(env.SSH_USERNAME, "");
  if (!username) {
    throw new ConfigError("SSH_ENABLED requires SSH_USERNAME");
  }

  const password = sshSecretValue(env.SSH_PASSWORD, env.SSH_PASSWORD_FILE, "SSH_PASSWORD_FILE");
  const privateKey = sshSecretValue(env.SSH_PRIVATE_KEY, env.SSH_PRIVATE_KEY_FILE, "SSH_PRIVATE_KEY_FILE");
  if (password === undefined && privateKey === undefined) {
    throw new ConfigError(
      "SSH_ENABLED requires SSH_PASSWORD and/or SSH_PRIVATE_KEY",
    );
  }

  const passphrase =
    env.SSH_PASSPHRASE !== undefined && env.SSH_PASSPHRASE.trim() !== ""
      ? env.SSH_PASSPHRASE
      : undefined;

  if (privateKey !== undefined) {
    const badKey = validatePrivateKey(privateKey, passphrase);
    if (badKey) {
      throw new ConfigError(badKey.message);
    }
  }

  const insecureHostKeyCheck = bool(env.SSH_INSECURE_HOST_KEY_CHECK, false);

  const knownHosts: KnownHostEntry[] = [];
  const knownHostsPath = env.SSH_KNOWN_HOSTS_FILE?.trim();
  if (knownHostsPath) {
    try {
      knownHosts.push(...parseKnownHosts(readFileSync(knownHostsPath, "utf-8")));
    } catch (err) {
      throw new ConfigError(
        `cannot read SSH_KNOWN_HOSTS_FILE at "${knownHostsPath}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  const fingerprints: Buffer[] = [];
  const fingerprintsCsv = env.SSH_HOST_KEY_FINGERPRINTS?.trim();
  if (fingerprintsCsv) {
    for (const fp of fingerprintsCsv.split(/[\s,]+/).filter((s) => s.length > 0)) {
      try {
        fingerprints.push(parseFingerprint(fp));
      } catch (err) {
        throw new ConfigError(
          `SSH_HOST_KEY_FINGERPRINTS: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  if (!insecureHostKeyCheck && knownHosts.length === 0 && fingerprints.length === 0) {
    throw new ConfigError(
      "SSH host-key verification requires SSH_KNOWN_HOSTS_FILE or " +
        "SSH_HOST_KEY_FINGERPRINTS (or an explicit SSH_INSECURE_HOST_KEY_CHECK=true " +
        "to disable verification)",
    );
  }

  const cols = int(env.SSH_COLS, 80, "SSH_COLS");
  const rows = int(env.SSH_ROWS, 24, "SSH_ROWS");
  if (!(cols >= 1 && cols <= 1000)) {
    throw new ConfigError("SSH_COLS must be in 1..1000");
  }
  if (!(rows >= 1 && rows <= 1000)) {
    throw new ConfigError("SSH_ROWS must be in 1..1000");
  }
  const connectTimeoutMs = int(
    env.SSH_CONNECT_TIMEOUT_MS,
    SSH_CONNECT_TIMEOUT_DEFAULT_MS,
    "SSH_CONNECT_TIMEOUT_MS",
  );
  if (connectTimeoutMs < 1) {
    throw new ConfigError("SSH_CONNECT_TIMEOUT_MS must be >= 1");
  }

  return {
    host,
    port,
    username,
    password,
    privateKey,
    passphrase,
    connectTimeoutMs,
    cols,
    rows,
    term: str(env.SSH_TERM, SSH_DEFAULT_TERM),
    knownHosts,
    fingerprints,
    insecureHostKeyCheck,
  };
}

/** Read a secret from an inline env var or a mounted file (file wins). */
function sshSecretValue(
  value: string | undefined,
  file: string | undefined,
  fileVar: string,
): string | undefined {
  const content = value ?? readSecretFile(file, fileVar);
  if (content === undefined || content.trim() === "") return undefined;
  return content.trim();
}

import { loadEnvFile } from "../../shared/env.js";

export class AgentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentConfigError";
  }
}

/**
 * Phase 9 device-agent configuration (trusted, operator-provided).
 *
 * The browser can never influence any of this: shell, working directory and
 * environment for spawned PTYs come from here (or safe defaults), not from
 * the wire. The agent holds its own device secret on disk and only ever
 * authenticates (secret/registration) against the relay.
 */
export interface AgentConfig {
  /** Relay origin, e.g. `wss://relay.example.com` (the /device path is appended). */
  relayUrl: string;
  /** Id of this device, as pre-authorized in the relay's DEVICES setting. */
  deviceId: string;
  /** Optional token echoed during enrollment when the relay requires one. */
  enrollmentToken?: string;
  /** Path where the device secret (0600) is persisted between runs. */
  credentialsFile: string;
  /** Shell binary for browser-requested terminals. Falls back to $SHELL. */
  shell: string;
  /** Working directory for spawned shells. Defaults to $HOME / cwd. */
  cwd: string;
  /** Bounded exponential reconnect backoff. */
  reconnectMinMs: number;
  reconnectMaxMs: number;
  reconnectFactor: number;
  /** How long to wait for the relay's device_ok after connecting. */
  authTimeoutMs: number;
  /** Heartbeat interval; the agent pings the relay to keep lastSeen fresh. */
  pingIntervalMs: number;
  /** Drop the connection if no message (incl. pong) arrives in this window. */
  idleTimeoutMs: number;
  /** Outbound backpressure watermarks for the device socket. */
  sendHighWaterMark: number;
  sendLowWaterMark: number;
}

const DEFAULT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Parse the agent's environment, throwing on invalid/missing required fields. */
export function loadAgentConfig(
  env: Record<string, string | undefined> = process.env as Record<string, string>,
): AgentConfig {
  if (env === process.env) {
    loadEnvFile();
  }
  const relayUrl = (env.RELAY_URL ?? "").trim().replace(/\/+$/, "");
  if (!relayUrl) {
    throw new AgentConfigError("RELAY_URL is required (e.g. wss://relay.example.com)");
  }
  let url: URL;
  try {
    url = new URL(relayUrl);
  } catch {
    throw new AgentConfigError(`RELAY_URL "${relayUrl}" is not a valid URL`);
  }
  if (url.protocol !== "wss:" && url.protocol !== "ws:") {
    throw new AgentConfigError(`RELAY_URL must be a ws:// or wss:// URL`);
  }

  const deviceId = (env.AGENT_DEVICE_ID ?? "").trim();
  if (!DEFAULT_ID_RE.test(deviceId)) {
    throw new AgentConfigError(
      "AGENT_DEVICE_ID is required and may only contain [A-Za-z0-9_-]",
    );
  }

  const credentialsFile =
    env.AGENT_CREDENTIALS_FILE?.trim() ||
    (env.CREDENTIALS_FILE?.trim() || "agent-device.secret");

  const shell =
    env.AGENT_SHELL?.trim() ||
    process.env.SHELL ||
    (process.platform === "win32" ? "powershell.exe" : "/bin/bash");

  const cwd = env.AGENT_CWD?.trim() || process.env.HOME || process.cwd();

  const num = (raw: string | undefined, fallback: number, name: string): number => {
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      throw new AgentConfigError(`${name} must be a positive number`);
    }
    return n;
  };

  const pingIntervalMs = num(env.AGENT_PING_INTERVAL_MS, 20_000, "AGENT_PING_INTERVAL_MS");
  const idleTimeoutMs = num(env.AGENT_IDLE_TIMEOUT_MS, 90_000, "AGENT_IDLE_TIMEOUT_MS");

  return {
    relayUrl,
    deviceId,
    enrollmentToken: env.AGENT_ENROLLMENT_TOKEN?.trim() || undefined,
    credentialsFile,
    shell,
    cwd,
    reconnectMinMs: num(env.AGENT_RECONNECT_MIN_MS, 500, "AGENT_RECONNECT_MIN_MS"),
    reconnectMaxMs: num(env.AGENT_RECONNECT_MAX_MS, 30_000, "AGENT_RECONNECT_MAX_MS"),
    reconnectFactor: num(env.AGENT_RECONNECT_FACTOR, 2, "AGENT_RECONNECT_FACTOR"),
    authTimeoutMs: num(env.AGENT_AUTH_TIMEOUT_MS, 10_000, "AGENT_AUTH_TIMEOUT_MS"),
    pingIntervalMs,
    idleTimeoutMs,
    sendHighWaterMark: num(env.AGENT_SEND_HIGH_WATER, 1024 * 1024, "AGENT_SEND_HIGH_WATER"),
    sendLowWaterMark: num(env.AGENT_SEND_LOW_WATER, 256 * 1024, "AGENT_SEND_LOW_WATER"),
  };
}
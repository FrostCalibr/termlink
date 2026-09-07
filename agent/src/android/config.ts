import { loadEnvFile } from "../../../shared/env.js";
import { AgentConfigError } from "../config.js";
import { resolveAndroidShell, type AndroidShellEnvironment } from "./shell-resolver.js";

export interface AndroidAgentConfig {
  /** Relay WS/WSS URL, e.g. `wss://relay.example.com` (appends `/device`). */
  relayUrl: string;
  /** Unique id of this Android device in relay DEVICES config. */
  deviceId: string;
  /** Optional enrollment token. */
  enrollmentToken?: string;
  /** Path to Android credentials file (0600 permissions). */
  credentialsFile: string;
  /** Resolved Android shell environment. */
  shellEnv: AndroidShellEnvironment;
  /** Whether to acquire termux-wake-lock on Android. */
  wakeLock: boolean;
  /** Reconnect backoff parameters. */
  reconnectMinMs: number;
  reconnectMaxMs: number;
  reconnectFactor: number;
  /** Handshake and heartbeat timeouts. */
  authTimeoutMs: number;
  pingIntervalMs: number;
  idleTimeoutMs: number;
  /** Socket backpressure watermarks. */
  sendHighWaterMark: number;
  sendLowWaterMark: number;
}

const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Parse environment for Android agent configuration. */
export function loadAndroidAgentConfig(
  env: Record<string, string | undefined> = process.env as Record<string, string>,
): AndroidAgentConfig {
  if (env === process.env) {
    loadEnvFile();
  }
  const relayUrlRaw = env.ANDROID_RELAY_URL ?? env.RELAY_URL ?? "";
  const relayUrl = relayUrlRaw.trim().replace(/\/+$/, "");
  if (!relayUrl) {
    throw new AgentConfigError("ANDROID_RELAY_URL or RELAY_URL is required (e.g. wss://relay.example.com)");
  }
  let url: URL;
  try {
    url = new URL(relayUrl);
  } catch {
    throw new AgentConfigError(`ANDROID_RELAY_URL "${relayUrl}" is not a valid URL`);
  }
  if (url.protocol !== "wss:" && url.protocol !== "ws:") {
    throw new AgentConfigError("ANDROID_RELAY_URL must be a ws:// or wss:// URL");
  }

  const deviceId = (env.ANDROID_DEVICE_ID ?? env.AGENT_DEVICE_ID ?? "phone").trim();
  if (!DEVICE_ID_RE.test(deviceId)) {
    throw new AgentConfigError("ANDROID_DEVICE_ID is required and must match [A-Za-z0-9_-]{1,64}");
  }

  const credentialsFile =
    env.ANDROID_CREDENTIALS_FILE?.trim() ||
    env.AGENT_CREDENTIALS_FILE?.trim() ||
    env.CREDENTIALS_FILE?.trim() ||
    "android-device.secret";

  const preferredShell = env.ANDROID_SHELL?.trim() || env.AGENT_SHELL?.trim();
  const preferredCwd = env.ANDROID_CWD?.trim() || env.AGENT_CWD?.trim();

  const shellEnv = resolveAndroidShell(preferredShell, preferredCwd, env);

  const num = (raw: string | undefined, fallback: number, name: string): number => {
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      throw new AgentConfigError(`${name} must be a positive number`);
    }
    return n;
  };

  const wakeLockRaw = env.ANDROID_WAKE_LOCK?.trim().toLowerCase();
  const wakeLock = wakeLockRaw === undefined ? true : wakeLockRaw !== "false" && wakeLockRaw !== "0";

  return {
    relayUrl,
    deviceId,
    enrollmentToken: env.ANDROID_ENROLLMENT_TOKEN?.trim() || env.AGENT_ENROLLMENT_TOKEN?.trim(),
    credentialsFile,
    shellEnv,
    wakeLock,
    reconnectMinMs: num(env.ANDROID_RECONNECT_MIN_MS ?? env.AGENT_RECONNECT_MIN_MS, 500, "ANDROID_RECONNECT_MIN_MS"),
    reconnectMaxMs: num(env.ANDROID_RECONNECT_MAX_MS ?? env.AGENT_RECONNECT_MAX_MS, 30_000, "ANDROID_RECONNECT_MAX_MS"),
    reconnectFactor: num(env.ANDROID_RECONNECT_FACTOR ?? env.AGENT_RECONNECT_FACTOR, 2, "ANDROID_RECONNECT_FACTOR"),
    authTimeoutMs: num(env.ANDROID_AUTH_TIMEOUT_MS ?? env.AGENT_AUTH_TIMEOUT_MS, 10_000, "ANDROID_AUTH_TIMEOUT_MS"),
    pingIntervalMs: num(env.ANDROID_PING_INTERVAL_MS ?? env.AGENT_PING_INTERVAL_MS, 20_000, "ANDROID_PING_INTERVAL_MS"),
    idleTimeoutMs: num(env.ANDROID_IDLE_TIMEOUT_MS ?? env.AGENT_IDLE_TIMEOUT_MS, 90_000, "ANDROID_IDLE_TIMEOUT_MS"),
    sendHighWaterMark: num(env.ANDROID_SEND_HIGH_WATER ?? env.AGENT_SEND_HIGH_WATER, 1024 * 1024, "ANDROID_SEND_HIGH_WATER"),
    sendLowWaterMark: num(env.ANDROID_SEND_LOW_WATER ?? env.AGENT_SEND_LOW_WATER, 256 * 1024, "ANDROID_SEND_LOW_WATER"),
  };
}

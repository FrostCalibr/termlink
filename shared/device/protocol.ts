import { FrameError } from "../protocol/framing.js";

/**
 * Phase 9 device-agent protocol.
 *
 * A device agent holds one persistent, outbound WebSocket to the relay's
 * `/device` endpoint. The relay is authoritative: it authenticates the agent
 * (enrollment via a device-generated secret, then secret-based auth on every
 * reconnect) and opens multiplexed terminal channels for browser sessions.
 * Each channel carries the same `terminal_input`/`terminal_output`/`terminal_resize`
 * semantics as the relay protocol, so the agent can reuse the existing PTY
 * backend unchanged.
 */

export const DEVICE_PROTOCOL_VERSION = 1;
export const DEVICE_WS_PATH = "/device";

// ── Agent (device) → relay ──────────────────────────────────────────────────

/** First contact: register a pre-authorized, not-yet-enrolled device. */
export interface DeviceRegisterMessage {
  type: "device_register";
  version: number;
  deviceId: string;
  /** Fresh device-generated secret; the relay stores only its scrypt hash. */
  secret: string;
  /** Required when the relay configured an enrollment token for this device. */
  enrollmentToken?: string;
}

/** Subsequent contacts: authenticate with the enrolled secret. */
export interface DeviceAuthMessage {
  type: "device_auth";
  version: number;
  deviceId: string;
  secret: string;
}

/** A browser session produced output bytes (base64). */
export interface DeviceSessionOutputMessage {
  type: "device_session_output";
  sessionId: string;
  data: string;
}

/** The agent could not spawn/start the requested terminal session. */
export interface DeviceSessionFailedMessage {
  type: "device_session_failed";
  sessionId: string;
  reason: string;
}

/** The session's terminal exited on its own. */
export interface DeviceSessionExitedMessage {
  type: "device_session_exited";
  sessionId: string;
}

export interface AgentPingMessage {
  type: "ping";
}

export interface AgentGoodbyeMessage {
  type: "goodbye";
  reason?: string;
}

export type DeviceClientMessage =
  | DeviceRegisterMessage
  | DeviceAuthMessage
  | DeviceSessionOutputMessage
  | DeviceSessionFailedMessage
  | DeviceSessionExitedMessage
  | AgentPingMessage
  | AgentGoodbyeMessage;

// ── Relay → agent ───────────────────────────────────────────────────────────

export interface DeviceOkMessage {
  type: "device_ok";
  version: number;
  deviceId: string;
  name: string;
  deviceType: string;
  state: "registered" | "authenticated";
}

export interface DeviceErrorMessage {
  type: "device_err";
  error: string;
}

/** The relay asks the agent to spawn a fresh isolated terminal session. */
export interface DeviceSessionOpenMessage {
  type: "device_session_open";
  sessionId: string;
  cols: number;
  rows: number;
}

/** The relay asks the agent to tear down a terminal session. */
export interface DeviceSessionCloseMessage {
  type: "device_session_close";
  sessionId: string;
  reason?: string;
}

/** Browser terminal input bytes (base64) for a session. */
export interface DeviceSessionInputMessage {
  type: "device_session_input";
  sessionId: string;
  data: string;
}

/** Browser terminal resize for a session. */
export interface DeviceSessionResizeMessage {
  type: "device_session_resize";
  sessionId: string;
  cols: number;
  rows: number;
}

export interface DevicePongMessage {
  type: "pong";
}

export type DeviceServerMessage =
  | DeviceOkMessage
  | DeviceErrorMessage
  | DeviceSessionOpenMessage
  | DeviceSessionCloseMessage
  | DeviceSessionInputMessage
  | DeviceSessionResizeMessage
  | DevicePongMessage
  | AgentGoodbyeMessage;

export type DeviceMessage = DeviceClientMessage | DeviceServerMessage;

const CLIENT_TYPES = new Set([
  "device_register",
  "device_auth",
  "device_session_output",
  "device_session_failed",
  "device_session_exited",
  "ping",
  "goodbye",
]);
const SERVER_TYPES = new Set([
  "device_ok",
  "device_err",
  "device_session_open",
  "device_session_close",
  "device_session_input",
  "device_session_resize",
  "pong",
  "goodbye",
]);

function isPosInt(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isText(value: unknown): value is string {
  return typeof value === "string";
}

function isSessionText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Whether a parsed message is an agent → relay message. */
export function isDeviceClientMessage(
  msg: DeviceMessage,
): msg is DeviceClientMessage {
  return CLIENT_TYPES.has(msg.type);
}

/** Whether a parsed message is a relay → agent message. */
export function isDeviceServerMessage(
  msg: DeviceMessage,
): msg is DeviceServerMessage {
  return SERVER_TYPES.has(msg.type);
}

function isValidDeviceMessage(obj: unknown): obj is DeviceMessage {
  if (typeof obj !== "object" || obj === null) return false;
  const rec = obj as Record<string, unknown>;
  if (typeof rec.type !== "string") return false;
  if (!CLIENT_TYPES.has(rec.type) && !SERVER_TYPES.has(rec.type)) return false;

  switch (rec.type) {
    case "device_register":
      return (
        rec.version === DEVICE_PROTOCOL_VERSION &&
        isText(rec.deviceId) &&
        rec.deviceId.length > 0 &&
        isText(rec.secret) &&
        rec.secret.length > 0 &&
        (rec.enrollmentToken === undefined || isText(rec.enrollmentToken))
      );
    case "device_auth":
      return (
        rec.version === DEVICE_PROTOCOL_VERSION &&
        isText(rec.deviceId) &&
        rec.deviceId.length > 0 &&
        isText(rec.secret) &&
        rec.secret.length > 0
      );
    case "device_session_output":
      return isSessionText(rec.sessionId) && isText(rec.data);
    case "device_session_failed":
      return isSessionText(rec.sessionId) && isText(rec.reason);
    case "device_session_exited":
      return isSessionText(rec.sessionId);
    case "device_session_open":
      return (
        isSessionText(rec.sessionId) && isPosInt(rec.cols) && isPosInt(rec.rows)
      );
    case "device_session_close":
      return (
        isSessionText(rec.sessionId) &&
        (rec.reason === undefined || isText(rec.reason))
      );
    case "device_session_input":
      return isSessionText(rec.sessionId) && isText(rec.data);
    case "device_session_resize":
      return (
        isSessionText(rec.sessionId) && isPosInt(rec.cols) && isPosInt(rec.rows)
      );
    case "device_ok":
      return (
        rec.version === DEVICE_PROTOCOL_VERSION &&
        isText(rec.deviceId) &&
        isText(rec.name) &&
        isText(rec.deviceType) &&
        (rec.state === "registered" || rec.state === "authenticated")
      );
    case "device_err":
      return isText(rec.error);
    case "ping":
    case "pong":
      return true;
    case "goodbye":
      return rec.reason === undefined || isText(rec.reason);
    default:
      return false;
  }
}

/**
 * Parse and validate a JSON-encoded device protocol message (a complete WS
 * text frame). Throws {@link FrameError} for malformed JSON or schema
 * violations.
 */
export function parseJsonDeviceMessage(text: string): DeviceMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new FrameError("Device message is not valid JSON");
  }
  if (!isValidDeviceMessage(parsed)) {
    throw new FrameError("Device message does not match message schema");
  }
  return parsed;
}
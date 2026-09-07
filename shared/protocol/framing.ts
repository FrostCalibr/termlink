import { HEADER_SIZE, DEFAULT_MAX_FRAME_SIZE } from "./constants.js";
import type { ServerMessage, ClientMessage } from "./types.js";

export type Message = ServerMessage | ClientMessage;

/**
 * Encode a message into a length-prefixed TCP frame.
 *
 * Frame layout:
 *   [4 bytes: uint32 BE payload length][UTF-8 JSON payload]
 */
export function encodeFrame(msg: Message): Buffer {
  const json = JSON.stringify(msg);
  const payload = Buffer.from(json, "utf-8");
  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

/**
 * Incremental frame decoder.
 *
 * Accumulates bytes from TCP reads and yields complete frames.
 * Enforces a maximum frame size to prevent unbounded memory allocation.
 */
export class FrameDecoder {
  private buffer = Buffer.alloc(0);
  private maxFrameSize: number;

  constructor(maxFrameSize: number = DEFAULT_MAX_FRAME_SIZE) {
    this.maxFrameSize = maxFrameSize;
  }

  /** Feed raw bytes from a socket into the decoder. */
  feed(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);
  }

  /**
   * Try to read one complete frame from the buffer.
   * Returns the parsed message, or null if more data is needed.
   * Throws on malformed/oversized frames.
   */
  read(): Message | null {
    if (this.buffer.length < HEADER_SIZE) {
      return null;
    }

    const payloadLength = this.buffer.readUInt32BE(0);

    if (payloadLength === 0) {
      // Consume the header and reject zero-length payloads
      this.buffer = this.buffer.subarray(HEADER_SIZE);
      throw new FrameError("Frame payload length is zero");
    }

    if (payloadLength > this.maxFrameSize) {
      // Do NOT allocate based on the untrusted length
      throw new FrameError(
        `Frame payload size ${payloadLength} exceeds maximum ${this.maxFrameSize}`,
      );
    }

    const totalFrameSize = HEADER_SIZE + payloadLength;
    if (this.buffer.length < totalFrameSize) {
      return null; // need more data
    }

    // We have a complete frame — extract and consume it
    const payloadBuf = this.buffer.subarray(HEADER_SIZE, totalFrameSize);
    this.buffer = this.buffer.subarray(totalFrameSize);

    const json = payloadBuf.toString("utf-8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new FrameError("Frame payload is not valid JSON");
    }

    if (!isValidMessage(parsed)) {
      throw new FrameError("Frame payload does not match message schema");
    }

    return parsed;
  }

  /** Reset the internal buffer (e.g. after an error). */
  reset(): void {
    this.buffer = Buffer.alloc(0);
  }

  /** Number of bytes currently buffered. */
  get buffered(): number {
    return this.buffer.length;
  }
}

export class FrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameError";
  }
}

// ── Message validation ──────────────────────────────────────────────────────

const VALID_SERVER_TYPES = new Set([
  "hello",
  "auth_ok",
  "auth_fail",
  "data",
  "binary",
  "terminal_output",
  "pong",
  "goodbye",
]);
const VALID_CLIENT_TYPES = new Set([
  "auth_request",
  "data",
  "binary",
  "terminal_input",
  "terminal_resize",
  "ping",
  "goodbye",
]);

const CLIENT_TYPE_SET = new Set([
  "auth_request",
  "data",
  "binary",
  "terminal_input",
  "terminal_resize",
  "ping",
  "goodbye",
]);
const SERVER_TYPE_SET = new Set([
  "hello",
  "auth_ok",
  "auth_fail",
  "data",
  "binary",
  "terminal_output",
  "pong",
  "goodbye",
]);

/**
 * Parse and validate a JSON-encoded protocol message.
 * Throws {@link FrameError} for malformed JSON or schema violations.
 * Used by message-based transports (e.g. WebSocket) where each message is a
 * complete frame and the TCP length prefix is absent.
 */
export function parseJsonMessage(text: string): Message {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new FrameError("Message is not valid JSON");
  }
  if (!isValidMessage(parsed)) {
    throw new FrameError("Message does not match message schema");
  }
  return parsed;
}

/** Whether a decoded message is a client→server message. */
export function isClientMessage(msg: Message): msg is ClientMessage {
  return CLIENT_TYPE_SET.has(msg.type);
}

/** Whether a decoded message is a server→client message. */
export function isServerMessage(msg: Message): msg is ServerMessage {
  return SERVER_TYPE_SET.has(msg.type);
}

function isValidMessage(obj: unknown): obj is Message {
  if (typeof obj !== "object" || obj === null) return false;
  const rec = obj as Record<string, unknown>;
  if (typeof rec.type !== "string") return false;
  if (!VALID_SERVER_TYPES.has(rec.type) && !VALID_CLIENT_TYPES.has(rec.type)) {
    return false;
  }

  switch (rec.type) {
    case "hello":
      return (
        typeof rec.version === "number" &&
        Array.isArray(rec.auth_methods) &&
        rec.auth_methods.every((m: unknown) => typeof m === "string")
      );
    case "auth_ok":
      return typeof rec.session_id === "string";
    case "auth_fail":
      return typeof rec.reason === "string";
    case "data":
      return typeof rec.data === "string";
    case "binary":
      return typeof rec.data === "string";
    case "terminal_input":
      return typeof rec.data === "string";
    case "terminal_output":
      return typeof rec.data === "string";
    case "terminal_resize":
      return (
        typeof rec.cols === "number" &&
        Number.isInteger(rec.cols) &&
        rec.cols > 0 &&
        typeof rec.rows === "number" &&
        Number.isInteger(rec.rows) &&
        rec.rows > 0
      );
    case "pong":
      return true;
    case "ping":
      return true;
    case "goodbye":
      return rec.reason === undefined || typeof rec.reason === "string";
    case "auth_request":
      if (rec.method === "token") return typeof rec.token === "string";
      if (rec.method === "password")
        return (
          typeof rec.username === "string" && typeof rec.password === "string"
        );
      return false;
    default:
      return false;
  }
}

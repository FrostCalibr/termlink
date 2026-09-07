/**
 * WebSocket transport for the browser-facing web client.
 *
 * Deliberately UI-free and universal: it runs in the browser (real WebSocket)
 * and in Node (global WebSocket) so it can be tested headlessly.
 *
 * Wire format mirrors the relay protocol: text frames carry protocol JSON
 * (hello / auth_ok / auth_fail / data / binary / terminal_output / pong /
 * goodbye), binary frames carry raw payload bytes and map to BinaryMessage.
 */

export type WebTransportEvent =
  | { type: "connecting"; attempt: number }
  | { type: "open" }
  | { type: "hello"; authMethods: string[] }
  | { type: "ready"; sessionId: string }
  | { type: "auth_failed"; reason: string }
  | { type: "data"; payload: string }
  | { type: "binary"; payload: ArrayBuffer }
  | { type: "terminal_output"; payload: ArrayBuffer }
  | { type: "pong" }
  | { type: "goodbye"; reason?: string }
  | { type: "closed"; reason?: string }
  | { type: "error"; message: string }
  | { type: "reconnect_failed" };

export interface WebTransportOptions {
  url: string;
  token?: string;
  username?: string;
  password?: string;
  reconnect?: boolean;
  maxReconnectAttempts?: number;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  binaryType?: "blob" | "arraybuffer";
  maxOutboundFrames?: number;
  maxOutboundBytes?: number;
  onEvent?: (event: WebTransportEvent) => void;
}

const DEFAULTS = {
  reconnect: true,
  maxReconnectAttempts: 5,
  reconnectBaseDelayMs: 500,
  reconnectMaxDelayMs: 8000,
  binaryType: "arraybuffer" as const,
  maxOutboundFrames: 1024,
  maxOutboundBytes: 16 * 1024 * 1024,
};

type InternalOptions = Required<Omit<WebTransportOptions, "onEvent" | "url">> &
  Pick<WebTransportOptions, "url">;

type RawEvent = MessageEvent;

/** Messages the server may send pre-auth. */
function parseServerMessage(text: string) {
  const parsed = JSON.parse(text);
  return parsed as Record<string, unknown>;
}

export class WebTransport {
  private ws: WebSocket | null = null;
  private options: InternalOptions;
  private onEvent: (event: WebTransportEvent) => void;
  private url: string;
  private closedByUs = false;
  private authRejected = false;
  private readyState: "disconnected" | "connecting" | "authenticating" | "ready" = "disconnected";
  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;
  private outboundQueue: Array<string | ArrayBuffer> = [];
  private outboundBytes = 0;

  constructor(options: WebTransportOptions) {
    this.url = options.url;
    this.options = { ...DEFAULTS, ...options } as InternalOptions;
    this.onEvent = options.onEvent ?? (() => undefined);
  }

  /** Open the transport. A reconnect is triggered on unexpected close. */
  connect(): void {
    if (this.ws) return;
    this.openSocket(false);
  }

  /** Send text data once ready. Returns false if bounded buffer is full. */
  sendData(payload: string): boolean {
    if (this.readyState !== "ready") return false;
    return this.enqueue(JSON.stringify({ type: "data", data: payload }));
  }

  /** Send binary bytes once ready (sent as a raw binary frame). */
  sendBinary(bytes: Uint8Array): boolean {
    if (this.readyState !== "ready") return false;
    return this.enqueue(bytes.buffer as ArrayBuffer);
  }

  /** Send terminal input bytes once ready (terminal_input JSON). */
  sendTerminalInput(bytes: Uint8Array): boolean {
    if (this.readyState !== "ready") return false;
    return this.enqueue(JSON.stringify({ type: "terminal_input", data: toBase64(bytes) }));
  }

  /** Send a terminal resize request once ready. */
  sendTerminalResize(cols: number, rows: number): boolean {
    if (this.readyState !== "ready") return false;
    return this.enqueue(JSON.stringify({ type: "terminal_resize", cols, rows }));
  }

  /** Send a keepalive ping. */
  sendPing(): boolean {
    if (this.readyState !== "ready") return false;
    return this.enqueue(JSON.stringify({ type: "ping" }));
  }

  /** Cleanly close: protocol goodbye, then WebSocket close. */
  close(): void {
    this.closedByUs = true;
    this.cancelReconnect();
    if (this.ws && this.readyState === "ready") {
      try {
        this.ws.send(JSON.stringify({ type: "goodbye", reason: "web client closed" }));
      } catch {
        /* ignore */
      }
    }
    this.teardown();
  }

  /** Immediate teardown without a goodbye. */
  destroy(): void {
    this.closedByUs = true;
    this.cancelReconnect();
    this.teardown();
  }

  get isReady(): boolean {
    return this.readyState === "ready";
  }

  get state(): string {
    return this.readyState;
  }

  /** True while the bounded outbound buffer holds data (write pressure). */
  get sendBackpressured(): boolean {
    return this.outboundQueue.length > 0;
  }

  private openSocket(reconnect: boolean): void {
    this.readyState = "connecting";
    this.emit({ type: "connecting", attempt: this.reconnectAttempts });

    const ws = new WebSocket(this.url);
    ws.binaryType = this.options.binaryType;
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.emit({ type: "open" });
    });

    ws.addEventListener("message", (ev: RawEvent) => {
      this.handleMessage(ev);
    });

    ws.addEventListener("close", (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.handleDisconnect(ev.reason || "websocket closed");
    });

    ws.addEventListener("error", () => {
      this.emit({ type: "error", message: "websocket error" });
    });
  }

  private handleMessage(ev: RawEvent): void {
    if (typeof ev.data === "string") {
      this.handleText(ev.data);
      return;
    }
    // Binary frame → raw payload bytes (BinaryMessage).
    if (this.readyState === "ready") {
      this.emit({ type: "binary", payload: toArrayBuffer(ev.data) });
    }
  }

  private handleText(text: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = parseServerMessage(text);
    } catch {
      this.emit({ type: "error", message: "proto: invalid JSON from server" });
      return;
    }

    switch (msg.type) {
      case "hello":
        if (this.readyState !== "connecting") {
          this.failProtocol("unexpected hello");
          return;
        }
        this.readyState = "authenticating";
        this.emit({ type: "hello", authMethods: StringArray(msg.auth_methods) });
        this.sendAuthRequest(StringArray(msg.auth_methods));
        break;
      case "auth_ok":
        if (this.readyState !== "authenticating") {
          this.failProtocol("unexpected auth_ok");
          return;
        }
        this.readyState = "ready";
        this.reconnectAttempts = 0;
        this.emit({ type: "ready", sessionId: String(msg.session_id ?? "") });
        break;
      case "auth_fail":
        if (this.readyState !== "authenticating") {
          this.failProtocol("unexpected auth_fail");
          return;
        }
        this.authRejected = true;
        this.closedByUs = true;
        this.cancelReconnect();
        this.emit({ type: "auth_failed", reason: String(msg.reason ?? "") });
        break;
      case "data":
        if (this.readyState !== "ready") {
          this.failProtocol("unexpected data");
          return;
        }
        this.emit({ type: "data", payload: String(msg.data ?? "") });
        break;
      case "binary":
        if (this.readyState !== "ready") {
          this.failProtocol("unexpected binary");
          return;
        }
        this.emit({
          type: "binary",
          payload: toArrayBuffer(decodeBase64(String(msg.data ?? ""))),
        });
        break;
      case "terminal_output":
        if (this.readyState !== "ready") {
          this.failProtocol("unexpected terminal_output");
          return;
        }
        this.emit({
          type: "terminal_output",
          payload: toArrayBuffer(decodeBase64(String(msg.data ?? ""))),
        });
        break;
      case "pong":
        if (this.readyState !== "ready") {
          this.failProtocol("unexpected pong");
          return;
        }
        this.emit({ type: "pong" });
        break;
      case "goodbye":
        this.closedByUs = true;
        this.cancelReconnect();
        this.readyState = "disconnected";
        this.emit({ type: "goodbye", reason: msg.reason as string | undefined });
        break;
      default:
        this.failProtocol(`unknown message type "${String(msg.type)}"`);
    }
  }

  private failProtocol(reason: string): void {
    this.emit({ type: "error", message: `proto: ${reason}` });
    this.closedByUs = true;
    this.teardown();
  }

  private sendAuthRequest(authMethods: string[]): void {
    let auth: Record<string, unknown>;
    if (authMethods.includes("token") && this.options.token) {
      auth = { type: "auth_request", method: "token", token: this.options.token };
    } else if (
      authMethods.includes("password") &&
      this.options.username &&
      this.options.password
    ) {
      auth = {
        type: "auth_request",
        method: "password",
        username: this.options.username,
        password: this.options.password,
      };
    } else {
      this.emit({ type: "error", message: "no usable credentials for auth methods" });
      this.closedByUs = true;
      this.teardown();
      return;
    }
    try {
      this.ws?.send(JSON.stringify(auth));
    } catch {
      /* socket may already be gone */
    }
  }

  private handleDisconnect(reason: string): void {
    this.readyState = "disconnected";
    this.outboundQueue = [];
    this.outboundBytes = 0;
    this.emit({ type: "closed", reason });

    if (this.closedByUs || this.authRejected) {
      return;
    }

    if (!this.options.reconnect) {
      this.emit({ type: "reconnect_failed" });
      return;
    }
    if (this.reconnectAttempts >= this.options.maxReconnectAttempts) {
      this.emit({ type: "reconnect_failed" });
      return;
    }

    const attempt = this.reconnectAttempts + 1;
    const delay = Math.min(
      this.options.reconnectMaxDelayMs,
      this.options.reconnectBaseDelayMs * Math.pow(2, attempt - 1),
    );
    this.reconnectAttempts = attempt;
    this.emit({ type: "connecting", attempt });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket(true);
    }, delay);
  }

  private enqueue(payload: string | ArrayBuffer): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    const size = typeof payload === "string" ? payload.length : payload.byteLength;

    this.outboundQueue.push(payload);
    this.outboundBytes += size;
    if (
      this.outboundQueue.length > this.options.maxOutboundFrames ||
      this.outboundBytes > this.options.maxOutboundBytes
    ) {
      this.emit({ type: "error", message: "outbound buffer overflow" });
      this.closedByUs = true;
      this.teardown();
      return false;
    }
    this.flushOutbound();
    return true;
  }

  private flushOutbound(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    while (this.outboundQueue.length > 0) {
      const payload = this.outboundQueue[0];
      const size = typeof payload === "string" ? payload.length : payload.byteLength;
      try {
        ws.send(payload);
        this.outboundQueue.shift();
        this.outboundBytes -= size;
      } catch {
        return;
      }
    }
  }

  private teardown(): void {
    const ws = this.ws;
    this.ws = null;
    this.readyState = "disconnected";
    this.outboundQueue = [];
    this.outboundBytes = 0;
    if (ws) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private emit(event: WebTransportEvent): void {
    this.onEvent(event);
  }
}

function StringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

/** Decode a base64 string to bytes; invalid input yields an empty buffer. */
function decodeBase64(encoded: string): Uint8Array {
  try {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return new Uint8Array(0);
  }
}

function toArrayBuffer(data: unknown): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  if (data instanceof Uint8Array) {
    return data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength,
    ) as ArrayBuffer;
  }
  if (data instanceof DataView) {
    return data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength,
    ) as ArrayBuffer;
  }
  return new ArrayBuffer(0);
}

/** Base64-encode raw bytes (browser-safe, no Buffer dependency). */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
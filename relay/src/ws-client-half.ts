import type { WebSocket } from "ws";
import { Protocol } from "../../server/src/protocol.js";
import {
  CredentialStore,
  generateConnectionId,
} from "../../server/src/auth.js";
import type { SessionRegistry } from "../../server/src/sessions.js";
import type { AuthRateLimiter } from "../../server/src/rate-limit.js";
import {
  FrameError,
  isClientMessage,
  parseJsonMessage,
  type Message,
} from "../../shared/protocol/framing.js";
import type { AuthRequestMessage, ServerMessage } from "../../shared/protocol/types.js";
import type { RelayBridge, RelayClient } from "./session.js";
import type { RelayLogger } from "./relay.js";

/** Inbound frames buffered while the backend is write-pressured. */
const MAX_INBOUND_FRAMES = 1024;
const MAX_INBOUND_BYTES = 16 * 1024 * 1024;

export interface WebSocketHalfOptions {
  ws: WebSocket;
  auth: CredentialStore;
  sessions: SessionRegistry;
  maxAuthAttempts: number;
  authBackoffMs: number;
  authTimeoutMs: number;
  idleTimeoutMs: number;
  /** Outbound backpressure watermarks (bytes). */
  sendHighWaterMark: number;
  sendLowWaterMark: number;
  /** Optional shared global + per-IP auth rate limiter (or null to disable). */
  authRateLimiter?: AuthRateLimiter | null;
  /**
   * Optional verifier for browser session tokens issued by the web API
   * (`POST /api/auth/login`). Creates the GUI → WS link so the browser never
   * re-presents configured relay credentials after login. Resolves to the
   * authenticated username, or null when the token is not a web session.
   */
  verifySessionToken?: (token: string) => Promise<string | null>;
  /**
   * The GUI session id this connection belongs to (query param `session=`),
   * when the browser created it via the web API.
   */
  guiSessionId?: string;
  /** The device (target id) the browser requested via `?device=`. */
  deviceId?: string;
  /** The requested session type (`?type=`): shell or ssh. */
  sessionType?: string;
  /** The peer socket's remote address, when available. */
  remoteAddress?: string;
  logger: RelayLogger;
  /** Called exactly once after the client authenticates successfully. */
  onAuthenticated: (half: WebSocketClientHalf) => void;
  /** Called exactly once (idempotent) when the socket fully closes. */
  onClose: (half: WebSocketClientHalf) => void;
}

interface OutboundItem {
  /** JSON text (protocol message) or base64-decoded bytes for binary frames. */
  payload: string | Buffer;
  size: number;
}

function asOutbound(msg: ServerMessage): OutboundItem {
  if (msg.type === "binary") {
    const payload = Buffer.from(msg.data, "base64");
    return { payload, size: payload.length };
  }
  const wire = JSON.stringify(msg);
  return { payload: wire, size: Buffer.byteLength(wire, "utf-8") };
}

/**
 * The WebSocket client half of a relay session.
 *
 * Speaks the same framed protocol JSON messages over WebSocket text frames as
 * the TCP front door does over length-prefixed frames: text frames are
 * protocol messages, binary frames are raw payload bytes mapped to
 * {@link BinaryMessage}. It reuses the server `Protocol` state machine and
 * `CredentialStore` unchanged.
 *
 * Backpressure is bounded and explicit: outbound messages are queued up to a
 * configurable high-water mark after which `forward()` reports pressure (the
 * bridge then pauses the backend), and inbound messages are buffered up to a
 * fixed cap while the backend is paused.
 */
export class WebSocketClientHalf implements RelayClient {
  readonly connectionId: string;
  readonly guiSessionId: string | undefined;
  readonly deviceId: string | undefined;
  readonly sessionType: string | undefined;
  private protocol: Protocol;
  private closed = false;
  private authenticated = false;
  private sessionId: string | null = null;
  private bridge: RelayBridge | null = null;
  private authAttempts = 0;
  private authLockedUntil = 0;
  private identity: string | null = null;
  private terminateReason: string | undefined;

  // Outbound (relay → client) bounded buffer.
  private outboundQueue: OutboundItem[] = [];
  private inFlightBytes = 0;
  private pressureSignaled = false;

  // Inbound (client → relay) buffering while the backend is paused.
  private inboundPaused = false;
  private inboundQueue: string[] = [];
  private inboundBytes = 0;

  private authTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(private options: WebSocketHalfOptions) {
    this.connectionId = generateConnectionId();
    this.guiSessionId = options.guiSessionId;
    this.deviceId = options.deviceId;
    this.sessionType = options.sessionType;

    this.protocol = new Protocol({
      send: (msg) => this.send(msg),
      onAuthRequest: (msg) => this.handleAuthRequest(msg),
      onData: (payload) => this.bridge?.onClientData(payload),
      onBinary: (payload) => this.bridge?.onClientBinary(payload),
      onTerminalInput: (payload) => this.bridge?.onClientTerminalInput(payload),
      onTerminalResize: (msg) =>
        this.bridge?.onClientTerminalResize(msg.cols, msg.rows),
    });

    this.options.ws.on("message", (data, isBinary) =>
      this.onMessage(asBuffer(data), isBinary),
    );
    this.options.ws.on("close", () => this.onClose());
    this.options.ws.on("error", () => undefined); // surfaced via close/code
  }

  /** Greet the client and start the authentication window. */
  start(): void {
    this.protocol.hello(this.authMethods());
    this.restartAuthTimer();
    this.restartIdleTimer();
  }

  /** Bind the bridge once created; the half drives it from here on. */
  attachBridge(session: RelayBridge): void {
    this.bridge = session;
  }

  /** The protocol message we just sent during a relay→client push. */
  private authMethods(): string[] {
    const methods: string[] = [];
    if (this.options.auth.tokenCount > 0) methods.push("token");
    if (this.options.auth.hasPasswords) methods.push("password");
    if (methods.length === 0) methods.push("none");
    return methods;
  }

  // ── RelayClient interface ─────────────────────────────────────────────────

  forward(msg: ServerMessage): boolean {
    if (this.closed || this.wsReadyState() !== "open") return false;
    const item = asOutbound(msg);
    const buffered = this.inFlightBytes + this.outboundBytes();
    if (buffered + item.size > this.options.sendHighWaterMark) {
      this.pressureSignaled = true;
      return false;
    }
    this.outboundQueue.push(item);
    this.drainOutbound();
    return true;
  }

  pause(): void {
    this.inboundPaused = true;
  }

  resume(): void {
    this.inboundPaused = false;
    this.flushInbound();
  }

  terminate(reason?: string): void {
    if (this.closed) return;
    this.terminateReason = reason;
    this.options.logger.info("ws_terminate", {
      connection: this.connectionId,
      reason: reason ?? "unspecified",
    });
    this.clearTimers();
    if (this.protocol.isReady) {
      try {
        this.send({ type: "goodbye", reason });
      } catch {
        /* socket may already be gone */
      }
    }
    this.teardown();
    this.closeSocket(reason ?? "closed by relay");
  }

  // ── Inbound message handling ──────────────────────────────────────────────

  private onMessage(data: Buffer, isBinary: boolean): void {
    if (this.closed) return;
    this.restartIdleTimer();

    const wire = isBinary
      ? JSON.stringify({ type: "binary", data: data.toString("base64") })
      : data.toString("utf-8");

    if (this.inboundPaused) {
      this.inboundQueue.push(wire);
      this.inboundBytes += wire.length;
      if (
        this.inboundQueue.length > MAX_INBOUND_FRAMES ||
        this.inboundBytes > MAX_INBOUND_BYTES
      ) {
        this.terminate("Client sent too much data while the backend was busy");
      }
      return;
    }
    this.processInbound(wire);
  }

  private processInbound(wire: string): void {
    if (this.closed) return;
    let msg: Message;
    try {
      msg = parseJsonMessage(wire);
      if (!isClientMessage(msg)) {
        throw new FrameError(`Unexpected message type "${msg.type}"`);
      }
      this.protocol.handle(msg as AuthRequestMessage);
    } catch (err) {
      if (err instanceof FrameError || err instanceof RangeError) {
        this.options.logger.warn("ws_protocol_error", {
          connection: this.connectionId,
          error: (err as Error).message,
        });
        this.terminate(`Protocol error: ${(err as Error).message}`);
      } else {
        this.options.logger.error("ws_message_error", {
          connection: this.connectionId,
          error: String(err),
        });
        this.terminate("Internal error");
      }
    }
  }

  private flushInbound(): void {
    while (this.inboundQueue.length > 0 && !this.inboundPaused && !this.closed) {
      const wire = this.inboundQueue.shift()!;
      this.inboundBytes -= wire.length;
      this.processInbound(wire);
    }
  }

  // ── Authentication (mirrors the TCP Connection's throttling) ──────────────

  private handleAuthRequest(msg: AuthRequestMessage): void {
    // Global + per-IP rate limiting (across connections), before the
    // per-connection throttle divides effort across sockets.
    if (
      this.options.authRateLimiter &&
      !this.options.authRateLimiter.tryAcquire(this.options.remoteAddress)
    ) {
      this.options.logger.warn("ws_auth_rate_limited", {
        connection: this.connectionId,
      });
      this.protocol.authFail("Too many authentication attempts; try again later");
      return;
    }

    const now = Date.now();
    if (now < this.authLockedUntil) {
      this.protocol.authFail("Too many attempts; try again later");
      return;
    }
    if (this.authAttempts >= this.options.maxAuthAttempts) {
      this.authLockedUntil =
        now + this.options.authBackoffMs * this.authAttempts;
      this.protocol.authFail("Too many failed attempts");
      return;
    }
    this.authAttempts++;

    void (async () => {
      let ok = false;
      let authMethod: "token" | "password" | "web_session" = msg.method;
      if (msg.method === "token") {
        ok = await this.options.auth.verifyToken(msg.token);
        if (!ok && this.options.verifySessionToken) {
          const username = await this.options.verifySessionToken(msg.token);
          if (username !== null) {
            ok = true;
            this.identity = username;
            authMethod = "web_session";
          }
        }
      } else {
        ok = await this.options.auth.verifyPassword(
          msg.username,
          msg.password,
        );
        if (ok) this.identity = msg.username;
      }
      if (this.closed) return;
      if (ok) {
        this.authenticated = true;
        const session = this.options.sessions.create(this.connectionId);
        this.sessionId = session.id;
        this.clearAuthTimer();
        this.options.logger.info("ws_authentication_succeeded", {
          connection: this.connectionId,
          method: authMethod,
          username: this.identity ?? undefined,
        });
        this.protocol.authOk(session.id);
        this.options.onAuthenticated(this);
      } else {
        this.options.logger.warn("ws_authentication_failed", {
          connection: this.connectionId,
          method: msg.method,
        });
        this.protocol.authFail("Invalid credentials");
      }
    })();
  }

  // ── Outbound send with bounded buffering ──────────────────────────────────

  private send(msg: ServerMessage): void {
    if (this.closed) return;
    const item = asOutbound(msg);
    this.options.ws.send(item.payload);
  }

  private drainOutbound(): void {
    while (this.outboundQueue.length > 0 && this.wsReadyState() === "open") {
      const item = this.outboundQueue[0];
      if (this.inFlightBytes + item.size > this.options.sendHighWaterMark) {
        this.pressureSignaled = true;
        return;
      }
      this.outboundQueue.shift();
      this.inFlightBytes += item.size;
      try {
        this.options.ws.send(item.payload, () => {
          this.inFlightBytes -= item.size;
          this.maybeReleasePressure();
        });
      } catch (err) {
        this.inFlightBytes -= item.size;
        this.options.logger.error("ws_send_failed", {
          connection: this.connectionId,
          error: String(err),
        });
      }
    }
  }

  private outboundBytes(): number {
    let n = 0;
    for (const item of this.outboundQueue) n += item.size;
    return n;
  }

  private maybeReleasePressure(): void {
    if (
      this.pressureSignaled &&
      this.inFlightBytes + this.outboundBytes() < this.options.sendLowWaterMark
    ) {
      this.pressureSignaled = false;
      this.bridge?.onClientDrained();
    }
  }

  // ── Timers ────────────────────────────────────────────────────────────────

  private restartAuthTimer(): void {
    this.clearAuthTimer();
    this.authTimer = setTimeout(() => {
      this.options.logger.warn("ws_auth_timeout", {
        connection: this.connectionId,
      });
      this.terminate("Authentication timed out");
    }, this.options.authTimeoutMs);
    this.authTimer.unref?.();
  }

  private clearAuthTimer(): void {
    if (this.authTimer) {
      clearTimeout(this.authTimer);
      this.authTimer = null;
    }
  }

  private restartIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.options.logger.info("ws_idle_timeout", {
        connection: this.connectionId,
      });
      this.terminate("Idle timeout");
    }, this.options.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearAuthTimer();
    this.clearIdleTimer();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  private teardown(): void {
    if (this.closed) return;
    this.closed = true;
    this.options.sessions.removeByConnectionId(this.connectionId);
    this.options.onClose(this);
  }

  private onClose(): void {
    this.clearTimers();
    const hadSession = this.authenticated;
    this.bridge?.terminate(
      hadSession ? "WebSocket client disconnected" : undefined,
    );
    this.bridge = null;
    this.teardown();
  }

  private wsReadyState(): "open" | "closed" | "other" {
    const rs = this.options.ws.readyState;
    if (rs === 1) return "open";
    if (rs === 3) return "closed";
    return "other";
  }

  private closeSocket(reason: string): void {
    const ws = this.options.ws;
    const rs = ws.readyState;
    if (rs === 1) {
      ws.close(1000, reason.slice(0, 120));
      // Graceful close requires the peer's handshake reply. Force-terminate
      // after a short grace period so shutdown can never hang on a dead peer.
      const force = setTimeout(() => {
        if (ws.readyState !== 3) ws.terminate();
      }, 1000);
      force.unref?.();
    } else if (rs !== 3) {
      ws.terminate();
    }
  }

  get hasSession(): boolean {
    return this.authenticated;
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  /** The authenticated username when known (password/web-session auth). */
  get authenticatedIdentity(): string | null {
    return this.identity;
  }

  /** The reason this half was last terminated, if any. */
  get lastTerminateReason(): string | undefined {
    return this.terminateReason;
  }
}

function asBuffer(data: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}
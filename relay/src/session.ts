import { TcpClient, type TransportEvent } from "../../client/src/transport.js";
import type { ClientConfig } from "../../client/src/config.js";
import type { ClientTlsConfig } from "../../shared/tlsconfig.js";
import type {
  BinaryMessage,
  DataMessage,
  ServerMessage,
  TerminalInputMessage,
  TerminalResizeMessage,
} from "../../shared/protocol/types.js";

type RelayPayloadMessage =
  | DataMessage
  | BinaryMessage
  | TerminalInputMessage
  | TerminalResizeMessage;

/**
 * The relay's client-facing half. The real implementation is the server-side
 * `Connection`; tests may substitute a fake to exercise the bridge in
 * isolation.
 */
export interface RelayClient {
  readonly connectionId: string;
  /** Write a protocol frame to the client. False if write-pressured. */
  forward(msg: ServerMessage): boolean;
  pause(): void;
  resume(): void;
  /** Gracefully terminate the client connection. */
  terminate(reason?: string): void;
}

export interface RelayLogger {
  info: (msg: string, fields?: Record<string, unknown>) => void;
  warn: (msg: string, fields?: Record<string, unknown>) => void;
  error: (msg: string, fields?: Record<string, unknown>) => void;
}

/**
 * The bridge a {@link WebSocketClientHalf} drives once attached. The TCP
 * {@link RelaySession} and the Phase 9 {@link AgentSession} both implement it,
 * so the browser half is agnostic to how the far end is reached (a statically
 * configured backend or an agent device's outbound link).
 */
export interface RelayBridge {
  onClientData(payload: string): void;
  onClientBinary(payload: string): void;
  onClientTerminalInput(payload: string): void;
  onClientTerminalResize(cols: number, rows: number): void;
  onClientDrained(): void;
  /** The client half closed (or the relay asks to tear down). Idempotent. */
  terminate(reason?: string): void;
}

export interface RelaySessionOptions {
  client: RelayClient;
  targetHost: string;
  targetPort: number;
  targetToken?: string;
  targetUsername?: string;
  targetPassword?: string;
  /** Optional TLS for the relay → backend connection. */
  targetTls?: ClientTlsConfig;
  connectTimeoutMs: number;
  idleTimeoutMs: number;
  maxFrameSize: number;
  logger: RelayLogger;
  /** Called exactly once when the session fully tears down. */
  onClose: () => void;
}

const MAX_PRE_READY_FRAMES = 1024;
const MAX_PRE_READY_BYTES = 16 * 1024 * 1024;

/**
 * One client connection paired with one authorized backend connection.
 *
 * This is a protocol-aware bridge, not a raw TCP pipe. Both halves speak the
 * framed relay protocol. The client half authenticates to the relay; the
 * backend half uses the existing `TcpClient` to authenticate to the target as
 * a normal protocol client. Data is only forwarded once BOTH halves are
 * authenticated and ready; anything the client sends before the backend is
 * ready is buffered (bounded) and flushed when the backend reaches ready.
 *
 * Backpressure is managed explicitly at the frame level: when one side's
 * socket is write-pressured, the relay pauses reads on the opposite producer
 * and resumes when the socket drains.
 */
export class RelaySession implements RelayBridge {
  private backend: TcpClient | null = null;
  private closed = false;
  private backendReady = false;
  private preReadyQueue: RelayPayloadMessage[] = [];
  private preReadyBytes = 0;
  private clientPausedForBackend = false;
  private backendPausedForClient = false;

  constructor(private options: RelaySessionOptions) {}

  /** Begin connecting and authenticating to the backend target. */
  start(): void {
    const cfg: ClientConfig = {
      host: this.options.targetHost,
      port: this.options.targetPort,
      token: this.options.targetToken,
      username: this.options.targetUsername,
      password: this.options.targetPassword,
      connectTimeoutMs: this.options.connectTimeoutMs,
      idleTimeoutMs: this.options.idleTimeoutMs,
      maxFrameSize: this.options.maxFrameSize,
      reconnect: false,
      reconnectDelayMs: 0,
      maxReconnectAttempts: 0,
      tls: this.options.targetTls,
    };
    this.backend = new TcpClient({
      config: cfg,
      logger: this.options.logger,
      onEvent: (event) => this.onBackendEvent(event),
    });
    this.backend.connectAsync();
  }

  /** Client half delivered a text payload. */
  onClientData(payload: string): void {
    this.onClientMessage({ type: "data", data: payload });
  }

  /** Client half delivered a binary payload. */
  onClientBinary(payload: string): void {
    this.onClientMessage({ type: "binary", data: payload });
  }

  /** Client half delivered terminal input bytes (base64). */
  onClientTerminalInput(payload: string): void {
    this.onClientMessage({ type: "terminal_input", data: payload });
  }

  /** Client half requested a terminal resize. */
  onClientTerminalResize(cols: number, rows: number): void {
    this.onClientMessage({ type: "terminal_resize", cols, rows });
  }

  /** Client socket drained after being write-pressured. */
  onClientDrained(): void {
    if (this.backendPausedForClient) {
      this.backendPausedForClient = false;
      this.backend?.resume();
    }
  }

  /** Tear down both halves cleanly. Idempotent. */
  terminate(reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.backend?.destroy();
    this.options.client.terminate(reason ?? "Relay session closed");
    this.options.onClose();
  }

  private onClientMessage(msg: RelayPayloadMessage): void {
    if (this.closed) return;
    if (!this.backendReady) {
      this.bufferPreReady(msg);
      return;
    }
    this.forwardToBackend(msg);
  }

  private bufferPreReady(msg: RelayPayloadMessage): void {
    this.preReadyQueue.push(msg);
    this.preReadyBytes += estimatePayloadBytes(msg);
    if (
      this.preReadyQueue.length > MAX_PRE_READY_FRAMES ||
      this.preReadyBytes > MAX_PRE_READY_BYTES
    ) {
      this.terminate("Client sent too much data before backend was ready");
    }
  }

  private flushPreReady(): void {
    const queue = this.preReadyQueue;
    this.preReadyQueue = [];
    this.preReadyBytes = 0;
    for (const msg of queue) {
      if (this.closed) return;
      this.forwardToBackend(msg);
    }
  }

  private forwardToBackend(msg: RelayPayloadMessage): void {
    const backend = this.backend;
    if (!backend) return;
    if (msg.type === "data") {
      backend.sendData(msg.data);
    } else if (msg.type === "binary") {
      backend.sendBinary(msg.data);
    } else if (msg.type === "terminal_input") {
      backend.sendTerminalInput(msg.data);
    } else {
      backend.sendTerminalResize(msg.cols, msg.rows);
    }
    if (backend.sendBackpressured && !this.clientPausedForBackend) {
      // Backend is write-pressured: stop pulling more from the client until
      // the backend socket drains (signalled via the "drained" event).
      this.clientPausedForBackend = true;
      this.options.client.pause();
    }
  }

  private forwardToClient(msg: ServerMessage): void {
    if (this.closed) return;
    const ok = this.options.client.forward(msg);
    if (!ok && !this.backendPausedForClient) {
      // Client is write-pressured: stop pulling from the backend until the
      // client socket drains (signalled via onClientDrained).
      this.backendPausedForClient = true;
      this.backend?.pause();
    }
  }

  private onBackendEvent(event: TransportEvent): void {
    if (this.closed) return;
    switch (event.type) {
      case "ready":
        this.backendReady = true;
        this.options.logger.info("relay_backend_ready", {
          session: this.options.client.connectionId,
          sessionId: event.sessionId,
        });
        this.flushPreReady();
        break;
      case "data":
        this.forwardToClient({ type: "data", data: event.payload });
        break;
      case "binary":
        this.forwardToClient({ type: "binary", data: event.payload });
        break;
      case "terminal_output":
        this.forwardToClient({ type: "terminal_output", data: event.payload });
        break;
      case "drained":
        if (this.clientPausedForBackend) {
          this.clientPausedForBackend = false;
          this.options.client.resume();
        }
        break;
      case "auth_failed":
        this.options.logger.warn("relay_backend_auth_failed", {
          session: this.options.client.connectionId,
          reason: event.reason,
        });
        this.terminate("Backend authentication failed");
        break;
      case "disconnected":
        if (this.backendReady) {
          this.terminate("Backend connection lost");
        }
        break;
      case "reconnect_failed":
        if (!this.backendReady) {
          this.terminate("Backend connection failed");
        }
        break;
      case "goodbye":
        this.terminate(event.reason?.length ? event.reason : "Backend closed the connection");
        break;
      default:
        break;
    }
  }
}

function estimatePayloadBytes(msg: RelayPayloadMessage): number {
  if (msg.type === "terminal_resize") return 32;
  return msg.data.length;
}
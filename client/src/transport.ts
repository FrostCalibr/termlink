import { connect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import {
  FrameDecoder,
  FrameError,
  encodeFrame,
  isServerMessage,
  type Message,
} from "../../shared/protocol/framing.js";
import type { ClientConfig } from "./config.js";
import { ClientProtocol, buildAuthRequest } from "./protocol.js";
import type {
  BinaryMessage,
  ClientMessage,
  TerminalInputMessage,
  TerminalResizeMessage,
} from "../../shared/protocol/types.js";

export interface TransportLogger {
  info: (msg: string, fields?: Record<string, unknown>) => void;
  warn: (msg: string, fields?: Record<string, unknown>) => void;
  error: (msg: string, fields?: Record<string, unknown>) => void;
}

export const NOOP_LOGGER: TransportLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export type TransportEvent =
  | { type: "connected" }
  | { type: "ready"; sessionId: string }
  | { type: "auth_failed"; reason: string }
  | { type: "data"; payload: string }
  | { type: "binary"; payload: string }
  | { type: "terminal_output"; payload: string }
  | { type: "pong" }
  | { type: "goodbye"; reason?: string }
  | { type: "disconnected"; error?: Error }
  | { type: "reconnecting"; attempt: number }
  | { type: "reconnect_failed" }
  | { type: "drained" }
  | {
      type: "error";
      error: Error;
      message: string;
    };

export interface TcpClientOptions {
  config: ClientConfig;
  logger?: TransportLogger;
  onEvent?: (event: TransportEvent) => void;
}

/**
 * TCP client transport.
 *
 * Owns the socket and protocol state, applies backpressure, detects
 * disconnects, and optionally reconnects with backoff.
 *
 * Strategy for the clean API the relay will use: events exposed through
 * onEvent callback; explicit send methods for each message type.
 */
export class TcpClient {
  private socket: Socket | null = null;
  private decoder: FrameDecoder | null = null;
  private protocol: ClientProtocol;
  private config: ClientConfig;
  private logger: TransportLogger;
  private onEvent: (event: TransportEvent) => void;
  private closedByUs = false;
  private everConnected = false;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connectTimer: NodeJS.Timeout | null = null;
  private destroyed = false;
  private readonly sendQueue: ClientMessage[] = [];

  constructor(options: TcpClientOptions) {
    this.config = options.config;
    this.logger = options.logger ?? NOOP_LOGGER;
    this.onEvent = options.onEvent ?? (() => undefined);

    this.protocol = new ClientProtocol({
      onHello: (methods) => this.handleHello(methods),
      onAuthOk: (sessionId) => {
        this.emit({ type: "ready", sessionId });
        this.flushQueue();
      },
      onAuthFail: (reason) => this.emit({ type: "auth_failed", reason }),
      onData: (payload) => this.emit({ type: "data", payload }),
      onBinary: (payload) => this.emit({ type: "binary", payload }),
      onTerminalOutput: (payload) => this.emit({ type: "terminal_output", payload }),
      onGoodbye: (reason) => this.emit({ type: "goodbye", reason }),
      onPong: () => this.emit({ type: "pong" }),
    });
  }

  /** Establish a connection. Resolves once the TCP link is up. */
  connect(): Promise<TcpClient> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve(this);
      };
      this.connectOnce(done);
    });
  }

  /** Start a connection attempt in the background. */
  connectAsync(): void {
    this.connectOnce(() => undefined);
  }

  /** Send application data once ready. Buffers before authentication. */
  sendData(payload: string): boolean {
    return this.enqueue({ type: "data", data: payload });
  }

  /** Send binary data (base64-encoded) once ready. Buffers before auth. */
  sendBinary(base64Data: string): boolean {
    return this.enqueue({ type: "binary", data: base64Data } satisfies BinaryMessage);
  }

  /** Send terminal input bytes (base64-encoded) once ready. */
  sendTerminalInput(base64Data: string): boolean {
    return this.enqueue({
      type: "terminal_input",
      data: base64Data,
    } satisfies TerminalInputMessage);
  }

  /** Request a terminal resize once ready. */
  sendTerminalResize(cols: number, rows: number): boolean {
    return this.enqueue({
      type: "terminal_resize",
      cols,
      rows,
    } satisfies TerminalResizeMessage);
  }

  /** Send a ping. */
  ping(): boolean {
    return this.enqueue({ type: "ping" });
  }

  /** Send a goodbye and close cleanly. */
  close(): void {
    if (this.destroyed) return;
    this.closedByUs = true;
    this.clearReconnect();
    const socket = this.socket;
    if (socket) {
      // Graceful half-close: write the goodbye, then FIN, so the peer can
      // acknowledge. The protocol accepts goodbye both while ready and while
      // authenticating. destroy() would discard queued data, so use end().
      socket.end(encodeFrame({ type: "goodbye", reason: "closed by client" }));
    }
  }

  /** Terminate immediately without a goodbye. */
  destroy(): void {
    this.destroyed = true;
    this.destroySocket();
    this.clearReconnect();
  }

  /** Current connection state. */
  get isReady(): boolean {
    return this.protocol.isReady;
  }

  private connectOnce(done?: (err?: Error) => void): void {
    if (this.destroyed) return done?.(new Error("client destroyed"));

    this.logger.info("client_connect", {
      host: this.config.host,
      port: this.config.port,
    });

    const socket = this.createSocket();

    this.socket = socket;
    this.decoder = new FrameDecoder(this.config.maxFrameSize);
    this.protocol.connected();

    // Connect timeout. For TLS this also bounds the handshake.
    this.connectTimer = setTimeout(() => {
      const err = new Error("connection timed out");
      this.logger.warn("connect_timeout", { host: this.config.host, port: this.config.port });
      socket.destroy(err);
    }, this.config.connectTimeoutMs);
    this.connectTimer.unref?.();

    socket.setNoDelay(true);
    socket.setKeepAlive(true);
    socket.setTimeout(this.config.idleTimeoutMs, () => this.onIdleTimeout());

    // The link is considered up once the TCP (plain) or the TLS handshake
    // (encrypted) completes, so `connect()` surfaces handshake failures.
    const linkEvent = this.config.tls ? "secureConnect" : "connect";
    socket.once(linkEvent, () => {
      if (this.connectTimer) {
        clearTimeout(this.connectTimer);
        this.connectTimer = null;
      }
      this.logger.info("client_connected", {
        host: this.config.host,
        port: this.config.port,
      });
      this.everConnected = true;
      this.emit({ type: "connected" });
      done?.();
    });

    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("drain", () => undefined); // keep socket flowing
    socket.on("error", (err) => {
      this.logger.warn("socket_error", { error: String(err.message ?? err) });
      this.emit({ type: "error", error: err, message: err.message });
    });
    socket.on("close", () => {
      this.handleClose(done);
    });
  }

  /** Build the plain or TLS socket for an outbound connection. */
  private createSocket(): Socket {
    const { host, port, tls } = this.config;
    if (!tls) return connect({ host, port });
    return tlsConnect({
      host,
      port,
      ca: tls.ca,
      cert: tls.cert,
      key: tls.key,
      servername: tls.servername,
      rejectUnauthorized: tls.rejectUnauthorized,
    });
  }

  /** Called after a successful connect; send auth. */
  private handleHello(authMethods: string[]): void {
    try {
      const authMsg = buildAuthRequest(authMethods, {
        token: this.config.token,
        username: this.config.username,
        password: this.config.password,
      });
      this.socket?.write(encodeFrame(authMsg));
      this.logger.info("auth_request_sent", { method: (authMsg as { method: string }).method });
    } catch (err) {
      this.emit({
        type: "error",
        error: err as Error,
        message: (err as Error).message,
      });
      this.handleBadCredentials();
    }
  }

  private handleBadCredentials(): void {
    // Missing/incompatible credentials: terminate without reconnecting.
    this.closedByUs = true;
    this.destroySocket();
    this.emit({ type: "auth_failed", reason: "no usable credentials configured" });
  }

  private onData(chunk: Buffer): void {
    if (!this.decoder) return;
    try {
      this.decoder.feed(chunk);
      let msg: Message | null;
      while ((msg = this.decoder.read())) {
        if (isServerMessage(msg)) {
          this.protocol.handle(msg);
        } else {
          throw new FrameError(`Unexpected client-directed message type "${msg.type}"`);
        }
      }
    } catch (err) {
      const e = err as Error;
      this.logger.warn("protocol_error", { error: e.message });
      this.emit({ type: "error", error: e, message: e.message });
      this.handleProtocolError();
    }
  }

  private handleProtocolError(): void {
    this.closedByUs = true;
    this.destroySocket();
  }

  private handleClose(done?: (err?: Error) => void): void {
    // A subsequent reconnect attempt must start a fresh decoder/protocol.
    this.decoder = null;
    this.socket = null;
    this.protocol.disconnected();
    this.emit({ type: "disconnected" });

    const reconnecting = this.config.reconnect && !this.closedByUs && !this.destroyed;
    if (reconnecting && this.reconnectAttempts < this.config.maxReconnectAttempts) {
      this.reconnectAttempts++;
      this.logger.warn("reconnecting", { attempt: this.reconnectAttempts });
      this.emit({ type: "reconnecting", attempt: this.reconnectAttempts });
      this.reconnectTimer = setTimeout(() => this.connectOnce(done), this.config.reconnectDelayMs);
      this.reconnectTimer.unref?.();
    } else {
      this.logger.info("client_stopped", {
        closedByUs: this.closedByUs,
        reconnected: this.reconnectAttempts,
      });
      // Only report failure when a reconnect was expected but could not happen.
      if (!this.closedByUs) {
        this.emit({ type: "reconnect_failed" });
      }
      // If connect() is still waiting for its first link, surface the failure.
      if (!this.everConnected && !this.closedByUs) {
        done?.(new Error("could not establish connection"));
      } else {
        done?.();
      }
    }
  }

  /** Apply backpressure: buffer for later when the socket write queue is full. */
  private enqueue(msg: ClientMessage): boolean {
    if (this.destroyed) return false;
    if (this.protocol.isReady && this.socket) {
      const queued = this.socket.write(encodeFrame(msg));
      if (!queued) {
        this.sendQueue.push(msg);
        this.socket.once("drain", () => this.flushQueue());
      }
      return true;
    }
    this.sendQueue.push(msg);
    return true;
  }

  private flushQueue(): void {
    if (!this.socket || !this.protocol.isReady) return;
    const wasBackpressured = this.sendQueue.length > 0;
    while (this.sendQueue.length > 0) {
      const msg = this.sendQueue.shift()!;
      const queued = this.socket.write(encodeFrame(msg));
      if (!queued) {
        this.sendQueue.unshift(msg);
        this.socket.once("drain", () => this.flushQueue());
        return;
      }
    }
    if (wasBackpressured && this.sendQueue.length === 0) {
      this.emit({ type: "drained" });
    }
  }

  /** Whether buffered data is waiting to be sent (write pressure). */
  get sendBackpressured(): boolean {
    return this.sendQueue.length > 0;
  }

  /** Pause reads from the backend socket. Used by the relay bridge. */
  pause(): void {
    this.socket?.pause();
  }

  /** Resume reads from the backend socket. Used by the relay bridge. */
  resume(): void {
    this.socket?.resume();
  }

  private onIdleTimeout(): void {
    this.logger.warn("idle_timeout", {});
    this.emit({ type: "error", error: new Error("idle timeout"), message: "idle timeout" });
    this.closedByUs = true;
    this.destroySocket();
  }

  private destroySocket(): void {
    const socket = this.socket;
    this.socket = null;
    this.decoder = null;
    if (socket) socket.destroy();
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private emit(event: TransportEvent): void {
    this.onEvent(event);
  }
}
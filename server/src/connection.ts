import type { Socket } from "node:net";
import {
  FrameDecoder,
  FrameError,
  encodeFrame,
  isClientMessage,
  type Message,
} from "../../shared/protocol/framing.js";
import { Protocol } from "./protocol.js";
import { CredentialStore, generateConnectionId } from "./auth.js";
import { SessionRegistry } from "./sessions.js";
import type { Config } from "./config.js";
import type { PtyBackend } from "./pty.js";
import type { SshBackend } from "./ssh-backend.js";
import type { AuthRateLimiter } from "./rate-limit.js";
import type {
  AuthRequestMessage,
  ServerMessage,
  TerminalResizeMessage,
} from "../../shared/protocol/types.js";

export interface ConnectionLogger {
  info: (msg: string, fields?: Record<string, unknown>) => void;
  warn: (msg: string, fields?: Record<string, unknown>) => void;
  error: (msg: string, fields?: Record<string, unknown>) => void;
}

export interface ConnectionCallbacks {
  /** Called exactly once when the connection fully closes, for cleanup. */
  onClose: (connectionId: string, hadSession: boolean) => void;
  /** Called when an unauthenticated connection is rejected by the acceptor. */
  onRejected?: (connectionId: string) => void;
  /**
   * Called when authenticated data arrives. Defaults to echo mode. The relay
   * (Phase 3) injects a forwarder here.
   */
  onData?: (payload: string) => void;
  /** Called when authenticated binary data arrives. */
  onBinary?: (payload: string) => void;
  /** Terminal input bytes (base64) from the client. Defaults to the local PTY. */
  onTerminalInput?: (payload: string) => void;
  /** Client terminal resize request. Defaults to the local PTY. */
  onTerminalResize?: (cols: number, rows: number) => void;
  /** Called right after client authentication succeeds. */
  onAuthenticated?: (sessionId: string) => void;
  /** Called when the socket drains after being write-pressured. */
  onDrained?: () => void;
}

/**
 * Wraps a single TCP socket: framing, protocol state machine, auth,
 * backpressure, timeouts, and lifecycle cleanup.
 */
export class Connection {
  readonly id: string;
  private decoder: FrameDecoder;
  private protocol: Protocol;
  private closed = false;
  private authenticated = false;
  private sessionId: string | null = null;
  private authAttempts = 0;
  private authLockedUntil = 0;
  private authTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private socket: Socket,
    private config: Config,
    private auth: CredentialStore,
    private sessions: SessionRegistry,
    private logger: ConnectionLogger,
    private callbacks: ConnectionCallbacks,
    private pty: PtyBackend | null = null,
    private authLimiter: AuthRateLimiter | null = null,
    private ssh: SshBackend | null = null,
  ) {
    this.id = generateConnectionId();
    this.decoder = new FrameDecoder(config.maxFrameSize);

    this.protocol = new Protocol({
      send: (msg) => this.sendSafe(msg),
      onAuthRequest: (msg) => this.handleAuthRequest(msg),
      onData: (payload) => {
        const injected = this.callbacks.onData;
        if (injected) {
          injected(payload);
          return;
        }
        this.handleData(payload);
      },
      onBinary: (payload) => {
        const injected = this.callbacks.onBinary;
        if (injected) {
          injected(payload);
          return;
        }
        this.handleBinary(payload);
      },
      onTerminalInput: (payload) => {
        const injected = this.callbacks.onTerminalInput;
        if (injected) {
          injected(payload);
          return;
        }
        if (this.pty) {
          this.pty.write(this.id, payload);
        } else {
          this.ssh?.write(this.id, payload);
        }
      },
      onTerminalResize: (msg: TerminalResizeMessage) => {
        const injected = this.callbacks.onTerminalResize;
        if (injected) {
          injected(msg.cols, msg.rows);
          return;
        }
        if (this.pty) {
          this.pty.resize(this.id, msg.cols, msg.rows);
        } else {
          this.ssh?.resize(this.id, msg.cols, msg.rows);
        }
      },
    });

    this.socket.on("data", (chunk) => this.onData(chunk));
    this.socket.on("error", (err) => this.onError(err));
    this.socket.on("close", () => this.onClose());
    this.socket.on("end", () => this.onEnd());
    this.socket.on("drain", () => this.callbacks.onDrained?.());

    this.socket.setKeepAlive(true);
    this.socket.setNoDelay(true);
    this.socket.setTimeout(this.config.idleTimeoutMs, () => this.onIdleTimeout());
  }

  /** Begin the protocol by sending hello. */
  start(): void {
    const methods: string[] = [];
    if (this.auth.tokenCount > 0) methods.push("token");
    if (this.auth.hasPasswords) methods.push("password");
    this.protocol.hello(methods);
    this.startAuthTimeout();
  }

  /** Enforce the unauthenticated-lifetime cap unless disabled. */
  private startAuthTimeout(): void {
    if (this.config.authTimeoutMs <= 0) return;
    this.authTimer = setTimeout(() => {
      if (this.authenticated || this.closed) return;
      this.logger.info("auth_timeout", { connection: this.id });
      this.protocol.peerClosed("Authentication timed out");
      this.sendSafe({ type: "goodbye", reason: "Authentication timed out" });
      this.socket.end();
    }, this.config.authTimeoutMs);
    this.authTimer.unref?.();
  }

  private clearAuthTimeout(): void {
    if (this.authTimer) {
      clearTimeout(this.authTimer);
      this.authTimer = null;
    }
  }

  /**
   * Send a message to the client without applying internal backpressure.
   * Returns false if the socket write buffer is at its high-water mark.
   * Used by the relay bridge, which owns backpressure explicitly.
   */
  forward(msg: ServerMessage): boolean {
    if (this.closed) return false;
    return this.socket.write(encodeFrame(msg));
  }

  /** Pause reads from the client. Used by the relay bridge. */
  pause(): void {
    this.socket.pause();
  }

  /** Resume reads from the client. Used by the relay bridge. */
  resume(): void {
    this.socket.resume();
  }

  /** Terminate this connection with a graceful goodbye. */
  terminate(reason?: string): void {
    this.fail(reason ?? "Connection closed");
  }

  private onData(chunk: Buffer): void {
    try {
      this.decoder.feed(chunk);
      let msg: Message | null;
      while ((msg = this.decoder.read())) {
        if (!isClientMessage(msg)) {
          throw new FrameError(`Unexpected message type "${msg.type}"`);
        }
        this.protocol.handle(msg);
      }
    } catch (err) {
      if (err instanceof FrameError) {
        this.logger.warn("protocol_error", {
          connection: this.id,
          error: err.message,
        });
        this.fail(`Protocol error: ${err.message}`);
      } else {
        this.logger.error("connection_error", {
          connection: this.id,
          error: String(err),
        });
        this.fail("Internal error");
      }
    }
  }

  private handleAuthRequest(msg: AuthRequestMessage): void {
    // Global + per-IP rate limiting (across connections). Checked before the
    // per-connection throttle so distributed brute-force is bounded too.
    const ip = this.socket.remoteAddress;
    if (this.authLimiter && !this.authLimiter.tryAcquire(ip)) {
      this.logger.warn("auth_rate_limited", { connection: this.id, ip });
      this.sendAuthFail("Too many authentication attempts; try again later");
      return;
    }

    // Brute-force throttling
    const now = Date.now();
    if (now < this.authLockedUntil) {
      this.sendAuthFail("Too many attempts; try again later");
      return;
    }
    if (this.authAttempts >= this.config.maxAuthAttempts) {
      this.authLockedUntil =
        now + this.config.authBackoffMs * this.authAttempts;
      this.sendAuthFail("Too many failed attempts");
      return;
    }

    this.authAttempts++;

    void (async () => {
      let ok = false;
      if (msg.method === "token") {
        ok = await this.auth.verifyToken(msg.token);
      } else {
        ok = await this.auth.verifyPassword(msg.username, msg.password);
      }
      if (this.closed) return;
      if (ok) {
        this.authenticated = true;
        this.clearAuthTimeout();
        const session = this.sessions.create(this.id);
        this.sessionId = session.id;
        this.logger.info("authentication_succeeded", {
          connection: this.id,
          method: msg.method,
          username: msg.method === "password" ? msg.username : undefined,
        });
        this.protocol.authOk(session.id);
        this.callbacks.onAuthenticated?.(session.id);
        this.startTerminalBackend(session.id);
      } else {
        this.logger.warn("authentication_failed", {
          connection: this.id,
          method: msg.method,
        });
        this.sendAuthFail("Invalid credentials");
      }
    })();
  }

  private handleData(payload: string): void {
    // Echo mode: send the payload back to the sender. Used for tests and
    // the interactive client demo. The relay (Phase 3) will forward instead.
    if (this.config.echoData) {
      this.sendSafe({ type: "data", data: payload });
    }
    this.logger.info("data_received", {
      connection: this.id,
      bytes: Buffer.byteLength(payload, "utf-8"),
    });
  }

  private handleBinary(payload: string): void {
    if (this.config.echoData) {
      this.sendSafe({ type: "binary", data: payload });
    }
    this.logger.info("binary_received", {
      connection: this.id,
      bytes: Buffer.byteLength(payload, "utf-8"),
    });
  }

  /**
   * Start the connection's interactive terminal backend once authenticated:
   * either the local PTY shell or the SSH remote shell. A backend that cannot
   * even be started terminates the connection gracefully; failures that
   * arrive later (SSH handshake, shell exit) also terminate it.
   */
  private startTerminalBackend(sessionId: string): void {
    if (this.pty) {
      this.startPty(sessionId);
    } else if (this.ssh) {
      this.startSsh(sessionId);
    }
  }

  /**
   * Spawn the connection's isolated PTY once authenticated. A failed spawn
   * or a shell that exits immediately terminates the connection gracefully.
   */
  private startPty(sessionId: string): void {
    if (!this.pty) return;
    const started = this.pty.start(
      this.id,
      {
        onOutput: (chunk) => this.protocol.terminalOutput(chunk),
        onExit: (_exitCode, signal) => {
          this.logger.info("pty_exited", {
            connection: this.id,
            session: sessionId,
            signal,
          });
          this.fail("Terminal session ended");
        },
      },
      );
    if (!started) {
      this.logger.warn("pty_spawn_unavailable", { connection: this.id });
      this.fail("Terminal unavailable");
    }
  }

  /**
   * Start the connection's SSH session once authenticated. ssh2 connections
   * happen asynchronously; connect/auth/host-key failures surface via
   * `onExit` and terminate the connection gracefully.
   */
  private startSsh(sessionId: string): void {
    if (!this.ssh) return;
    this.ssh.start(this.id, {
      onOutput: (chunk) => this.protocol.terminalOutput(chunk),
      onExit: (detail) => {
        this.logger.info("ssh_session_ended", {
          connection: this.id,
          session: sessionId,
          detail,
        });
        this.fail(detail);
      },
    });
  }

  private sendAuthFail(reason: string): void {
    this.protocol.authFail(reason);
  }

  private sendSafe(msg: ServerMessage): void {
    if (this.closed) return;
    const frame = encodeFrame(msg);
    this.writeWithBackpressure(frame);
  }

  private writeWithBackpressure(frame: Buffer): void {
    const ok = this.socket.write(frame);
    if (ok) return;
    // Socket buffer is full — apply backpressure by pausing reads.
    // Resume once the kernel buffer drains. Guard against double-resume.
    const resumeConnection = () => {
      this.socket.resume();
      this.socket.off("drain", resumeConnection);
      this.socket.off("close", resumeConnection);
      this.socket.off("error", resumeConnection);
    };
    this.socket.once("drain", resumeConnection);
    this.socket.once("close", resumeConnection);
    this.socket.once("error", resumeConnection);
    this.socket.pause();
  }

  private onError(err: Error): void {
    this.logger.warn("socket_error", {
      connection: this.id,
      error: String(err.message || err),
    });
  }

  private onEnd(): void {
    // Peer sent FIN (half-close). Enter closing; data may still be written.
    this.socket.end();
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearAuthTimeout();
    const hadSession = this.authenticated;
    this.pty?.dispose(this.id);
    this.ssh?.dispose(this.id);
    try {
      this.sessions.removeByConnectionId(this.id);
    } finally {
      this.callbacks.onClose(this.id, hadSession);
    }
  }

  private onIdleTimeout(): void {
    this.logger.info("idle_timeout", { connection: this.id });
    this.protocol.peerClosed();
    this.socket.end();
  }

  /** Terminate the connection with a protocol goodbye if possible. */
  private fail(reason: string): void {
    if (this.closed) return;
    try {
      this.protocol.peerClosed(reason);
      this.sendSafe({ type: "goodbye", reason });
    } finally {
      this.socket.end();
    }
  }

  /** Called by the server during shutdown. */
  shutdown(): void {
    if (this.closed) return;
    this.protocol.peerClosed("Server shutting down");
    this.sendSafe({ type: "goodbye", reason: "Server shutting down" });
    this.socket.end();
  }

  get hadSession(): boolean {
    return this.authenticated;
  }

  get connectionId(): string {
    return this.id;
  }
}

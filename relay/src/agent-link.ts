import type { WebSocket } from "ws";
import {
  DEVICE_PROTOCOL_VERSION,
  type DeviceClientMessage,
  type DeviceServerMessage,
  isDeviceClientMessage,
  parseJsonDeviceMessage,
} from "../../shared/device/protocol.js";
import { FrameError } from "../../shared/protocol/framing.js";
import { generateConnectionId } from "../../server/src/auth.js";
import type { AuthRateLimiter } from "../../server/src/rate-limit.js";
import type { DeviceStore } from "./device-store.js";
import type { AgentSession } from "./agent-session.js";
import type { WebSocketClientHalf } from "./ws-client-half.js";
import type { RelayLogger } from "./relay.js";

export interface AgentLinkOptions {
  ws: WebSocket;
  remoteAddress: string | undefined;
  store: DeviceStore;
  logger: RelayLogger;
  authRateLimiter?: AuthRateLimiter | null;
  maxAuthAttempts: number;
  authBackoffMs: number;
  authTimeoutMs: number;
  idleTimeoutMs: number;
  /** Outbound backpressure watermarks (bytes) for the agent WebSocket. */
  sendHighWaterMark: number;
  sendLowWaterMark: number;
  /** Called exactly once when the link authenticates (enrolled or re-authed). */
  onReady: (link: AgentLink, deviceId: string) => void;
  /** Called exactly once when the link fully closes. */
  onClose: (link: AgentLink) => void;
}

const DEFAULT_TERMINAL_COLS = 80;
const DEFAULT_TERMINAL_ROWS = 24;

/**
 * One authenticated, persistent outbound connection from a device agent.
 *
 * The agent is the connecting side (no inbound port on the device). After a
 * successful `device_register` (enrollment) or `device_auth` (reconnect) the
 * link goes `ready`. From then on it multiplexes terminal channels, one per
 * browser GUI session; each channel is an {@link AgentSession}.
 *
 * Authentication reuses the same hardening as the browser front door: a shared
 * global/per-IP rate limiter, per-link attempt backoff, and an auth deadline.
 */
export class AgentLink {
  readonly connectionId: string;
  private ws: WebSocket;
  private store: DeviceStore;
  private logger: RelayLogger;
  private options: AgentLinkOptions;
  private state: "auth" | "ready" | "closed" = "auth";
  private deviceId: string | undefined;
  private channels = new Map<string, AgentSession>();
  private authAttempts = 0;
  private authLockedUntil = 0;
  private authTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private pausedChannels = new Set<AgentSession>();
  private drainTimer: NodeJS.Timeout | null = null;

  constructor(options: AgentLinkOptions) {
    this.options = options;
    this.ws = options.ws;
    this.store = options.store;
    this.logger = options.logger;
    this.connectionId = generateConnectionId();

    this.ws.on("message", (data, isBinary) => this.onMessage(data, isBinary));
    this.ws.on("close", () => this.onSocketClose());
    this.ws.on("error", () => undefined);
  }

  /** Start the authentication window and idle tracking. */
  start(): void {
    this.restartAuthTimer();
    this.restartIdleTimer();
  }

  // ── Authentication (device_register / device_auth) ───────────────────────

  private async onMessage(data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean): Promise<void> {
    if (this.state === "closed") return;
    if (isBinary) {
      this.fail("Binary frames are not part of the device protocol");
      return;
    }
    this.restartIdleTimer();

    let msg: unknown;
    try {
      msg = parseJsonDeviceMessage(data.toString("utf-8"));
    } catch (err) {
      if (err instanceof FrameError) {
        this.fail(`Device protocol error: ${err.message}`);
        return;
      }
      this.fail("Device protocol parse error");
      return;
    }
    if (!isDeviceClientMessage(msg as DeviceClientMessage)) {
      this.fail(`Unexpected device message type "${(msg as { type: string }).type}"`);
      return;
    }
    this.handleClientMessage(msg as DeviceClientMessage);
  }

  private handleClientMessage(msg: DeviceClientMessage): void {
    switch (msg.type) {
      case "device_register":
        void this.authenticate(true, msg.deviceId, msg.secret, msg.enrollmentToken);
        break;
      case "device_auth":
        void this.authenticate(false, msg.deviceId, msg.secret, undefined);
        break;
      case "ping":
        if (this.state === "ready") {
          this.store.touch(this.deviceId!);
          this.rawSend({ type: "pong" });
        }
        break;
      case "device_session_output":
        if (this.state === "ready") this.deliverOutput(msg.sessionId, msg.data);
        break;
      case "device_session_failed":
        if (this.state === "ready") {
          this.channels.get(msg.sessionId)?.onFailed(msg.reason);
        }
        break;
      case "device_session_exited":
        if (this.state === "ready") {
          this.channels.get(msg.sessionId)?.onExited();
        }
        break;
      case "goodbye":
        this.terminate(msg.reason?.length ? msg.reason : "Agent closed the connection");
        break;
    }
  }

  private async authenticate(
    register: boolean,
    deviceId: string,
    secret: string,
    enrollmentToken: string | undefined,
  ): Promise<void> {
    if (this.state !== "auth") {
      this.fail("Already authenticated");
      return;
    }
    if (
      this.options.authRateLimiter &&
      !this.options.authRateLimiter.tryAcquire(this.options.remoteAddress)
    ) {
      this.fail("Too many authentication attempts; try again later");
      return;
    }
    const now = Date.now();
    if (now < this.authLockedUntil) {
      this.fail("Too many attempts; try again later");
      return;
    }
    if (this.authAttempts >= this.options.maxAuthAttempts) {
      this.authLockedUntil =
        now + this.options.authBackoffMs * this.authAttempts;
      this.fail("Too many failed attempts");
      return;
    }
    this.authAttempts++;

    const configured = this.store.config(deviceId);
    if (!configured) {
      this.fail("Unknown device id");
      return;
    }

    if (register) {
      const error = await this.store.register(deviceId, secret, enrollmentToken);
      if (error !== null) {
        this.fail(error);
        return;
      }
      if (
        this.store.enrollmentToken(deviceId) === undefined &&
        this.store.markOpenEnrollmentWarned(deviceId)
      ) {
        this.logger.warn("device_open_enrollment", {
          device: deviceId,
          detail: "DEVICES has no enrollment token for this device; the first agent to connect may claim it",
        });
      }
    } else {
      if (!this.store.isRegistered(deviceId)) {
        // Not yet enrolled: reply so the agent can follow up with
        // device_register on this same link. Everything stays rate-limited
        // and attempt-bounded; a dead idle link still hits the auth timeout.
        this.logger.info("device_link_prompt_enroll", {
          connection: this.connectionId,
          device: deviceId,
        });
        this.rawSend({ type: "device_err", error: "Device not enrolled" });
        return;
      }
      const ok = await this.store.verify(deviceId, secret);
      if (!ok) {
        this.fail("Invalid device secret");
        return;
      }
    }

    if ((this.state as string) === "closed") return;
    this.state = "ready";
    this.deviceId = deviceId;
    this.clearAuthTimer();
    this.store.setOnline(deviceId, this.connectionId);
    this.logger.info("device_link_ready", {
      connection: this.connectionId,
      device: deviceId,
      mode: register ? "registered" : "authenticated",
    });
    this.rawSend({
      type: "device_ok",
      version: DEVICE_PROTOCOL_VERSION,
      deviceId,
      name: configured.name,
      deviceType: configured.type,
      state: register ? "registered" : "authenticated",
    });
    this.options.onReady(this, deviceId);
  }

  private fail(error: string): void {
    if (this.state === "closed") return;
    this.logger.warn("device_link_auth_rejected", {
      connection: this.connectionId,
      error,
    });
    this.rawSend({ type: "device_err", error });
    this.terminate(error);
  }

  // ── Channel (session) management ─────────────────────────────────────────

  /**
   * Open a terminal channel for a browser session. Any prior channel for the
   * same session id is closed first (a re-attaching browser gets a fresh PTY).
   */
  openChannel(sessionId: string, session: AgentSession, cols: number, rows: number): void {
    if (this.state !== "ready") {
      session.clientHalf.terminate("Device not online");
      return;
    }
    this.removeChannel(sessionId, "Superseded by a new attachment");
    this.channels.set(sessionId, session);
    this.store.touch(this.deviceId!);
    this.send({
      type: "device_session_open",
      sessionId,
      cols: cols || DEFAULT_TERMINAL_COLS,
      rows: rows || DEFAULT_TERMINAL_ROWS,
    });
  }

  /** Remove a channel and ask the agent to tear down its PTY. Idempotent. */
  removeChannel(sessionId: string, reason?: string): void {
    const existed = this.channels.delete(sessionId);
    if (existed) {
      const paused = [...this.pausedChannels].find((s) => s.id === sessionId);
      if (paused) this.pausedChannels.delete(paused);
      this.store.touch(this.deviceId!);
      this.send({ type: "device_session_close", sessionId, reason });
    }
  }

  /** Whether a channel for the session id is currently held. */
  hasChannel(sessionId: string): boolean {
    return this.channels.has(sessionId);
  }

  // ── Relay → agent sends with bounded pressure ────────────────────────────

  /**
   * Send a post-auth message to the agent. Returns false when the agent's
   * socket write queue is above the high-water mark (callers buffer).
   */
  send(msg: DeviceServerMessage): boolean {
    if (this.state !== "ready" || !this.wsOpen()) return false;
    const payload = JSON.stringify(msg);
    const size = Buffer.byteLength(payload, "utf-8");
    if (this.ws.bufferedAmount + size > this.options.sendHighWaterMark) {
      return false;
    }
    this.ws.send(payload);
    return true;
  }

  /** Track a channel that buffered browser input while the link is pressured. */
  notePaused(session: AgentSession): void {
    this.pausedChannels.add(session);
    this.ensureDrainer();
  }

  private ensureDrainer(): void {
    if (this.drainTimer) return;
    this.drainTimer = setInterval(() => {
      if (this.state !== "ready" || !this.wsOpen()) {
        this.stopDrainer();
        return;
      }
      if (this.ws.bufferedAmount > this.options.sendLowWaterMark) return;
      for (const session of [...this.pausedChannels]) {
        session.flushInput();
        if (!session.hasPausedInput()) this.pausedChannels.delete(session);
      }
      if (this.pausedChannels.size === 0) this.stopDrainer();
    }, 50);
    this.drainTimer.unref?.();
  }

  private stopDrainer(): void {
    if (this.drainTimer) {
      clearInterval(this.drainTimer);
      this.drainTimer = null;
    }
  }

  /** Agent streamed output for a channel; forward toward the browser. */
  private deliverOutput(sessionId: string, base64: string): void {
    this.store.touch(this.deviceId!);
    this.channels.get(sessionId)?.deliverOutput(base64);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  private restartAuthTimer(): void {
    if (this.authTimer) clearTimeout(this.authTimer);
    this.authTimer = setTimeout(() => {
      this.fail("Authentication timed out");
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

  /** Graceful close, or a detected protocol/connection failure. */
  terminate(reason?: string): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.clearAuthTimer();
    this.clearIdleTimer();
    this.stopDrainer();
    this.logger.info("device_link_terminate", {
      connection: this.connectionId,
      device: this.deviceId,
      reason: reason ?? "unspecified",
    });
    if (this.wsOpen()) {
      try {
        this.rawSend({ type: "goodbye", reason });
      } catch {
        /* socket may already be gone */
      }
    }
    this.teardown(reason ?? "closed by relay");
  }

  private onSocketClose(): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.clearAuthTimer();
    this.clearIdleTimer();
    this.stopDrainer();
    this.teardown("Device connection closed");
  }

  private teardown(reason: string): void {
    this.pausedChannels.clear();
    for (const session of [...this.channels.values()]) {
      session.onLinkGone(reason);
    }
    this.channels.clear();
    this.store.setOffline(this.connectionId);
    this.options.onClose(this);
  }

  private rawSend(msg: DeviceServerMessage): void {
    if (this.wsOpen()) this.ws.send(JSON.stringify(msg));
  }

  private wsOpen(): boolean {
    return this.ws.readyState === 1;
  }

  /** The device id once authenticated. */
  get id(): string | undefined {
    return this.deviceId;
  }
}
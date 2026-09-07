import WebSocket from "ws";
import {
  DEVICE_WS_PATH,
  DEVICE_PROTOCOL_VERSION,
  type DeviceClientMessage,
  type DeviceServerMessage,
  isDeviceServerMessage,
  parseJsonDeviceMessage,
} from "../../shared/device/protocol.js";
import type { AgentConfig } from "./config.js";

export interface RelayClientLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export type RelayClientState = "closed" | "connecting" | "auth" | "ready";

export interface RelayClientOptions {
  config: AgentConfig;
  secret: string;
  logger: RelayClientLogger;
  /** Called for every validated relay server message except handshake/ping/pong/goodbye. */
  onServerMessage: (msg: DeviceServerMessage) => void;
  /** Called on every connection-state transition (observability/tests). */
  onStateChange?: (state: RelayClientState) => void;
  /** Called with an error string when the connection fails permanently. */
  onFatal?: (reason: string) => void;
}

/**
 * The agent's outbound, persistent connection to the relay's `/device` path.
 *
 * Responsibilities:
 *  - enroll when the relay reports the device as unknown (`device_register`),
 *    otherwise authenticate (`device_auth`) — device identity comes from the
 *    agent's own credentials file;
 *  - heartbeat with `ping` while `ready` so the relay keeps `lastSeen` fresh;
 *  - automatically reconnect on any drop, with bounded exponential backoff +
 *    jitter (backoff resets only after a successful auth);
 *  - never reconnect after a relay-declared failure (bad secret, unknown id,
 *    refused enrollment) or after a local graceful shutdown.
 */
export class RelayClient {
  private ws: WebSocket | null = null;
  private stage: "closed" | "auth" | "register" | "ready" = "closed";
  private secret: string;
  private stopRequested = false;
  private permanent: string | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private authTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private drainTimer: NodeJS.Timeout | null = null;
  private pendingSend: DeviceClientMessage[] = [];
  private pendingSendBytes = 0;

  constructor(private options: RelayClientOptions) {
    this.secret = options.secret;
  }

  /** Start the first connection attempt (and all subsequent reconnects). */
  start(): void {
    this.stopRequested = false;
    this.connect();
  }

  /**
   * Gracefully shut down: stop reconnecting, send a goodbye if the socket is
   * live, tear down timers, close the socket.
   */
  stop(): void {
    if (this.stopRequested) return;
    this.stopRequested = true;
    this.clearTimers();
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: "goodbye", reason: "Agent shutting down" }));
      } catch {
        /* socket may be gone */
      }
    }
    this.stage = "closed";
    this.pendingSend = [];
    this.pendingSendBytes = 0;
    if (ws) {
      ws.removeAllListeners();
      try {
        ws.close(1000, "agent stop");
      } catch {
        /* already closed */
      }
      this.ws = null;
    }
    this.setState("closed");
  }

  /** Whether the device has authenticated and is accepting sessions. */
  get ready(): boolean {
    return this.stage === "ready";
  }

  /**
   * Send a device message to the relay once ready. Obey the socket's outgoing
   * backpressure: when `bufferedAmount` is above the high-water mark the
   * message is queued and flushed by a drain poller.
   */
  send(msg: DeviceClientMessage): void {
    if (this.stage !== "ready") return;
    const payload = JSON.stringify(msg);
    const size = Buffer.byteLength(payload, "utf-8");
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      this.stage = "closed";
      this.scheduleReconnect("Socket closed while sending");
      return;
    }
    if (ws.bufferedAmount + size > this.options.config.sendHighWaterMark) {
      this.pendingSend.push(msg);
      this.pendingSendBytes += size;
      this.ensureDrainer();
      return;
    }
    ws.send(payload);
  }

  // ── Connection lifecycle ──────────────────────────────────────────────────

  private connect(): void {
    if (this.stopRequested || this.permanent !== null) return;
    this.setState("connecting");
    try {
      this.ws = new WebSocket(
        this.options.config.relayUrl + DEVICE_WS_PATH,
        {
          rejectUnauthorized: true,
          perMessageDeflate: false,
        },
      );
    } catch (err) {
      this.scheduleReconnect(`WebSocket creation failed: ${messageOf(err)}`);
      return;
    }
    const ws = this.ws;
    this.stage = "auth";
    this.restartAuthTimer();
    this.restartIdleTimer();

    ws.on("open", () => {
      this.setState("auth");
      // First message is always an auth attempt; if the relay has never seen
      // this device it answers device_err("Device not enrolled") and we
      // enroll instead.
      this.rawSend({
        type: "device_auth",
        version: DEVICE_PROTOCOL_VERSION,
        deviceId: this.options.config.deviceId,
        secret: this.secret,
      });
    });
    ws.on("message", (data, isBinary) => this.onMessage(data, isBinary));
    ws.on("close", (code) => {
      this.handleSocketClose(code);
    });
    ws.on("error", (err) => {
      this.logger.warn("agent_ws_error", { error: err.message });
      if (!this.permanent) {
        try {
          ws.close();
        } catch {
          /* socket already gone */
        }
      }
    });
  }

  private handleSocketClose(_code: number): void {
    if (this.ws === null) return; // shutdown path already cleared it
    this.ws = null;
    this.clearTimers();
    if (this.stopRequested || this.permanent !== null) return;
    this.scheduleReconnect("Connection closed by peer");
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopRequested || this.permanent !== null || this.reconnectTimer) return;
    this.reconnectAttempts++;
    this.logger.info("agent_reconnect_scheduling", { reason, attempt: this.reconnectAttempts });
    const cfg = this.options.config;
    const base = Math.min(
      cfg.reconnectMaxMs,
      cfg.reconnectMinMs * Math.pow(cfg.reconnectFactor, this.reconnectAttempts),
    );
    const jitter = 0.8 + Math.random() * 0.4; // ±20%
    const delay = Math.max(50, Math.round(base * jitter));
    this.setState("closed");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private onFatal(reason: string): void {
    if (this.permanent !== null) return;
    this.permanent = reason;
    this.clearTimers();
    this.logger.error("agent_permanent_failure", { reason });
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
    this.ws = null;
    this.stage = "closed";
    this.setState("closed");
    this.options.onFatal?.(reason);
  }

  // ── Message handling ──────────────────────────────────────────────────────

  private onMessage(data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean): void {
    if (isBinary) {
      this.onFatal("Binary frames are not part of the device protocol");
      return;
    }
    this.restartIdleTimer();
    let msg: unknown;
    try {
      msg = parseJsonDeviceMessage(data.toString("utf-8"));
    } catch (err) {
      this.onFatal(`Relay protocol error: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (!isDeviceServerMessage(msg as DeviceServerMessage)) {
      this.onFatal(`Unexpected relay message type "${(msg as { type: string }).type}"`);
      return;
    }
    this.handleServerMessage(msg as DeviceServerMessage);
  }

  private handleServerMessage(msg: DeviceServerMessage): void {
    switch (msg.type) {
      case "device_ok":
        if (this.stage === "auth" || this.stage === "register") {
          this.clearAuthWindow();
          this.reconnectAttempts = 0;
          this.stage = "ready";
          this.restartIdleTimer();
          this.startPing();
          this.logger.info("agent_ready", {
            deviceId: msg.deviceId,
            state: msg.state,
          });
          this.setState("ready");
        }
        break;
      case "device_err":
        this.handleDeviceErr(msg.error);
        break;
      case "pong":
        break;
      case "goodbye":
        this.logger.warn("agent_goodbye_from_relay", { reason: msg.reason });
        this.stopRequested = true;
        this.clearTimers();
        this.ws?.close(1000, "relay goodbye");
        this.ws = null;
        this.stage = "closed";
        this.setState("closed");
        break;
      default:
        this.options.onServerMessage(msg);
    }
  }

  private handleDeviceErr(error: string): void {
    if (this.stage === "register") {
      // Enrollment refused (unknown id, bad token, already registered).
      this.onFatal(`Enrollment refused by relay: ${error}`);
      return;
    }
    if (this.stage !== "auth") return;
    if (error === "Device not enrolled") {
      this.stage = "register";
      this.rawSend({
        type: "device_register",
        version: DEVICE_PROTOCOL_VERSION,
        deviceId: this.options.config.deviceId,
        secret: this.secret,
        ...(this.options.config.enrollmentToken
          ? { enrollmentToken: this.options.config.enrollmentToken }
          : {}),
      });
      return;
    }
    // Every other auth failure (invalid secret, unknown id, rate limited,
    // locked out) is permanent: retrying cannot help.
    this.onFatal(`Authentication failed: ${error}`);
  }

  // ── Timers ────────────────────────────────────────────────────────────────

  private restartAuthTimer(): void {
    if (this.authTimer) clearTimeout(this.authTimer);
    this.authTimer = setTimeout(() => {
      this.handleAuthTimeout();
    }, this.options.config.authTimeoutMs);
    this.authTimer.unref?.();
  }

  private handleAuthTimeout(): void {
    if (this.stage === "ready") return;
    this.logger.warn("agent_auth_timeout", { deviceId: this.options.config.deviceId });
    this.forceReconnect("Authentication timed out");
  }

  private restartIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.stage === "ready" || this.stage === "auth" || this.stage === "register") {
        this.logger.warn("agent_idle_timeout", { stage: this.stage });
        this.forceReconnect("Idle timeout");
      }
    }, this.options.config.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  private startPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (this.stage === "ready") this.rawSend({ type: "ping" });
    }, this.options.config.pingIntervalMs);
    this.pingTimer.unref?.();
  }

  private clearAuthWindow(): void {
    if (this.authTimer) clearTimeout(this.authTimer);
    this.authTimer = null;
  }

  private clearTimers(): void {
    if (this.authTimer) clearTimeout(this.authTimer);
    this.authTimer = null;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.stopDrainer();
    this.drainTimer = null;
  }

  private forceReconnect(reason: string): void {
    try {
      this.ws?.close(4001, reason);
    } catch {
      /* socket gone */
    }
  }

  /** Raw, unconditional send used for handshake/heartbeat frames. */
  private rawSend(msg: DeviceClientMessage): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(msg));
  }

  // ── Outgoing backpressure ─────────────────────────────────────────────────

  private ensureDrainer(): void {
    if (this.drainTimer) return;
    this.drainTimer = setInterval(() => {
      const ws = this.ws;
      if (this.stage !== "ready" || !ws || ws.readyState !== WebSocket.OPEN) {
        this.stopDrainer();
        return;
      }
      if (ws.bufferedAmount > this.options.config.sendLowWaterMark) return;
      while (this.pendingSend.length > 0) {
        const msg = this.pendingSend[0];
        const payload = JSON.stringify(msg);
        if (ws.bufferedAmount + Buffer.byteLength(payload, "utf-8") > this.options.config.sendLowWaterMark) {
          break;
        }
        this.pendingSend.shift();
        ws.send(payload);
      }
      if (this.pendingSend.length === 0) this.stopDrainer();
    }, 25);
    this.drainTimer.unref?.();
  }

  private stopDrainer(): void {
    if (this.drainTimer) {
      clearInterval(this.drainTimer);
      this.drainTimer = null;
    }
  }

  // ── Misc ──────────────────────────────────────────────────────────────────

  private setState(state: RelayClientState): void {
    this.options.onStateChange?.(state);
  }

  private get logger(): RelayClientLogger {
    return this.options.logger;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
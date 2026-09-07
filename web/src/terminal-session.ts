/**
 * Per-tab terminal session model. DOM-free on purpose so the reconnect /
 * disconnect / backend-error state machine is unit-testable without a browser
 * harness (there is no jsdom in this project).
 *
 * A session owns a {@link WebTransport}-compatible handle opened against the
 * relay's `/ws?device=…&type=…&session=…` endpoint. State transitions mirror
 * the relay's GUI-session lifecycle (creating → connecting → connected →
 * disconnected → reconnecting → closed).
 */

import { Emitter } from "./state.js";
import type { ApiError, ApiClient, DeviceType } from "./api.js";
import type { WebTransportEvent } from "./transport.js";

export type SessionUiState =
  | "creating"
  | "connecting"
  | "connected"
  | "disconnected"
  | "reconnecting"
  | "closed";

export interface TransportHandle {
  sendTerminalInput(bytes: Uint8Array): boolean;
  sendTerminalResize(cols: number, rows: number): boolean;
  sendPing(): boolean;
  close(): void;
  destroy(): void;
  get isReady(): boolean;
  get state(): string;
}

/** Factory that returns a transport handle given a connect path + token. */
export type TransportFactory = (opts: {
  path: string;
  token: string;
  onEvent: (event: WebTransportEvent) => void;
}) => TransportHandle;

export interface SessionEvents {
  state: SessionUiState;
  output: { bytes: Uint8Array; text: string };
  latency: number | null;
  notice: string;
}

export type SessionError = ApiError;

export interface TerminalSessionOptions {
  api: ApiClient;
  transportFactory: TransportFactory;
  /** Ping interval for status-bar RTT (defaults to 5000ms). */
  pingIntervalMs?: number;
}

export interface TerminalSessionListOptions {
  /** Reload the session list from the server after a state change. */
  onStateChanged?: (session: TerminalSession) => void;
}

export class TerminalSession {
  events = new Emitter<SessionEvents>();

  id: string;
  deviceId: string;
  deviceName: string;
  type: DeviceType;
  state: SessionUiState = "creating";
  /** Human-readable last status/reason (e.g. backend error, close reason). */
  reason: string | null = null;
  latencyMs: number | null = null;
  createdAt: number;

  private api: ApiClient;
  private transportFactory: TransportFactory;
  private transport: TransportHandle | null = null;
  private connectPath: string | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private lastPingAt = 0;
  private closed = false;

  constructor(options: TerminalSessionOptions, init: {
    id: string;
    deviceId: string;
    deviceName: string;
    type: DeviceType;
    createdAt?: number;
    connectPath?: string;
  }) {
    this.api = options.api;
    this.transportFactory = options.transportFactory;
    this.pingInterval ??= null;
    this.id = init.id;
    this.deviceId = init.deviceId;
    this.deviceName = init.deviceName;
    this.type = init.type;
    this.createdAt = init.createdAt ?? Date.now();
    this._pingMs = options.pingIntervalMs ?? 5000;
    this.connectPath = init.connectPath ?? this.derivePath();
  }

  private _pingMs: number;

  /** Reconstruct the relay connect path for this session id. */
  private derivePath(): string {
    return `/ws?device=${encodeURIComponent(this.deviceId)}&type=${encodeURIComponent(this.type)}&session=${encodeURIComponent(this.id)}`;
  }

  /**
   * Provision a new GUI session client-side: call the relay, remember the
   * connect path, and (unless opened with `open()` false) connect immediately.
   */
  async create(opts?: { autoOpen?: boolean; onStateChanged?: () => void }): Promise<void> {
    this.onStateChanged = opts?.onStateChanged ?? null;
    const result = await this.api.createSession(this.deviceId, this.type);
    this.id = result.session.id;
    this.connectPath = result.connect.path ?? this.derivePath();
    this.state = "connecting";
    this.events.emit("state", this.state);
    this.onStateChanged?.();
    if (opts?.autoOpen ?? true) this.open();
  }

  private onStateChanged: (() => void) | null = null;

  /** Connect (or reconnect) the WebSocket to the relay. */
  open(): void {
    if (!this.connectPath || this.closed) return;
    if (this.state === "connected") return;
    // Dropping an in-flight transport prevents duplicate sockets when the
    // user forces a reconnect while WebTransport is still retrying.
    if (this.transport) {
      try {
        this.transport.destroy();
      } catch {
        /* ignore */
      }
      this.transport = null;
    }
    this.setReconnecting(false);
    this.transport = this.transportFactory({
      path: this.connectPath,
      token: this.api.token ?? "",
      onEvent: (event) => this.onTransportEvent(event),
    });
  }

  /** Manually resume a disconnected session by re-attaching the same id. */
  reconnect(): void {
    if (this.closed || !this.connectPath) return;
    this.open();
  }

  /** Close this tab for good (user closes the tab, or server goodbye). */
  close(reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.stopPing();
    try {
      this.transport?.close();
    } catch {
      /* ignore */
    }
    this.transport = null;
    this.transition("closed", reason ?? "Closed by user", false);
  }

  /** Send raw input bytes to the terminal. */
  sendInput(bytes: Uint8Array): void {
    this.transport?.sendTerminalInput(bytes);
  }

  /** Send a terminal resize. Returns false when not connected. */
  resize(cols: number, rows: number): boolean {
    return this.transport?.sendTerminalResize(cols, rows) ?? false;
  }

  get available(): boolean {
    return !this.closed && this.state !== "closed";
  }

  private setReconnecting(reconnecting: boolean): void {
    this.transition(reconnecting ? "reconnecting" : "connecting", null);
  }

  private transition(next: SessionUiState, why: string | null = null, emitState = true): void {
    const previous = this.state;
    if (next === previous) return;
    this.state = next;
    if (why !== null) this.reason = why;
    if (emitState) this.events.emit("state", this.state);
    this.onStateChanged?.();
    void previous;
  }

  private onTransportEvent(event: WebTransportEvent): void {
    if (this.closed && event.type !== "goodbye") return;
    switch (event.type) {
      case "connecting":
        if (event.attempt > 0) this.transition("reconnecting", null);
        else this.transition("connecting", null);
        break;
      case "ready":
        this.transition("connected", null);
        this.startPing();
        break;
      case "auth_failed":
        this.transition("disconnected", "Authentication failed: " + event.reason, false);
        this.reason = "Authentication failed: " + event.reason;
        this.events.emit("state", this.state);
        this.events.emit("notice", this.reason);
        this.stopPing();
        break;
      case "data":
        this.events.emit("output", { bytes: new Uint8Array(0), text: event.payload });
        break;
      case "binary":
        this.events.emit("output", { bytes: new Uint8Array(event.payload), text: "" });
        break;
      case "terminal_output":
        this.events.emit("output", { bytes: new Uint8Array(event.payload), text: "" });
        break;
      case "pong":
        if (this.lastPingAt > 0) {
          this.latencyMs = Date.now() - this.lastPingAt;
        } else {
          this.latencyMs = 0;
        }
        this.events.emit("latency", this.latencyMs);
        break;
      case "goodbye":
        this.transition("closed", event.reason ?? "Closed by relay", false);
        this.reason = event.reason ?? "Closed by relay";
        this.events.emit("state", this.state);
        this.events.emit("notice", this.reason);
        this.stopPing();
        this.closed = true;
        break;
      case "closed":
        if (this.state === "connected" || this.state === "reconnecting" || this.state === "connecting") {
          this.transition("disconnected", event.reason ?? "Disconnected");
        }
        this.stopPing();
        break;
      case "reconnect_failed":
        this.transition("disconnected", "Connection lost", false);
        this.reason = "Connection lost";
        this.events.emit("state", this.state);
        this.events.emit("notice", this.reason);
        this.stopPing();
        break;
      case "error":
        this.events.emit("notice", event.message);
        break;
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingInterval = setInterval(() => {
      this.lastPingAt = Date.now();
      this.transport?.sendPing();
    }, this._pingMs);
  }

  private stopPing(): void {
    if (this.pingInterval !== null) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.state === "disconnected" || this.state === "closed") {
      this.latencyMs = null;
    }
  }
}
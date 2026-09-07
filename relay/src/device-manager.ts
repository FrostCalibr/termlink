import type { WebSocket } from "ws";
import type { DeviceStore, AgentDeviceInfo } from "./device-store.js";
import type { TargetType } from "./config.js";
import { AgentLink } from "./agent-link.js";
import { AgentSession } from "./agent-session.js";
import type { WebSocketClientHalf } from "./ws-client-half.js";
import type { RelayLogger } from "./relay.js";
import type { AuthRateLimiter } from "../../server/src/rate-limit.js";

export interface DeviceManagerOptions {
  store: DeviceStore;
  logger: RelayLogger;
  authRateLimiter?: AuthRateLimiter | null;
  maxAuthAttempts: number;
  authBackoffMs: number;
  authTimeoutMs: number;
  idleTimeoutMs: number;
  sendHighWaterMark: number;
  sendLowWaterMark: number;
}

/**
 * Owns the relay's side of Phase 9 device agents: the enrollment registry
 * ({@link DeviceStore}) and the live {@link AgentLink}s. Browser sessions
 * bound to an agent device are routed through the device's persistent link
 * instead of a static-TCP RelaySession; the link multiplexes one terminal
 * channel per GUI session.
 */
export class DeviceManager {
  readonly store: DeviceStore;
  private logger: RelayLogger;
  private authRateLimiter: AuthRateLimiter | null;
  private maxAuthAttempts: number;
  private authBackoffMs: number;
  private authTimeoutMs: number;
  private idleTimeoutMs: number;
  private sendHighWaterMark: number;
  private sendLowWaterMark: number;
  private linksAll = new Set<AgentLink>();
  private linksByDevice = new Map<string, AgentLink>();

  constructor(options: DeviceManagerOptions) {
    this.store = options.store;
    this.logger = options.logger;
    this.authRateLimiter = options.authRateLimiter ?? null;
    this.maxAuthAttempts = options.maxAuthAttempts;
    this.authBackoffMs = options.authBackoffMs;
    this.authTimeoutMs = options.authTimeoutMs;
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.sendHighWaterMark = options.sendHighWaterMark;
    this.sendLowWaterMark = options.sendLowWaterMark;
  }

  /** Handle a WebSocket upgraded on the agent device path. */
  handleConnection(ws: WebSocket, remoteAddress: string | undefined): AgentLink {
    const link = new AgentLink({
      ws,
      remoteAddress,
      store: this.store,
      logger: this.logger,
      authRateLimiter: this.authRateLimiter,
      maxAuthAttempts: this.maxAuthAttempts,
      authBackoffMs: this.authBackoffMs,
      authTimeoutMs: this.authTimeoutMs,
      idleTimeoutMs: this.idleTimeoutMs,
      sendHighWaterMark: this.sendHighWaterMark,
      sendLowWaterMark: this.sendLowWaterMark,
      onReady: (l, deviceId) => this.onLinkReady(l, deviceId),
      onClose: (l) => this.onLinkClosed(l),
    });
    this.linksAll.add(link);
    link.start();
    return link;
  }

  private onLinkReady(link: AgentLink, deviceId: string): void {
    const previous = this.linksByDevice.get(deviceId);
    if (previous && previous !== link) {
      previous.terminate("Superseded by a newer device connection");
    }
    this.linksByDevice.set(deviceId, link);
    this.logger.info("device_online", {
      device: deviceId,
      connection: link.connectionId,
    });
  }

  private onLinkClosed(link: AgentLink): void {
    this.linksAll.delete(link);
    if (link.id && this.linksByDevice.get(link.id) === link) {
      this.linksByDevice.delete(link.id);
    }
    this.logger.info("device_offline", {
      device: link.id,
      connection: link.connectionId,
    });
  }

  // ── Browser session routing ──────────────────────────────────────────────

  /**
   * Route an authenticated browser half to an agent device. Called by the
   * relay in place of `startRelaySession` when the requested device is an
   * agent-managed device. Requires a GUI session id; device credentials are
   * never involved in the browser path.
   */
  attachBrowserHalf(half: WebSocketClientHalf): void {
    const deviceId = half.deviceId;
    const sessionId = half.guiSessionId;
    if (!deviceId || !this.store.has(deviceId)) {
      half.terminate("Unknown device");
      return;
    }
    if (!sessionId) {
      half.terminate("Agent device sessions require a session id");
      return;
    }
    const link = this.linksByDevice.get(deviceId);
    if (!link) {
      half.terminate("Device offline");
      return;
    }
    const session = new AgentSession(link, half, sessionId, this.logger);
    half.attachBridge(session);
    session.attach();
  }

  /** Close a GUI session's channel on whichever device hosts it. */
  closeGuiSession(sessionId: string, reason: string): void {
    for (const link of this.linksAll) {
      if (link.hasChannel(sessionId)) {
        link.removeChannel(sessionId, reason);
        return;
      }
    }
  }

  /** Browser-safe device list for the API (id/name/type/online only). */
  listDevices(): AgentDeviceInfo[] {
    return this.store.list();
  }

  /** Whether `id` is a configured agent device. */
  has(id: string | undefined): boolean {
    return id !== undefined && this.store.has(id);
  }

  /** Whether the device's agent link is live. */
  online(id: string): boolean {
    return this.store.online(id);
  }

  /** Display name of a configured agent device. */
  name(id: string): string {
    return this.store.config(id)?.name ?? id;
  }

  /** Backend session type offered by the agent device. */
  type(id: string): TargetType {
    return this.store.config(id)?.type ?? "shell";
  }

  /** Terminate every link (relay shutdown). */
  close(): void {
    this.linksByDevice.clear();
    for (const link of [...this.linksAll]) {
      link.terminate("Relay shutting down");
    }
    this.linksAll.clear();
  }
}
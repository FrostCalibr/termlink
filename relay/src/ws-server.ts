import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import type { Socket as NetSocket } from "node:net";
import type { Duplex } from "node:stream";
import {
  WebSocketServer as WsServer,
  type WebSocket,
} from "ws";
import { CredentialStore } from "../../server/src/auth.js";
import type { SessionRegistry } from "../../server/src/sessions.js";
import type { AuthRateLimiter } from "../../server/src/rate-limit.js";
import { normalizeOrigin, type Target, type WebSocketConfig } from "./config.js";
import { WebSocketClientHalf } from "./ws-client-half.js";
import type { RelayLogger } from "./relay.js";
import { API_PREFIX, type ApiServer } from "./api.js";
import { DEVICE_WS_PATH } from "../../shared/device/protocol.js";
import type { DeviceManager } from "./device-manager.js";

export const WS_PATH = "/ws";
export const HEALTH_PATH = "/healthz";

export interface WebSocketFrontDoorCallbacks {
  /** The client authenticated; start a relay session and attach it. */
  onAuthenticated: (half: WebSocketClientHalf) => void;
  /** The client half fully closed; perform any relay-level cleanup bookkeeping. */
  onHalfClose: (half: WebSocketClientHalf) => void;
}

export interface WebSocketFrontDoorOptions {
  config: WebSocketConfig;
  auth: CredentialStore;
  sessions: SessionRegistry;
  /** Relay-level auth throttling settings (shared with the TCP front door). */
  maxAuthAttempts: number;
  authBackoffMs: number;
  logger: RelayLogger;
  callbacks: WebSocketFrontDoorCallbacks;
  /** Optional shared global + per-IP auth rate limiter (or null to disable). */
  authRateLimiter?: AuthRateLimiter | null;
  /** Static authorized targets, used to route `?device=` WS requests. */
  targets?: Target[];
  /** Optional browser API server mounted under /api (login, devices, sessions). */
  api?: ApiServer;
  /** Optional Phase 9 device-agent manager hosting the `/device` endpoint. */
  devices?: DeviceManager;
}

/**
 * Browser-facing WebSocket front door of the relay. Serves plain WS or WSS
 * (when TLS is configured), plus a health endpoint and optional static web
 * files, so one process can host the relay, the client bundle, and health
 * checks. Operates behind reverse proxies that terminate TLS.
 *
 * Handles the HTTP upgrade path itself (noServer mode) so Origin validation,
 * connection limits, and 403/503 rejections happen before the handshake
 * completes. Each accepted socket becomes a {@link WebSocketClientHalf},
 * which authenticates and, once ready, is bridged to an authorized backend.
 */
export class WebSocketFrontDoor {
  private http: HttpServer;
  private wss: WsServer;
  private halves = new Set<WebSocketClientHalf>();
  private config: WebSocketConfig;
  private logger: RelayLogger;
  private auth: CredentialStore;
  private sessions: SessionRegistry;
  private callbacks: WebSocketFrontDoorCallbacks;
  private maxAuthAttempts: number;
  private authBackoffMs: number;
  private authRateLimiter: AuthRateLimiter | null;
  private targets: Target[];
  private api: ApiServer | null;
  private devices: DeviceManager | null;
  private shuttingDown = false;
  private originWarned = false;

  constructor(options: WebSocketFrontDoorOptions) {
    this.config = options.config;
    this.auth = options.auth;
    this.sessions = options.sessions;
    this.logger = options.logger;
    this.callbacks = options.callbacks;
    this.maxAuthAttempts = options.maxAuthAttempts;
    this.authBackoffMs = options.authBackoffMs;
    this.authRateLimiter = options.authRateLimiter ?? null;
    this.targets = options.targets ?? [];
    this.api = options.api ?? null;
    this.devices = options.devices ?? null;

    this.wss = new WsServer({
      noServer: true,
      maxPayload: this.config.maxMessageSize,
    });

    const requestHandler = (req: IncomingMessage, res: ServerResponse) =>
      this.onHttpRequest(req, res);
    this.http = this.config.tls
      ? createHttpsServer(
          {
            key: this.config.tls.key,
            cert: this.config.tls.cert,
            ...(this.config.tls.ca ? { ca: this.config.tls.ca } : {}),
          },
          requestHandler,
        )
      : createServer(requestHandler);

    this.http.on("upgrade", (req, socket, head) =>
      this.onUpgrade(req, socket, head),
    );
    this.http.on("clientError", (_err, socket) => socket.destroy());
  }

  /**
   * Non-upgrade HTTP requests: a health check and (optionally) the static
   * web client. Everything else stays 404.
   */
  private onHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    const path = (req.url ?? "/").split("?")[0];
    if (path === HEALTH_PATH) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          uptime: Math.round(process.uptime()),
          connections: this.halves.size,
          maxConnections: this.config.maxConnections,
        }),
      );
      return;
    }
    if (path.startsWith(API_PREFIX) && this.api) {
      this.api.handle(req, res);
      return;
    }
    if (this.config.webroot) {
      this.serveStatic(path, res);
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found. WebSocket endpoint: " + WS_PATH);
  }

  /** Serve a file from the static web root, refusing path traversal. */
  private serveStatic(path: string, res: ServerResponse): void {
    const root = resolve(this.config.webroot!);
    const relative = path === "/" ? "/index.html" : path;
    const candidate = normalize(join(root, relative));
    // Guard: the resolved path must stay inside the web root.
    if (!candidate.startsWith(root + sep)) {
      this.writeStatus(res, 403, "Forbidden");
      return;
    }
    let content: Buffer;
    try {
      content = readFileSync(candidate);
    } catch {
      // SPA fallback: extensionless paths fall back to index.html so that
      // client-side routing works on deployment platforms (Render, etc.).
      if (/\.[^/]+$/.test(path)) {
        this.writeStatus(res, 404, "Not found");
        return;
      }
      const fallback = normalize(join(root, "index.html"));
      if (!fallback.startsWith(root + sep)) {
        this.writeStatus(res, 403, "Forbidden");
        return;
      }
      try {
        content = readFileSync(fallback);
      } catch {
        this.writeStatus(res, 404, "Not found");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(content);
      return;
    }
    res.writeHead(200, { "Content-Type": mimeFor(candidate) });
    res.end(content);
  }

  private writeStatus(res: ServerResponse, status: number, text: string): void {
    res.writeHead(status, { "Content-Type": "text/plain" });
    res.end(text);
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(this.config.port, this.config.host, () => {
        this.http.removeListener("error", reject);
        this.logger.info("ws_listening", {
          host: this.config.host,
          port: this.port,
          tls: this.config.tls ? "on" : "off",
          maxConnections: this.config.maxConnections,
          maxMessageSize: this.config.maxMessageSize,
          authTimeoutMs: this.config.authTimeoutMs,
        });
        if (this.config.allowedOrigins.length === 0) {
          this.logger.warn("ws_origin_warning", {
            detail: "WS_ALLOWED_ORIGINS is empty; any Origin is accepted",
          });
        } else {
          this.logger.info("ws_origins", {
            origins: this.config.allowedOrigins,
          });
        }
        resolve();
      });
    });
  }

  /** Terminate a single half by its connection id (e.g. session expiry). */
  terminate(connectionId: string, reason: string): void {
    for (const half of this.halves) {
      if (half.connectionId === connectionId) {
        half.terminate(reason);
        return;
      }
    }
  }

  /**
   * Upgrade a device-agent connection. Agents are non-browser peers, so the
   * Origin allow-list does not apply; instead the device authenticates inside
   * the WebSocket (`device_auth`/`device_register`) against the enrollment
   * registry, with the same auth throttling and session limits.
   */
  private onDeviceUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    if (this.shuttingDown) {
      this.rejectUpgrade(socket, 503, "WebSocket server shutting down");
      return;
    }
    if (!this.devices) {
      this.rejectUpgrade(socket, 404, "No device endpoint configured");
      return;
    }
    if (!this.connectionSlotFree()) {
      this.logger.warn("ws_device_rejected_max", {
        max: this.config.maxConnections,
      });
      this.rejectUpgrade(socket, 503, "Connection limit reached");
      return;
    }
    const remoteAddress = forwardedClientIp(req, socket);
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.devices!.handleConnection(ws, remoteAddress);
      this.logger.info("device_link_open", {
        active: this.halves.size,
      });
    });
  }

  /** Whether a new WebSocket (browser or device) still fits the connection cap. */
  private connectionSlotFree(): boolean {
    return this.halves.size < this.config.maxConnections;
  }

  private onUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    if (this.shuttingDown) {
      this.rejectUpgrade(socket, 503, "WebSocket server shutting down");
      return;
    }
    const url = new URL(req.url ?? "/", "http://relay.local");
    const pathname = url.pathname;
    const params = url.searchParams;
    if (pathname === DEVICE_WS_PATH) {
      this.onDeviceUpgrade(req, socket, head);
      return;
    }
    if (pathname !== WS_PATH) {
      this.rejectUpgrade(socket, 404, "Unknown path; use " + WS_PATH);
      return;
    }
    if (!this.originAllowed(req)) {
      this.logger.warn("ws_origin_rejected", {
        origin: req.headers.origin ?? "(none)",
      });
      this.rejectUpgrade(socket, 403, "Origin not allowed");
      return;
    }
    if (!this.connectionSlotFree()) {
      this.logger.warn("ws_connection_rejected_max", {
        max: this.config.maxConnections,
      });
      this.rejectUpgrade(socket, 503, "Connection limit reached");
      return;
    }

    const deviceId = params.get("device") ?? undefined;
    const sessionType = params.get("type") ?? undefined;
    const guiSessionId = params.get("session") ?? undefined;

    // Device/type selection is validated against the static target config so
    // the front door can never be used as an open proxy.
    const targetError = this.validateDeviceRequest(deviceId, sessionType);
    if (targetError) {
      this.logger.warn("ws_target_rejected", {
        device: deviceId,
        type: sessionType,
        error: targetError,
      });
      this.rejectUpgrade(socket, 404, targetError);
      return;
    }
    if (guiSessionId !== undefined && !this.api?.isOpenGuiSession(guiSessionId)) {
      this.logger.warn("ws_session_rejected", { session: guiSessionId });
      this.rejectUpgrade(socket, 403, "Unknown or closed session");
      return;
    }

    const remoteAddress = forwardedClientIp(req, socket);

    this.wss.handleUpgrade(req, socket, head, (ws) =>
      this.onConnection(ws, remoteAddress, deviceId, sessionType, guiSessionId),
    );
  }

  /** Validate a `?device=`/`?type=` request against configured targets/devices. */
  private validateDeviceRequest(
    deviceId: string | undefined,
    sessionType: string | undefined,
  ): string | null {
    if (deviceId === undefined) {
      // No device selection: fall back to the default target (backward
      // compatible with the pre-GUI single-target relay).
      if (sessionType !== undefined) return "type requires a device";
      return null;
    }
    const target = this.targets.find((t) => t.id === deviceId);
    if (this.devices?.has(deviceId)) {
      const offered = this.devices.type(deviceId);
      if (sessionType !== undefined) {
        if (sessionType !== "shell" && sessionType !== "ssh" && sessionType !== "android") {
          return "Invalid session type";
        }
        if (sessionType !== offered) return "Session type not offered by this device";
      }
      return null;
    }
    if (!target) return "Unknown device";
    const offered = target.type ?? "shell";
    if (sessionType !== undefined) {
      if (sessionType !== "shell" && sessionType !== "ssh") return "Invalid session type";
      if (sessionType !== offered) return "Session type not offered by this device";
    }
    return null;
  }

  private originAllowed(req: IncomingMessage): boolean {
    const allowed = this.config.allowedOrigins;
    if (allowed.length === 0) {
      if (!this.originWarned) {
        this.originWarned = true;
        this.logger.warn("ws_origin_unrestricted", {});
      }
      return true;
    }
    const origin = req.headers.origin;
    if (!origin) {
      this.logger.warn("ws_origin_missing", {});
      return false;
    }
    return allowed.includes(normalizeOrigin(origin));
  }

  private onConnection(
    ws: WebSocket,
    remoteAddress: string | undefined,
    deviceId?: string,
    sessionType?: string,
    guiSessionId?: string,
  ): void {
    const half = new WebSocketClientHalf({
      ws,
      auth: this.auth,
      sessions: this.sessions,
      maxAuthAttempts: this.maxAuthAttempts,
      authBackoffMs: this.authBackoffMs,
      authTimeoutMs: this.config.authTimeoutMs,
      idleTimeoutMs: this.config.idleTimeoutMs,
      sendHighWaterMark: this.config.sendHighWaterMark,
      sendLowWaterMark: this.config.sendLowWaterMark,
      authRateLimiter: this.authRateLimiter,
      verifySessionToken: this.api
        ? (token: string) => this.api!.verifyWsToken(token)
        : undefined,
      guiSessionId,
      deviceId,
      sessionType,
      remoteAddress,
      logger: this.logger,
      onAuthenticated: (h) => this.onAuthenticated(h),
      onClose: (h) => this.onHalfClose(h),
    });
    this.halves.add(half);
    this.logger.info("ws_connection_open", {
      connection: half.connectionId,
      device: deviceId ?? targetLabel(this.targets),
      active: this.halves.size,
    });
    this.api?.attachWsConnection(half);
    half.start();
  }

  private onAuthenticated(half: WebSocketClientHalf): void {
    this.logger.info("ws_authenticated", {
      connection: half.connectionId,
    });
    this.callbacks.onAuthenticated(half);
  }

  private onHalfClose(half: WebSocketClientHalf): void {
    const existed = this.halves.delete(half);
    this.logger.info("ws_connection_close", {
      connection: half.connectionId,
      active: this.halves.size,
    });
    if (existed) this.callbacks.onHalfClose(half);
  }

  get port(): number {
    const addr = this.http.address();
    if (addr && typeof addr === "object") return addr.port;
    return 0;
  }

  get connectionCount(): number {
    return this.halves.size;
  }

  close(): Promise<void> {
    this.shuttingDown = true;
    for (const half of this.halves) {
      half.terminate("WebSocket server shutting down");
    }
    return new Promise((resolve) => {
      this.http.close(() => resolve());
    });
  }

  private rejectUpgrade(socket: Duplex, status: number, reason: string): void {
    socket.write(
      `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
    socket.destroy();
  }
}

/** Guess a Content-Type for static file serving. */
function mimeFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "html":
      return "text/html; charset=utf-8";
    case "js":
      return "application/javascript; charset=utf-8";
    case "css":
      return "text/css; charset=utf-8";
    case "json":
      return "application/json; charset=utf-8";
    case "map":
      return "application/json; charset=utf-8";
    case "png":
      return "image/png";
    case "svg":
      return "image/svg+xml";
    case "ico":
      return "image/x-icon";
    default:
      return "application/octet-stream";
  }
}

/** Describe the default target for log lines when no device was requested. */
function targetLabel(targets: Target[]): string {
  return targets[0]?.id ?? "(none)";
}

/**
 * Resolve the effective client IP for an upgrade request. Honours
 * `X-Forwarded-For` (comma-separated, leftmost entry) as set by
 * L7 proxies/Render, falling back to the direct TCP peer address.
 */
function forwardedClientIp(req: IncomingMessage, socket: Duplex): string | undefined {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return typeof (socket as NetSocket).remoteAddress === "string"
    ? (socket as NetSocket).remoteAddress
    : undefined;
}
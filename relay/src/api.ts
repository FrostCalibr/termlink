import type { IncomingMessage, ServerResponse } from "node:http";
import type { CredentialStore } from "../../server/src/auth.js";
import type { AuthRateLimiter } from "../../server/src/rate-limit.js";
import type { Target, TargetType } from "./config.js";
import { listDevices, probeTarget, withReachability, type DeviceInfo, type ProbeFn } from "./devices.js";
import { HttpSessionStore, SESSION_COOKIE_NAME, type HttpSessionRecord } from "./http-sessions.js";
import { GuiSessionRegistry, type GuiSessionRecord } from "./gui-sessions.js";
import type { WebSocketClientHalf } from "./ws-client-half.js";
import type { RelayLogger } from "./relay.js";
import type { DeviceManager } from "./device-manager.js";
import { TARGET_TYPE_SHELL, TARGET_TYPE_SSH, TARGET_TYPE_ANDROID } from "./config.js";

export const API_PREFIX = "/api/";

const MAX_BODY_BYTES = 16 * 1024;

// Login throttle (always-on safety net, in addition to the configured
// AUTH_RATE_* limiter which operates on the shared AuthRateLimiter).
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 20;
const LOGIN_LOCK_MS = 60 * 1000;

// GUI session sweep defaults.
const SWEEP_INTERVAL_MS = 30 * 1000;
const CREATE_WINDOW_MS = 60 * 1000;
const RECONNECT_GRACE_MS = 60 * 1000;
const PURGE_AGE_MS = 30 * 60 * 1000;

export interface ApiServerOptions {
  auth: CredentialStore;
  targets: Target[];
  httpSessions: HttpSessionStore;
  guiSessions: GuiSessionRegistry;
  authRateLimiter?: AuthRateLimiter | null;
  logger: RelayLogger;
  /** Reachability probe; injectable for tests. */
  probe?: ProbeFn;
  /** Cache reachability results for this long (ms). */
  probeCacheMs?: number;
  /** Terminate a relay connection by connection id (DELETE /api/sessions/:id). */
  terminateConnection?: (connectionId: string, reason: string) => void;
  /** Optional Phase 9 device-agent manager (merges its devices into the API). */
  devices?: DeviceManager;
}

interface LoginThrottleEntry {
  count: number;
  windowStart: number;
  lockedUntil: number;
}

/**
 * Browser-facing HTTP API mounted on the relay's WebSocket front door.
 *
 * The API is deliberately minimal and capability-based: the GUI asks for
 * `createSession(deviceId, type)` and the relay resolves the backend from its
 * own static target configuration. No backend address, credential, or secret
 * is ever exposed to the browser.
 */
export class ApiServer {
  private httpSessions: HttpSessionStore;
  private guiSessions: GuiSessionRegistry;
  private auth: CredentialStore;
  private targets: Target[];
  private logger: RelayLogger;
  private authRateLimiter: AuthRateLimiter | null;
  private probe: ProbeFn;
  private probeCacheMs: number;
  private terminateConnection: (connectionId: string, reason: string) => void;
  private devices: DeviceManager | null;
  private deviceStatus = new Map<
    string,
    { at: number; online: boolean; latencyMs: number | null }
  >();
  private loginThrottle = new Map<string, LoginThrottleEntry>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: ApiServerOptions) {
    this.httpSessions = options.httpSessions;
    this.guiSessions = options.guiSessions;
    this.auth = options.auth;
    this.targets = options.targets;
    this.logger = options.logger;
    this.authRateLimiter = options.authRateLimiter ?? null;
    this.probe = options.probe ?? probeTarget;
    this.probeCacheMs = options.probeCacheMs ?? 3000;
    this.terminateConnection =
      options.terminateConnection ?? (() => undefined);
    this.devices = options.devices ?? null;
  }

  /** Handle an `/api/*` request. Returns false when the path is not handled. */
  handle(req: IncomingMessage, res: ServerResponse): boolean {
    const url = new URL(req.url ?? "/", "http://relay.local");
    const path = url.pathname;
    if (!path.startsWith(API_PREFIX)) return false;

    void this.dispatch(req, res, path).catch(() =>
      sendJson(res, 500, { error: "Internal server error" }),
    );
    return true;
  }

  private async dispatch(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
  ): Promise<void> {
    switch (path) {
      case "/api/auth/login":
        return this.handleLogin(req, res);
      case "/api/auth/session":
        return this.handleSession(req, res);
      case "/api/auth/logout":
        return this.handleLogout(req, res);
      case "/api/devices":
        if (req.method !== "GET") return methodNotAllowed(res, "GET");
        return this.requireAuth(req, res, (user) => this.respondDevices(user, res));
      case "/api/sessions":
        if (req.method !== "GET") return methodNotAllowed(res, "GET");
        return this.requireAuth(req, res, (user) => this.respondSessions(user, res));
      default: {
        const deviceMatch = /^\/api\/devices\/([^/]+)\/sessions$/.exec(path);
        if (deviceMatch && req.method === "POST") {
          return this.requireAuth(req, res, (user) =>
            this.createSession(user, req, res, deviceMatch[1]),
          );
        }
        const sessionMatch = /^\/api\/sessions\/([^/]+)$/.exec(path);
        if (sessionMatch && req.method === "DELETE") {
          return this.requireAuth(req, res, (user) =>
            this.deleteSession(user, res, sessionMatch[1]),
          );
        }
        sendJson(res, 404, { error: "Not found" });
      }
    }
  }

  // ── Auth endpoints ────────────────────────────────────────────────────────

  private async handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      return methodNotAllowed(res, "POST");
    }
    const ip = clientIp(req);
    if (!this.loginAllowed(ip)) {
      return sendJson(res, 429, { error: "Too many login attempts; try again later" });
    }

    const body = await readJsonBody(req);
    if (body === null) {
      return sendJson(res, 400, { error: "Request body must be valid JSON" });
    }

    let ok = false;
    let username = "";
    let method: "token" | "password" = "token";
    if (typeof body.token === "string" && body.token.length > 0) {
      ok = await this.auth.verifyToken(body.token);
      username = "token";
      method = "token";
    } else if (
      typeof body.username === "string" &&
      typeof body.password === "string" &&
      body.username.length > 0
    ) {
      ok = await this.auth.verifyPassword(body.username, body.password);
      username = body.username;
      method = "password";
    } else {
      return sendJson(res, 400, {
        error: 'Provide "token" or "username" + "password"',
      });
    }

    if (!ok) {
      this.recordLoginFailure(ip);
      this.logger.warn("api_login_failed", {
        ip,
        method,
        username: method === "password" ? username : undefined,
      });
      return sendJson(res, 401, { error: "Invalid credentials" });
    }

    // Shared auth rate limiter (when configured via AUTH_RATE_*).
    if (this.authRateLimiter && !this.authRateLimiter.tryAcquire(ip)) {
      return sendJson(res, 429, { error: "Too many login attempts; try again later" });
    }

    const session = this.httpSessions.create(username, method);
    this.logger.info("api_login_ok", {
      ip,
      username: method === "password" ? username : undefined,
      method,
    });
    setSessionCookie(req, res, session.token);
    sendJson(res, 200, {
      user: { name: username, method },
      session: { token: session.token },
    });
  }

  private handleSession(req: IncomingMessage, res: ServerResponse): void {
    const user = this.currentUser(req);
    if (!user) {
      return sendJson(res, 401, { error: "Not authenticated" });
    }
    sendJson(res, 200, {
      user: { name: user.username, method: user.method },
    });
  }

  private handleLogout(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== "POST") return methodNotAllowed(res, "POST");
    const token = bearerToken(req) ?? cookieToken(req);
    if (token) this.httpSessions.delete(token);
    clearSessionCookie(res);
    this.logger.info("api_logout", {});
    sendJson(res, 200, { ok: true });
  }

  // ── Devices / sessions endpoints ──────────────────────────────────────────

  private async respondDevices(_user: HttpSessionRecord, res: ServerResponse): Promise<void> {
    const staticDevices = await this.getDevices();
    const agentDevices = this.devices ? this.devices.listDevices() : [];
    // Agent devices first (they need no reachability probe; online is live).
    sendJson(res, 200, { devices: [...agentDevices, ...staticDevices] });
  }

  private respondSessions(user: HttpSessionRecord, res: ServerResponse): void {
    const sessions = this.guiSessions.listFor(user).map((record) =>
      this.toSessionDto(record),
    );
    sendJson(res, 200, { sessions });
  }

  private async createSession(
    user: HttpSessionRecord,
    req: IncomingMessage,
    res: ServerResponse,
    deviceId: string,
  ): Promise<void> {
    const target = this.targets.find((t) => t.id === deviceId);

    // Phase 9 & 10: agent-managed devices. The device must be online right now —
    // it spawns the terminal shell on the target machine/phone.
    if (!target && this.devices?.has(deviceId)) {
      if (!this.devices.online(deviceId)) {
        return sendJson(res, 409, { error: "Device offline" });
      }
      const body = await readJsonBody(req);
      if (body === null) {
        return sendJson(res, 400, { error: "Request body must be valid JSON" });
      }
      const offeredType = this.devices.type(deviceId);
      const type = this.resolveType(body, offeredType);
      if (!type) {
        return sendJson(res, 400, {
          error: `Unsupported session type; device "${deviceId}" offers ${offeredType}`,
        });
      }
      const record = this.guiSessions.create(user.username, deviceId, type);
      this.logger.info("gui_session_created", {
        session: record.id,
        user: user.username,
        device: deviceId,
        type,
        backend: "agent",
      });
      const query = new URLSearchParams({ device: deviceId, type, session: record.id });
      return sendJson(res, 201, {
        session: this.toSessionDto(record),
        connect: { path: `/ws?${query.toString()}` },
      });
    }

    if (!target) {
      return sendJson(res, 404, { error: "Unknown device" });
    }
    const body = await readJsonBody(req);
    if (body === null) {
      return sendJson(res, 400, { error: "Request body must be valid JSON" });
    }
    const type = this.resolveType(body, target.type ?? "shell");
    if (!type) {
      return sendJson(res, 400, {
        error: `Unsupported session type; device "${target.id}" offers ${target.type ?? "shell"}`,
      });
    }
    const record = this.guiSessions.create(user.username, target.id, type);
    this.logger.info("gui_session_created", {
      session: record.id,
      user: user.username,
      device: target.id,
      type,
    });
    const query = new URLSearchParams({
      device: target.id,
      type,
      session: record.id,
    });
    sendJson(res, 201, {
      session: this.toSessionDto(record),
      connect: { path: `/ws?${query.toString()}` },
    });
  }

  private async deleteSession(
    user: HttpSessionRecord,
    res: ServerResponse,
    sessionId: string,
  ): Promise<void> {
    const record = this.guiSessions.get(sessionId);
    if (!record || record.username !== user.username) {
      return sendJson(res, 404, { error: "Unknown session" });
    }
    if (record.connectionId) {
      this.terminateConnection(record.connectionId, "Session closed");
      this.logger.info("gui_session_terminated", { session: sessionId });
    }
    // Agent devices: a disconnected/reconnecting session still holds its
    // channel id; ask the device to kill the PTY even without a live client.
    if (this.devices) {
      this.devices.closeGuiSession(sessionId, "Closed by user");
    }
    this.guiSessions.close(sessionId, "Closed by user");
    sendJson(res, 200, { ok: true, session: this.toSessionDto(record) });
  }

  // ── WS lifecycle hooks (called by the relay on behalf of the front door) ──

  /** Whether a GUI session id may still attach a WebSocket connection. */
  isOpenGuiSession(id: string): boolean {
    const record = this.guiSessions.get(id);
    return record !== undefined && record.state !== "closed";
  }

  /**
   * Verify a WebSocket auth token against the web session store. Returns the
   * authenticated username, or null when it is not a web session token.
   */
  async verifyWsToken(token: string): Promise<string | null> {
    const session = this.httpSessions.verify(token);
    return session ? session.username : null;
  }

  /** Called right after the WS half is constructed, before auth. */
  attachWsConnection(half: WebSocketClientHalf): void {
    const id = half.guiSessionId;
    if (!id) return;
    const record = this.guiSessions.get(id);
    if (!record || record.state === "closed") {
      half.terminate("Unknown or closed session");
      return;
    }
    this.guiSessions.attach(id, half.connectionId);
  }

  /** After an authenticated WS: link the GUI session record to the half. */
  onWsAuthenticated(half: WebSocketClientHalf): void {
    const id = half.guiSessionId;
    if (!id) return;
    const record = this.guiSessions.get(id);
    if (!record) {
      half.terminate("Unknown session");
      return;
    }
    if (half.authenticatedIdentity !== null && record.username !== half.authenticatedIdentity) {
      half.terminate("Session does not belong to this user");
      return;
    }
    this.guiSessions.markConnected(id, half.connectionId);
  }

  /** After a WS closes: detach the GUI session (kept reattachable). */
  onWsHalfClose(half: WebSocketClientHalf): void {
    if (!half.guiSessionId) return;
    this.guiSessions.markDisconnected(
      half.connectionId,
      half.lastTerminateReason ?? "Connection closed",
    );
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async getDevices(): Promise<DeviceInfo[]> {
    const devices = listDevices(this.targets);
    const now = Date.now();
    const stale = devices.filter((d) => {
      const cached = this.deviceStatus.get(d.id);
      return !cached || now - cached.at >= this.probeCacheMs;
    });
    if (stale.length > 0) {
      const fresh = await withReachability(stale, this.probe, this.targets);
      for (const f of fresh) {
        this.deviceStatus.set(f.id, {
          at: now,
          online: f.online,
          latencyMs: f.latencyMs,
        });
      }
    }
    return devices.map((d) => {
      const cached = this.deviceStatus.get(d.id);
      return cached ? { ...d, online: cached.online, latencyMs: cached.latencyMs } : d;
    });
  }

  private resolveType(body: Record<string, unknown>, offered: TargetType): TargetType | null {
    const type = typeof body.type === "string" ? body.type : undefined;
    if (!type) return offered;
    if (type !== TARGET_TYPE_SHELL && type !== TARGET_TYPE_SSH && type !== TARGET_TYPE_ANDROID) return null;
    return type === offered ? type : null;
  }

  private toSessionDto(record: GuiSessionRecord): Record<string, unknown> {
    const target = this.targets.find((t) => t.id === record.deviceId);
    const name =
      target?.name ??
      (this.devices ? this.devices.name(record.deviceId) : undefined) ??
      record.deviceId;
    return {
      id: record.id,
      deviceId: record.deviceId,
      deviceName: name,
      type: record.type,
      state: record.state,
      createdAt: record.createdAt,
      connectedAt: record.connectedAt ?? null,
      lastActive: record.lastActive,
      closedReason: record.closedReason ?? null,
    };
  }

  private currentUser(req: IncomingMessage): HttpSessionRecord | null {
    const token = bearerToken(req) ?? cookieToken(req);
    return token ? this.httpSessions.verify(token) : null;
  }

  private requireAuth(
    req: IncomingMessage,
    res: ServerResponse,
    fn: (user: HttpSessionRecord, res: ServerResponse) => void | Promise<void>,
  ): void {
    const user = this.currentUser(req);
    if (!user) {
      sendJson(res, 401, { error: "Not authenticated" });
      return;
    }
    void Promise.resolve(fn(user, res));
  }

  private loginAllowed(ip: string): boolean {
    const entry = this.loginThrottle.get(ip);
    if (!entry) return true;
    const now = Date.now();
    if (now < entry.lockedUntil) return false;
    if (now - entry.windowStart >= LOGIN_WINDOW_MS) {
      this.loginThrottle.delete(ip);
      return true;
    }
    return entry.count < LOGIN_MAX_ATTEMPTS;
  }

  private recordLoginFailure(ip: string): void {
    const now = Date.now();
    const entry = this.loginThrottle.get(ip) ?? { count: 0, windowStart: now, lockedUntil: 0 };
    if (now - entry.windowStart >= LOGIN_WINDOW_MS) {
      entry.windowStart = now;
      entry.count = 0;
      entry.lockedUntil = 0;
    }
    entry.count++;
    if (entry.count >= LOGIN_MAX_ATTEMPTS) {
      entry.lockedUntil = now + LOGIN_LOCK_MS;
    }
    this.loginThrottle.set(ip, entry);
  }

  /** Activate the periodic GUI-session sweep. Returns this (for chaining). */
  startSweep(): this {
    if (this.sweepTimer) return this;
    this.sweepTimer = setInterval(() => {
      this.guiSessions.sweep(CREATE_WINDOW_MS, RECONNECT_GRACE_MS, PURGE_AGE_MS);
    }, SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
    return this;
  }

  stopSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(text);
}

function methodNotAllowed(res: ServerResponse, allow: string): void {
  res.writeHead(405, {
    "Content-Type": "application/json; charset=utf-8",
    Allow: allow,
  });
  res.end(JSON.stringify({ error: "Method not allowed" }));
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let usedBody: Buffer | null = null;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        usedBody = Buffer.concat(chunks).subarray(0, MAX_BODY_BYTES + 1);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = usedBody ?? Buffer.concat(chunks);
      if (raw.length === 0) return resolve({});
      try {
        resolve(JSON.parse(raw.toString("utf-8")) as Record<string, unknown>);
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : null;
}

function cookieToken(req: IncomingMessage): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const pair of header.split(";")) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    const name = pair.slice(0, idx).trim();
    if (name === SESSION_COOKIE_NAME) return pair.slice(idx + 1).trim();
  }
  return null;
}

function isHttps(req: IncomingMessage): boolean {
  const forwarded = req.headers["x-forwarded-proto"];
  if (typeof forwarded === "string" && forwarded.split(",")[0].trim() === "https") {
    return true;
  }
  return Boolean((req.socket as { encrypted?: boolean }).encrypted);
}

function setSessionCookie(req: IncomingMessage, res: ServerResponse, token: string): void {
  const secure = isHttps(req);
  res.setHeader("Set-Cookie", [
    `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`,
  ]);
}

function clearSessionCookie(res: ServerResponse): void {
  res.setHeader("Set-Cookie", [
    `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
  ]);
}

function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  const remote = req.socket.remoteAddress;
  return remote ?? "unknown";
}
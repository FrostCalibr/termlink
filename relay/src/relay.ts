import { createServer, type Server, type Socket } from "node:net";
import { Connection } from "../../server/src/connection.js";
import { CredentialStore } from "../../server/src/auth.js";
import { SessionRegistry } from "../../server/src/sessions.js";
import { AuthRateLimiter } from "../../server/src/rate-limit.js";
import type { Config } from "../../server/src/config.js";
import { PROTOCOL_VERSION } from "../../shared/protocol/constants.js";
import { RelaySession, type RelayClient } from "./session.js";
import { ApiServer } from "./api.js";
import { HttpSessionStore } from "./http-sessions.js";
import { GuiSessionRegistry } from "./gui-sessions.js";
import type { RelayConfig, Target } from "./config.js";
import { WebSocketFrontDoor } from "./ws-server.js";
import type { WebSocketClientHalf } from "./ws-client-half.js";
import { DeviceStore } from "./device-store.js";
import { DeviceManager } from "./device-manager.js";

/**
 * PaaS/load-balancer health probes (Render checks every listening port) connect
 * and send a plain HTTP request such as `HEAD /healthz`. The raw relay TCP
 * listener must answer those politely instead of feeding the bytes into the
 * framed protocol decoder (which would log a misleading protocol error every
 * second). A real relay client never sends HTTP-style bytes as its first
 * frame — frame headers are 4-byte big-endian payload lengths, which are 0x00
 * for any length under 16 MB — so this is a safe discriminator.
 */
function matchHttpProbe(chunk: Buffer): { method: string; path: string } | null {
  if (chunk.length < 12) return null;
  const nl = chunk.indexOf(0x0a);
  const end = nl === -1 ? Math.min(chunk.length, 256) : nl;
  const line = chunk.subarray(0, end).toString("latin1").replace(/\r$/, "");
  const m = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(line);
  if (!m) return null;
  const known = new Set([
    "GET",
    "HEAD",
    "POST",
    "PUT",
    "DELETE",
    "PATCH",
    "OPTIONS",
    "TRACE",
  ]);
  return known.has(m[1]) ? { method: m[1], path: m[2] } : null;
}

function httpProbeResponse(method: string, path: string): string {
  const ok = path === "/healthz" || path === "/" || path === "";
  const status = ok ? "200 OK" : "404 Not Found";
  const body = ok
    ? JSON.stringify({ status: "ok" })
    : JSON.stringify({ error: "not found", path });
  const headers = [
    `HTTP/1.1 ${status}`,
    "Content-Type: application/json",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "Connection: close",
    "",
    "",
  ].join("\r\n");
  return method === "HEAD" ? headers : headers + body;
}

export interface RelayLogger {
  info: (msg: string, fields?: Record<string, unknown>) => void;
  warn: (msg: string, fields?: Record<string, unknown>) => void;
  error: (msg: string, fields?: Record<string, unknown>) => void;
}

export interface RelayServerOptions {
  config: RelayConfig;
  logger: RelayLogger;
}

/**
 * Relay server: accepts client connections, authenticates them against the
 * relay's own credentials, then pairs each authenticated client with an
 * authorized backend target.
 *
 * Clients never address an arbitrary host:port. Every session is routed to a
 * statically configured target, so the relay is not an open proxy.
 */
export class RelayServer {
  private server: Server;
  private wsFrontDoor: WebSocketFrontDoor | null = null;
  private auth: CredentialStore;
  private sessions = new SessionRegistry();
  private httpSessions = new HttpSessionStore();
  private guiSessions = new GuiSessionRegistry();
  private api: ApiServer | null = null;
  private deviceManager: DeviceManager;
  private connections = new Map<string, Connection>();
  private relaySessions = new Map<string, RelaySession>();
  private config: RelayConfig;
  private logger: RelayLogger;
  private shuttingDown = false;
  private authLimiter: AuthRateLimiter | null;
  private sessionTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: RelayServerOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.auth = new CredentialStore(
      options.config.tokens,
      options.config.passwordUsers,
    );
    this.authLimiter = this.makeAuthLimiter();
    this.server = createServer((socket) => this.onConnection(socket));
    this.deviceManager = new DeviceManager({
      store: new DeviceStore(options.config.agents),
      logger: options.logger,
      authRateLimiter: this.authLimiter,
      maxAuthAttempts: options.config.maxAuthAttempts,
      authBackoffMs: options.config.authBackoffMs,
      authTimeoutMs: options.config.websocket?.authTimeoutMs ?? 10_000,
      idleTimeoutMs: this.config.websocket?.idleTimeoutMs ?? 30_000,
      sendHighWaterMark: this.config.websocket?.sendHighWaterMark ?? 1024 * 1024,
      sendLowWaterMark: this.config.websocket?.sendLowWaterMark ?? 256 * 1024,
    });

    if (options.config.websocket) {
      this.api = new ApiServer({
        auth: this.auth,
        targets: options.config.targets,
        httpSessions: this.httpSessions,
        guiSessions: this.guiSessions,
        authRateLimiter: this.authLimiter,
        devices: this.deviceManager,
        logger: options.logger,
        terminateConnection: (connectionId, reason) =>
          this.wsFrontDoor?.terminate(connectionId, reason),
      }).startSweep();
      this.wsFrontDoor = new WebSocketFrontDoor({
        config: options.config.websocket,
        auth: this.auth,
        sessions: this.sessions,
        maxAuthAttempts: options.config.maxAuthAttempts,
        authBackoffMs: options.config.authBackoffMs,
        authRateLimiter: this.authLimiter,
        targets: options.config.targets,
        api: this.api,
        devices: this.deviceManager,
        logger: options.logger,
        callbacks: {
          onAuthenticated: (half) => this.onWsAuthenticated(half),
          onHalfClose: (half) => this.onWsHalfClose(half),
        },
      });
    }

    if (this.config.sessionTtlMs > 0) {
      this.sessionTimer = setInterval(() => this.expireSessions(), 1000);
      this.sessionTimer.unref();
    }
  }

  private makeAuthLimiter(): AuthRateLimiter | null {
    const { authRateLimit, authRateLimitPerIp, authRateWindowMs } = this.config;
    if (authRateLimit <= 0 && authRateLimitPerIp <= 0) return null;
    return new AuthRateLimiter({
      windowMs: authRateWindowMs,
      globalLimit: authRateLimit,
      perIpLimit: authRateLimitPerIp,
    });
  }

  /** Remove and tear down every authenticated session over its TTL. */
  private expireSessions(): void {
    const expired = this.sessions.expireDue(this.config.sessionTtlMs);
    for (const session of expired) {
      this.logger.info("session_expired", {
        session: session.id,
        connection: session.connectionId,
        ttlMs: this.config.sessionTtlMs,
      });
      this.relaySessions.get(session.connectionId)?.terminate("Session expired");
      this.wsFrontDoor?.terminate(session.connectionId, "Session expired");
      this.connections.get(session.connectionId)?.terminate("Session expired");
    }
  }

  listen(): Promise<void> {
    // Bind the HTTP/WSS front door first: Render (and similar platforms) probe
    // the port the process starts listening on, and that must be the HTTP
    // surface serving /healthz, not the raw TCP relay (which would reject the
    // probe as a protocol error).
    const ws = this.wsFrontDoor ? this.wsFrontDoor.listen() : Promise.resolve();
    const tcp = new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.config.port, this.config.host, () => {
        this.server.removeListener("error", reject);
        this.logger.info("relay_listening", {
          host: this.config.host,
          port: this.config.port,
        });
        resolve();
      });
    });
    return Promise.all([tcp, ws]).then(() => undefined);
  }

  private onConnection(socket: Socket): void {
    if (this.shuttingDown) {
      socket.destroy();
      return;
    }

    // Sniff the first bytes before instantiating the framed Connection (which
    // immediately greets with a `hello` frame). Health probes send their HTTP
    // request line right away; real relay clients wait for `hello`. A short
    // window keeps both happy: probes get an HTTP response, silent clients get
    // `hello` once the window lapses.
    socket.pause();
    let resolved = false;
    const sniffTimer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      socket.off("data", onFirstData);
      socket.resume();
      this.attachConnection(socket);
    }, 150);
    sniffTimer.unref?.();

    const onFirstData = (chunk: Buffer): void => {
      if (resolved) return;
      resolved = true;
      clearTimeout(sniffTimer);
      socket.off("data", onFirstData);
      const probe = matchHttpProbe(chunk);
      if (probe) {
        this.logger.info("relay_http_probe", {
          method: probe.method,
          path: probe.path,
        });
        socket.write(httpProbeResponse(probe.method, probe.path));
        socket.resume();
        socket.end();
        return;
      }
      socket.resume();
      this.attachConnection(socket);
    };
    socket.once("data", onFirstData);
    socket.resume();
  }

  private attachConnection(socket: Socket): void {
    if (this.connections.size >= this.config.maxConnections) {
      this.logger.warn("relay_connection_rejected_max", {
        max: this.config.maxConnections,
      });
      socket.destroy();
      return;
    }

    let conn!: Connection;
    conn = new Connection(
      socket,
      this.makeServerConfig(),
      this.auth,
      this.sessions,
      {
        info: (m, f) => this.logger.info(m, f),
        warn: (m, f) => this.logger.warn(m, f),
        error: (m, f) => this.logger.error(m, f),
      },
      {
        onClose: (id) => this.onClientConnectionClose(id),
        onData: (payload) =>
          this.relaySessions.get(conn.connectionId)?.onClientData(payload),
        onBinary: (payload) =>
          this.relaySessions.get(conn.connectionId)?.onClientBinary(payload),
        onTerminalInput: (payload) =>
          this.relaySessions.get(conn.connectionId)?.onClientTerminalInput(payload),
        onTerminalResize: (cols, rows) =>
          this.relaySessions
            .get(conn.connectionId)
            ?.onClientTerminalResize(cols, rows),
        onDrained: () =>
          this.relaySessions.get(conn.connectionId)?.onClientDrained(),
        onAuthenticated: () => this.startRelaySession(conn),
      },
      null, // no local PTY in the relay
      this.authLimiter,
    );

    this.connections.set(conn.connectionId, conn);
    conn.start();
  }

  private startRelaySession(client: RelayClient, requestedTarget?: Target): RelaySession {
    // A WS client may select a device via `?device=`. TCP clients and
    // unselected WS clients fall back to the first configured target.
    const target = requestedTarget ?? this.config.targets[0];
    const session = new RelaySession({
      client,
      targetHost: target.host,
      targetPort: target.port,
      targetToken: target.token,
      targetUsername: target.username,
      targetPassword: target.password,
      targetTls: this.config.tls,
      connectTimeoutMs: 10_000,
      idleTimeoutMs: this.config.idleTimeoutMs,
      maxFrameSize: this.config.maxFrameSize,
      logger: this.logger,
      onClose: () => this.relaySessions.delete(client.connectionId),
    });
    this.relaySessions.set(client.connectionId, session);
    this.logger.info("relay_session_started", {
      connection: client.connectionId,
      target: target.id,
    });
    session.start();
    return session;
  }

  private onWsAuthenticated(half: WebSocketClientHalf): void {
    this.api?.onWsAuthenticated(half);
    if (this.deviceManager.has(half.deviceId)) {
      // Phase 9: agent-managed device — route through its outbound link.
      this.deviceManager.attachBrowserHalf(half);
      return;
    }
    const target = this.resolveTarget(half.deviceId);
    const session = this.startRelaySession(half, target);
    half.attachBridge(session);
  }

  private onWsHalfClose(half: WebSocketClientHalf): void {
    this.api?.onWsHalfClose(half);
    this.logger.info("ws_relay_half_closed", {
      connection: half.connectionId,
      sessions: this.relaySessions.size,
    });
  }

  /** Resolve a requested device id to its configured target (or the default). */
  private resolveTarget(deviceId: string | undefined): Target | undefined {
    if (deviceId === undefined) return undefined;
    return this.config.targets.find((t) => t.id === deviceId);
  }

  private onClientConnectionClose(connectionId: string): void {
    const session = this.relaySessions.get(connectionId);
    if (session) {
      session.terminate("Client connection closed");
    }
    this.relaySessions.delete(connectionId);
    this.connections.delete(connectionId);
    this.logger.info("relay_connection_closed", {
      connection: connectionId,
      active: this.connections.size,
    });
  }

  /** Gracefully shut down: stop accepting, close all connections and sessions. */
  close(): Promise<void> {
    this.shuttingDown = true;
    this.api?.stopSweep();
    this.deviceManager.close();
    if (this.sessionTimer) {
      clearInterval(this.sessionTimer);
      this.sessionTimer = null;
    }
    for (const session of this.relaySessions.values()) {
      session.terminate("Relay shutting down");
    }
    this.relaySessions.clear();
    for (const conn of this.connections.values()) {
      conn.shutdown();
    }
    this.connections.clear();
    const wsClose = this.wsFrontDoor ? this.wsFrontDoor.close() : Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        this.sessions.clear();
        resolve();
      };
      Promise.all([wsClose, new Promise<void>((r) => this.server.close(() => r()))]).then(done);
    });
  }

  /** Number of active client connections (TCP + WebSocket). */
  get connectionCount(): number {
    return this.connections.size + (this.wsFrontDoor?.connectionCount ?? 0);
  }

  /** Number of active authenticated relay sessions. */
  get sessionCount(): number {
    return this.relaySessions.size;
  }

  /** The TCP port the relay is bound to (useful when configured with port 0). */
  get port(): number {
    const addr = this.server.address();
    if (addr && typeof addr === "object") return addr.port;
    return 0;
  }

  /** The WebSocket port the relay is bound to, or 0 when disabled. */
  get wsPort(): number {
    return this.wsFrontDoor?.port ?? 0;
  }

  /** Whether the WebSocket front door is enabled. */
  get hasWebSocket(): boolean {
    return this.wsFrontDoor !== null;
  }

  private makeServerConfig(): Config {
    return {
      host: this.config.host,
      port: this.config.port,
      protocolVersion: PROTOCOL_VERSION,
      maxFrameSize: this.config.maxFrameSize,
      maxConnections: this.config.maxConnections,
      idleTimeoutMs: this.config.idleTimeoutMs,
      maxAuthAttempts: this.config.maxAuthAttempts,
      authBackoffMs: this.config.authBackoffMs,
      tokens: this.config.tokens,
      passwordUsers: this.config.passwordUsers,
      echoData: false,
      authTimeoutMs: this.config.authTimeoutMs,
      authRateLimit: this.config.authRateLimit,
      authRateLimitPerIp: this.config.authRateLimitPerIp,
      authRateWindowMs: this.config.authRateWindowMs,
      sessionTtlMs: this.config.sessionTtlMs,
    };
  }
}
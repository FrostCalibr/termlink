import { createServer, type Server, type Socket } from "node:net";
import { createServer as createTlsServer, type Server as TlsServer } from "node:tls";
import { Connection } from "./connection.js";
import { CredentialStore } from "./auth.js";
import { SessionRegistry } from "./sessions.js";
import { PtyBackend } from "./pty.js";
import { SshBackend } from "./ssh-backend.js";
import { AuthRateLimiter } from "./rate-limit.js";
import type { Config } from "./config.js";

export interface ServerLogger {
  info: (msg: string, fields?: Record<string, unknown>) => void;
  warn: (msg: string, fields?: Record<string, unknown>) => void;
  error: (msg: string, fields?: Record<string, unknown>) => void;
}

export interface TcpServerOptions {
  config: Config;
  logger: ServerLogger;
}

/**
 * TCP server that listens (optionally over TLS), accepts connections,
 * enforces connection limits, runs the global auth rate limiter, expires
 * stale sessions, and manages graceful shutdown.
 */
export class TcpServer {
  private server: Server | TlsServer;
  private auth: CredentialStore;
  private sessions = new SessionRegistry();
  private connections = new Map<string, Connection>();
  private config: Config;
  private logger: ServerLogger;
  private shuttingDown = false;
  private pty: PtyBackend | null;
  private ssh: SshBackend | null;
  private authLimiter: AuthRateLimiter | null;
  private sessionTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: TcpServerOptions) {
    this.config = options.config;
    this.logger = options.logger;
    this.auth = new CredentialStore(
      options.config.tokens,
      options.config.passwordUsers,
    );
    this.authLimiter = this.makeAuthLimiter();
    this.pty = options.config.pty
      ? new PtyBackend(options.config.pty, options.config.maxFrameSize, {
          info: (m, f) => this.logger.info(m, f),
          warn: (m, f) => this.logger.warn(m, f),
          error: (m, f) => this.logger.error(m, f),
        })
      : null;
    this.ssh = options.config.ssh
      ? new SshBackend(options.config.ssh, options.config.maxFrameSize, {
          info: (m, f) => this.logger.info(m, f),
          warn: (m, f) => this.logger.warn(m, f),
          error: (m, f) => this.logger.error(m, f),
        })
      : null;

    if (options.config.tls) {
      this.server = createTlsServer(
        {
          key: options.config.tls.key,
          cert: options.config.tls.cert,
          ...(options.config.tls.ca ? { ca: options.config.tls.ca } : {}),
        },
        (socket) => this.onConnection(socket as Socket),
      );
      this.server.on("tlsClientError", (err) => {
        this.logger.warn("tls_client_error", {
          message: err.message,
        });
      });
    } else {
      this.server = createServer((socket) => this.onConnection(socket));
    }

    if (this.config.sessionTtlMs > 0) {
      this.sessionTimer = setInterval(
        () => this.expireSessions(),
        1000,
      );
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

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.config.port, this.config.host, () => {
        this.server.removeListener("error", reject);
        this.logger.info("server_listening", {
          host: this.config.host,
          port: this.config.port,
        });
        resolve();
      });
    });
  }

  private onConnection(socket: Socket): void {
    if (this.shuttingDown) {
      socket.destroy();
      return;
    }

    if (this.connections.size >= this.config.maxConnections) {
      this.logger.warn("connection_rejected_max", {
        max: this.config.maxConnections,
      });
      socket.destroy();
      return;
    }

    const conn = new Connection(socket, this.config, this.auth, this.sessions, {
      info: (m, f) => this.logger.info(m, f),
      warn: (m, f) => this.logger.warn(m, f),
      error: (m, f) => this.logger.error(m, f),
    }, {
      onClose: (id, hadSession) => this.onConnectionClose(id, hadSession),
    }, this.pty, this.authLimiter, this.ssh);

    this.connections.set(conn.connectionId, conn);
    conn.start();
  }

  /** Remove and tear down every authenticated session that exceeded its TTL. */
  private expireSessions(): void {
    const expired = this.sessions.expireDue(this.config.sessionTtlMs);
    for (const session of expired) {
      this.logger.info("session_expired", {
        session: session.id,
        connection: session.connectionId,
        ttlMs: this.config.sessionTtlMs,
      });
      this.connections.get(session.connectionId)?.terminate("Session expired");
    }
  }

  private onConnectionClose(connectionId: string, hadSession: boolean): void {
    this.connections.delete(connectionId);
    this.logger.info("connection_closed", {
      connection: connectionId,
      hadSession,
      active: this.connections.size,
    });
  }

  /** Gracefully shut down: stop accepting, close active connections. */
  close(): Promise<void> {
    this.shuttingDown = true;
    if (this.sessionTimer) {
      clearInterval(this.sessionTimer);
      this.sessionTimer = null;
    }
    this.pty?.disposeAll();
    this.ssh?.disposeAll();
    for (const conn of this.connections.values()) {
      conn.shutdown();
    }
    return new Promise((resolve) => {
      this.server.close(() => {
        this.sessions.clear();
        resolve();
      });
    });
  }

  /** Number of active connections. */
  get connectionCount(): number {
    return this.connections.size;
  }

  /** Number of active authenticated sessions. */
  get sessionCount(): number {
    return this.sessions.size;
  }

  /** Number of live PTY sessions (0 when the PTY backend is disabled). */
  get ptyCount(): number {
    return this.pty?.size ?? 0;
  }

  /** Number of live SSH sessions (0 when the SSH backend is disabled). */
  get sshCount(): number {
    return this.ssh?.size ?? 0;
  }

  /** The port the server is bound to (useful when configured with port 0). */
  get port(): number {
    const addr = this.server.address();
    if (addr && typeof addr === "object") return addr.port;
    return 0;
  }
}

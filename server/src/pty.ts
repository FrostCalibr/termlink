import * as pty from "node-pty";
import type { IPty } from "node-pty";

export interface PtyConfig {
  /** Shell executable path from trusted server configuration. */
  shell: string;
  cols: number;
  rows: number;
  cwd: string;
  /** Optional custom environment map or base environment to inherit/override. */
  env?: Record<string, string>;
}

export interface PtyLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface PtyBackendStartHandlers {
  /** PTY output bytes, split into frame-safe base64 chunks. */
  onOutput: (base64Chunk: string) => void;
  /** The child process exited on its own (not via dispose). */
  onExit: (exitCode: number, signal: number) => void;
}

export const PTY_TERM = "xterm-256color";

const MAX_DIMENSION = 1000;

/**
 * Environment allow-list for spawned shells. Secrets in the server process
 * (credentials, tokens, config) are deliberately absent.
 */
const SAFE_ENV_KEYS = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_MESSAGES",
  "USER",
  "LOGNAME",
  "TERM",
  "SHELL",
  "TZ",
  "EDITOR",
];

/**
 * One isolated PTY/shell pair for a single authenticated connection.
 *
 * Data is treated as raw bytes in both directions:
 *  - output is decoded byte-exactly (`latin1`) then base64-encoded,
 *  - input is written as a raw Buffer (byte-exact, no re-encoding).
 * `dispose()` is idempotent and force-kills the child if a graceful kill
 * does not take effect, so a dead client can never leave an orphaned shell.
 */
export class PtySession {
  readonly pid: number;
  private proc: IPty;
  private disposed = false;
  private killTimer: NodeJS.Timeout | null = null;
  /** Resolves when the underlying child exits, for tests/cleanup proofs. */
  readonly exited: Promise<{ exitCode: number; signal: number }>;

  constructor(private config: PtyConfig) {
    this.proc = pty.spawn(config.shell, [], {
      name: PTY_TERM,
      cols: config.cols,
      rows: config.rows,
      cwd: config.cwd,
      env: buildPtyEnv(config.shell, config.cwd, process.env as Record<string, string>, config.env),
      encoding: "latin1",
      handleFlowControl: true,
      flowControlPause: "\x13",
      flowControlResume: "\x11",
    });
    this.pid = this.proc.pid ?? 0;
    this.exited = new Promise((resolve) => {
      this.proc.onExit((e) =>
        resolve({ exitCode: e.exitCode ?? 0, signal: e.signal ?? 0 }),
      );
    });
  }

  /** Subscribe to raw output bytes (one Buffer per data event). */
  onData(cb: (bytes: Buffer) => void): void {
    this.proc.onData((data) => cb(Buffer.from(data, "latin1")));
  }

  /** Subscribe to an unforced child exit (ignored after dispose). */
  onExit(cb: (exitCode: number, signal: number) => void): void {
    void this.exited.then(({ exitCode, signal }) => {
      if (!this.disposed) cb(exitCode, signal);
    });
  }

  /** Write raw input bytes to the PTY (byte-exact). */
  write(bytes: Buffer): void {
    if (this.disposed || bytes.length === 0) return;
    try {
      (this.proc as unknown as { write: (d: Buffer | string) => void }).write(bytes);
    } catch {
      /* pty may be closing */
    }
  }

  /** Resize the terminal. Dimensions are clamped to sane bounds. */
  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    try {
      this.proc.resize(clampDim(cols), clampDim(rows));
    } catch {
      /* pty may be gone */
    }
  }

  /** Kill the child and any descendants of the process group. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.proc.kill();
    } catch {
      /* already gone */
    }
    const pid = this.proc.pid;
    this.killTimer = setTimeout(() => {
      this.killTimer = null;
      try {
        if (pid && pid > 0) {
          process.kill(pid, "SIGKILL");
        }
      } catch {
        /* already gone */
      }
    }, 500);
    this.killTimer.unref?.();
  }
}

/**
 * Registry of PTY sessions keyed by connection id. One session per
 * authenticated connection; sessions are isolated and cleaned up reliably.
 */
export class PtyBackend {
  private sessions = new Map<string, PtySession>();
  private chunkLen: number;

  constructor(
    private config: PtyConfig,
    private maxFrameSize: number,
    private logger: PtyLogger,
  ) {
    this.chunkLen = Math.max(64, Math.floor((Math.min(maxFrameSize, 4 * 1024 * 1024) - 128) * 3) / 4 | 0);
  }

  /** Number of live PTY sessions. */
  get size(): number {
    return this.sessions.size;
  }

  /** Active session pids (for tests/observability). */
  get pids(): number[] {
    return [...this.sessions.values()].map((s) => s.pid);
  }

  /**
   * Start a PTY for a connection. Returns the session, or null when the
   * shell could not be spawned (e.g. bad path); the connection should then
   * be terminated gracefully.
   */
  start(connectionId: string, handlers: PtyBackendStartHandlers): PtySession | null {
    const existing = this.sessions.get(connectionId);
    if (existing) return existing;

    let session: PtySession;
    try {
      session = new PtySession(this.config);
    } catch (err) {
      this.logger.warn("pty_spawn_failed", {
        connection: connectionId,
        error: String(err instanceof Error ? err.message : err),
      });
      return null;
    }

    session.onData((bytes) => this.dispatchOutput(bytes, handlers.onOutput));
    session.onExit((exitCode, signal) => handlers.onExit(exitCode, signal));
    void session.exited.then(() => {
      if (this.sessions.get(connectionId) === session) {
        this.sessions.delete(connectionId);
      }
    });

    this.sessions.set(connectionId, session);
    this.logger.info("pty_started", {
      connection: connectionId,
      pid: session.pid,
      shell: this.config.shell,
    });
    return session;
  }

  /** Forward client terminal input bytes (base64) to a session's stdin. */
  write(connectionId: string, base64Payload: string): void {
    const session = this.sessions.get(connectionId);
    if (!session) return;
    let bytes: Buffer;
    try {
      bytes = Buffer.from(base64Payload, "base64");
    } catch {
      return;
    }
    session.write(bytes);
  }

  /** Resize a session's terminal window. */
  resize(connectionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(connectionId);
    if (!session) return;
    session.resize(clampDim(cols), clampDim(rows));
  }

  /** Tear down a connection's session. Idempotent. */
  dispose(connectionId: string): void {
    const session = this.sessions.get(connectionId);
    if (!session) return;
    this.sessions.delete(connectionId);
    this.logger.info("pty_disposed", {
      connection: connectionId,
      pid: session.pid,
    });
    session.dispose();
  }

  /** Tear down every session (used on server shutdown). */
  disposeAll(): void {
    for (const connectionId of [...this.sessions.keys()]) {
      this.dispose(connectionId);
    }
  }

  private dispatchOutput(
    bytes: Buffer,
    onOutput: (base64Chunk: string) => void,
  ): void {
    for (let off = 0; off < bytes.length; off += this.chunkLen) {
      const chunk = bytes.subarray(off, off + this.chunkLen);
      onOutput(chunk.toString("base64"));
    }
  }
}

function clampDim(value: number): number {
  if (!Number.isInteger(value) || value < 1) return 1;
  return Math.min(value, MAX_DIMENSION);
}

const SENSITIVE_EXPLICIT_KEYS = new Set([
  "AUTH_TOKENS",
  "AUTH_TOKENS_FILE",
  "PASSWORD_USERS",
  "PASSWORD_USERS_FILE",
  "AUTH_TOKEN",
  "CLIENT_TOKEN",
  "PASSWORD",
  "USERNAME",
  "RELAY_URL",
  "AGENT_DEVICE_ID",
  "AGENT_CREDENTIALS_FILE",
  "CREDENTIALS_FILE",
  "AGENT_ENROLLMENT_TOKEN",
  "ENROLLMENT_TOKEN",
  "ANDROID_RELAY_URL",
  "ANDROID_DEVICE_ID",
  "ANDROID_CREDENTIALS_FILE",
  "ANDROID_ENROLLMENT_TOKEN",
  "SSH_PASSWORD",
  "SSH_PASSWORD_FILE",
  "SSH_PRIVATE_KEY",
  "SSH_PRIVATE_KEY_FILE",
  "SSH_PASSPHRASE",
  "TLS_KEY",
  "TLS_KEY_FILE",
  "TLS_PASSPHRASE",
  "TLS_CERT",
  "TLS_CERT_FILE",
  "TLS_CA",
  "TLS_CA_FILE",
]);

/**
 * Returns true if an environment variable key contains sensitive credentials,
 * agent secrets, or authentication configuration.
 */
export function isSensitiveEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (SENSITIVE_EXPLICIT_KEYS.has(upper)) return true;

  if (
    /^AGENT_/i.test(upper) ||
    /^RELAY_/i.test(upper) ||
    /^ANDROID_/i.test(upper) ||
    /_SECRET$/i.test(upper) ||
    /_TOKEN$/i.test(upper) ||
    /_PASSWORD$/i.test(upper) ||
    /_PASSPHRASE$/i.test(upper) ||
    /_PRIVKEY$/i.test(upper) ||
    /_PRIVATE_KEY$/i.test(upper)
  ) {
    return true;
  }

  return false;
}

/**
 * Build the environment for spawned PTY shells:
 * 1. Inherits non-sensitive process environment variables (e.g. XDG_SESSION_TYPE,
 *    DBUS_SESSION_BUS_ADDRESS, DISPLAY, WAYLAND_DISPLAY, etc.).
 * 2. Explicitly strips sensitive agent/runtime variables, credentials, and secrets.
 * 3. Applies terminal-specific overrides (TERM, SHELL, HOME, PWD).
 */
export function buildPtyEnv(
  shell: string,
  cwd: string,
  baseEnv: Record<string, string | undefined> = process.env as Record<string, string>,
  customEnv?: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined && !isSensitiveEnvKey(key)) {
      env[key] = value;
    }
  }

  if (customEnv) {
    for (const [key, value] of Object.entries(customEnv)) {
      if (value !== undefined && !isSensitiveEnvKey(key)) {
        env[key] = value;
      }
    }
  }

  env.TERM = PTY_TERM;
  env.SHELL = shell;
  if (!env.HOME && baseEnv.HOME) env.HOME = baseEnv.HOME;
  if (!env.HOME) env.HOME = cwd;
  env.PWD = cwd;

  return env;
}
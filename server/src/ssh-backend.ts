import ssh2, {
  type ClientChannel,
  type ConnectConfig,
} from "ssh2";
import { sha256Digest, makeKnownHostsVerifier, makeFingerprintsVerifier, type KnownHostEntry } from "../../shared/known-hosts.js";

const { Client, utils: ssh2Utils } = ssh2;

export interface SshConfig {
  /** Remote SSH host (trusted static configuration). */
  host: string;
  port: number;
  username: string;
  /** Present iff password authentication is configured. */
  password?: string;
  /** Present iff key authentication is configured (PEM/OpenSSH private key). */
  privateKey?: string;
  /** Passphrase for an encrypted private key. */
  passphrase?: string;
  /** SSH handshake deadline in ms. */
  connectTimeoutMs: number;
  cols: number;
  rows: number;
  /** $TERM value requested for the remote pty. */
  term: string;
  /** Parsed known_hosts entries (host-key verification). */
  knownHosts: KnownHostEntry[];
  /** Allowed host key SHA-256 digests (bare base64, optional SHA256: prefix). */
  fingerprints: Buffer[];
  /** Explicit opt-in to skip host-key verification (warning at startup). */
  insecureHostKeyCheck: boolean;
}

export interface SshLogger {
  info: (msg: string, fields?: Record<string, unknown>) => void;
  warn: (msg: string, fields?: Record<string, unknown>) => void;
  error: (msg: string, fields?: Record<string, unknown>) => void;
}

export interface SshBackendStartHandlers {
  /** SSH stdout/stderr bytes, split into frame-safe base64 chunks. */
  onOutput: (base64Chunk: string) => void;
  /** The SSH session ended (connect failure, auth failure, remote close...). */
  onExit: (reason: string) => void;
}

interface SshSessionHandlers extends SshBackendStartHandlers {
  /** Detailed (non-user-facing) error for the operator logs. */
  onError: (detail: string) => void;
}

const MAX_DIMENSION = 1000;
const DEFAULT_TERM = "xterm-256color";

/**
 * One SSH client/shell pair for a single authenticated connection. The remote
 * host and credentials come only from trusted server configuration.
 */
class SshSession {
  private client = new Client();
  private stream: ClientChannel | null = null;
  private disposed = false;

  constructor(
    private config: SshConfig,
    private chunkLen: number,
    private handlers: SshSessionHandlers,
  ) {
    this.client.on("ready", () => this.openShell());
    this.client.on("error", (err) => {
      this.handlers.onError(err instanceof Error ? err.message : String(err));
      this.exit(this.normalizeError(err));
    });
    this.client.on("close", () => this.exit("SSH connection closed"));
    this.client.connect(this.connectOptions());
  }

  private connectOptions(): ConnectConfig {
    const options: ConnectConfig = {
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      readyTimeout: this.config.connectTimeoutMs,
      hostVerifier: this.makeHostVerifier(),
      keepaliveInterval: 15_000,
      keepaliveCountMax: 3,
    };
    if (this.config.password !== undefined) {
      options.password = this.config.password;
    }
    if (this.config.privateKey !== undefined) {
      options.privateKey = this.config.privateKey;
    }
    if (this.config.passphrase !== undefined) {
      options.passphrase = this.config.passphrase;
    }
    return options;
  }

  private makeHostVerifier(): (key: Buffer) => boolean {
    const { host, port, knownHosts, fingerprints, insecureHostKeyCheck } = this.config;
    if (insecureHostKeyCheck) return () => true;
    const known = makeKnownHostsVerifier(knownHosts, host, port);
    const pinned = makeFingerprintsVerifier(fingerprints);
    return (key: Buffer) => known(key) || pinned(key);
  }

  private openShell(): void {
    if (this.disposed) return;
    try {
      this.client.shell(
        { term: this.config.term, cols: clampDim(this.config.cols), rows: clampDim(this.config.rows) },
        (err, stream) => {
          if (err || !stream) {
            this.handlers.onError(err?.message ?? "no stream");
            this.exit("SSH shell failed to open");
            return;
          }
          if (this.disposed) return;
          this.stream = stream;
          stream.on("data", (bytes: Buffer) => this.dispatch(bytes));
          stream.stderr.on("data", (bytes: Buffer) => this.dispatch(bytes));
          stream.on("close", () => this.exit("SSH session ended"));
          stream.on("error", () => undefined);
        },
      );
    } catch (err) {
      this.handlers.onError(String(err));
      this.exit("SSH session failed to open");
    }
  }

  /** Write raw input bytes to the SSH shell stdin (byte-exact). */
  write(bytes: Buffer): void {
    if (this.disposed || bytes.length === 0) return;
    try {
      this.stream?.write(bytes);
    } catch {
      /* channel may be closing */
    }
  }

  /** Resize the remote pty. Dimensions are clamped to sane bounds. */
  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    try {
      this.stream?.setWindow(clampDim(rows), clampDim(cols), 0, 0);
    } catch {
      /* channel may be gone */
    }
  }

  /** End the SSH connection without reporting an exit (client-side teardown). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.client.end();
    } catch {
      /* already closing */
    }
  }

  private dispatch(bytes: Buffer): void {
    for (let off = 0; off < bytes.length; off += this.chunkLen) {
      const chunk = bytes.subarray(off, off + this.chunkLen);
      this.handlers.onOutput(chunk.toString("base64"));
    }
  }

  private exit(reason: string): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.client.end();
    } catch {
      /* already closing */
    }
    this.handlers.onExit(reason);
  }

  /** Map raw ssh2 error messages to concise, user-safe reasons. */
  private normalizeError(err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    if (/host (key )?(denied|verification failed)|host key|verification failed/i.test(msg)) {
      return "SSH host key verification failed";
    }
    if (/authentication methods failed|authentication failed|unable to authenticate/i.test(msg)) {
      return "SSH authentication failed";
    }
    if (/handshake|ready timeout/i.test(msg)) {
      return "SSH connection timed out";
    }
    if (/econnrefused|econnreset|enetunreach|eai_again|ehostunreach|econnaborted/i.test(msg)) {
      return "SSH connection failed";
    }
    return "SSH session failed";
  }
}

/**
 * Registry of SSH sessions keyed by connection id, mirroring PtyBackend:
 * one session per authenticated connection, isolated and cleaned up reliably.
 */
export class SshBackend {
  private sessions = new Map<string, SshSession>();
  private chunkLen: number;

  constructor(
    private config: SshConfig,
    private maxFrameSize: number,
    private logger: SshLogger,
  ) {
    this.chunkLen = Math.max(64, Math.floor((Math.min(maxFrameSize, 4 * 1024 * 1024) - 128) * 3) / 4 | 0);
  }

  /** Number of live SSH sessions. */
  get size(): number {
    return this.sessions.size;
  }

  /**
   * Begin an SSH session for a connection. Returns non-null immediately; the
   * session connect/handshake happens asynchronously and failures surface via
   * `onExit`. Returns null only when a session already exists for the id.
   */
  start(connectionId: string, handlers: SshBackendStartHandlers): boolean {
    if (this.sessions.has(connectionId)) return true;
    const session = new SshSession(
      this.config,
      this.chunkLen,
      {
        onOutput: (chunk) => handlers.onOutput(chunk),
        onExit: (reason) => {
          this.sessions.delete(connectionId);
          handlers.onExit(reason);
        },
        onError: (detail) => {
          this.logger.warn("ssh_error", { connection: connectionId, detail });
        },
      },
    );
    this.sessions.set(connectionId, session);
    this.logger.info("ssh_started", {
      connection: connectionId,
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
    });
    return true;
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

  /** Resize a session's remote pty. */
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
    this.logger.info("ssh_disposed", { connection: connectionId });
    session.dispose();
  }

  /** Tear down every session (used on server shutdown). */
  disposeAll(): void {
    for (const connectionId of [...this.sessions.keys()]) {
      this.dispose(connectionId);
    }
  }
}

function clampDim(value: number): number {
  if (!Number.isInteger(value) || value < 1) return 1;
  return Math.min(value, MAX_DIMENSION);
}

/** Validate that a private key parses and is usable with the given passphrase. */
export function validatePrivateKey(
  content: string,
  passphrase: string | undefined,
): Error | null {
  const parsed = ssh2Utils.parseKey(content, passphrase);
  if (parsed instanceof Error) {
    return parsed as Error;
  }
  if (!parsed.isPrivateKey()) {
    return new Error("SSH_PRIVATE_KEY is not a private key");
  }
  return null;
}

export { DEFAULT_TERM as SSH_DEFAULT_TERM, sha256Digest as sshKeyDigest };
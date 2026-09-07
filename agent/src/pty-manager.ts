import { PtyBackend } from "../../server/src/pty.js";
import type { PtyConfig, PtyLogger } from "../../server/src/pty.js";
import type { DeviceClientMessage } from "../../shared/device/protocol.js";

export const DEFAULT_TERMINAL_COLS = 80;
export const DEFAULT_TERMINAL_ROWS = 24;

export interface PtyManagerLogger {
  warn(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

const DEFAULT_MAX_FRAME_SIZE = 256 * 1024;

/**
 * Spawns and owns the isolated local PTY shells the browser routes reach.
 *
 * Shell binary, working directory and environment come exclusively from the
 * operator-provided {@link PtyConfig}; the browser only requests a session
 * and then sends terminal bytes/resizes. Wraps the server's well-tested
 * {@link PtyBackend} keyed by the relay-assigned session id, and emits output
 * as base64 `device_session_output` frames for the relay.
 */
export class PtyManager {
  readonly backend: PtyBackend;
  private shellLabelText: string;

  constructor(
    config: PtyConfig,
    private send: (msg: DeviceClientMessage) => void,
    private logger: PtyManagerLogger,
  ) {
    this.backend = new PtyBackend(config, DEFAULT_MAX_FRAME_SIZE, logger);
    this.shellLabelText = config.shell;
  }

  /** Number of live PTY sessions. */
  get size(): number {
    return this.backend.size;
  }

  /** Spawn a terminal for a session the relay opened. */
  start(sessionId: string, cols: number, rows: number): void {
    const session = this.backend.start(sessionId, {
      onOutput: (base64Chunk) =>
        this.send({ type: "device_session_output", sessionId, data: base64Chunk }),
      onExit: (_exitCode, _signal) =>
        this.send({ type: "device_session_exited", sessionId }),
    });
    if (!session) {
      this.send({
        type: "device_session_failed",
        sessionId,
        reason: `Failed to spawn shell "${this.shellLabelText}"`,
      });
      return;
    }
    session.resize(clamp(cols, DEFAULT_TERMINAL_COLS), clamp(rows, DEFAULT_TERMINAL_ROWS));
    this.logger.info("agent_pty_started", { sessionId, pid: session.pid });
  }

  /** Forward browser terminal input bytes (base64) to the session's stdin. */
  input(sessionId: string, base64Payload: string): void {
    this.backend.write(sessionId, base64Payload);
  }

  /** Resize the session's terminal window. */
  resize(sessionId: string, cols: number, rows: number): void {
    this.backend.resize(sessionId, clamp(cols, DEFAULT_TERMINAL_COLS), clamp(rows, DEFAULT_TERMINAL_ROWS));
  }

  /** Tear down a session's PTY (relay asked to close, or disconnected). */
  close(sessionId: string): void {
    this.backend.dispose(sessionId);
  }

  /** Tear down every PTY (agent shutdown). */
  closeAll(): void {
    this.backend.disposeAll();
  }
}

function clamp(value: number, fallback: number): number {
  if (!Number.isInteger(value) || value < 1) return fallback;
  return value;
}
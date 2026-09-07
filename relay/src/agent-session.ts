import type { ServerMessage } from "../../shared/protocol/types.js";
import type { RelayBridge } from "./session.js";
import type { AgentLink } from "./agent-link.js";
import type { WebSocketClientHalf } from "./ws-client-half.js";
import type { RelayLogger } from "./relay.js";

/**
 * Bounded buffering while a peer is write-pressured. Mirrors the caps used by
 * the WS half and the TCP relay bridge.
 */
const MAX_QUEUED_FRAMES = 2048;
const MAX_QUEUED_BYTES = 16 * 1024 * 1024;

/**
 * A single multiplexed terminal channel on an agent device link, bridging one
 * browser {@link WebSocketClientHalf} and one PTY session spawned by the agent.
 *
 * The browser side sees exactly the same {@link RelayBridge} surface a TCP
 * RelaySession exposes: terminal input/resize flow toward the device, output
 * flows back as `terminal_output`. The device side reuses the existing
 * terminal protocol semantics (`device_session_input` / `device_session_output`
 * / `device_session_resize`), so the agent spawns a plain isolated PTY.
 *
 * Backpressure is bounded in both directions:
 *  - device → browser: when the browser half is write-pressured, output is
 *    buffered (capped) and flushed when the half drains;
 *  - browser → device: when the agent's WebSocket is write-pressured, input is
 *    buffered (capped) and flushed when the link reports drained.
 */
export class AgentSession implements RelayBridge {
  private closed = false;
  private endedByAgent = false;

  /** device → browser buffering while the browser half is pressured. */
  private outputQueue: string[] = [];
  private outputBytes = 0;
  private clientPressured = false;

  /** browser → device buffering while the agent link is pressured. */
  private inputQueue: string[] = [];
  private inputBytes = 0;

  constructor(
    private link: AgentLink,
    private half: WebSocketClientHalf,
    private sessionId: string,
    private logger: RelayLogger,
  ) {}

  /** The GUI/browser session id this channel is bound to. */
  get id(): string {
    return this.sessionId;
  }

  /** The browser half this channel currently serves. */
  get clientHalf(): WebSocketClientHalf {
    return this.half;
  }

  /** The relay opened this channel; ask the agent to spawn its PTY. */
  attach(): void {
    if (this.closed) return;
    this.link.openChannel(this.sessionId, this, 80, 24);
  }

  // ── Browser → device ─────────────────────────────────────────────────────

  onClientData(payload: string): void {
    // Agent devices are terminal-only; treat stray data as a protocol error.
    this.logger.warn("agent_session_non_terminal_data", {
      session: this.sessionId,
    });
    this.half.terminate("Agent device sessions are terminal-only");
  }

  onClientBinary(payload: string): void {
    this.onClientData(payload);
  }

  onClientTerminalInput(payload: string): void {
    if (this.closed) return;
    const ok = this.link.send({
      type: "device_session_input",
      sessionId: this.sessionId,
      data: payload,
    });
    if (!ok) {
      this.bufferInput(payload);
    }
  }

  onClientTerminalResize(cols: number, rows: number): void {
    if (this.closed) return;
    this.link.send({
      type: "device_session_resize",
      sessionId: this.sessionId,
      cols,
      rows,
    });
  }

  // ── Device → browser ─────────────────────────────────────────────────────

  /** The agent streamed PTY output bytes for this session. */
  deliverOutput(base64: string): void {
    if (this.closed) return;
    const msg: ServerMessage = { type: "terminal_output", data: base64 };
    const ok = this.half.forward(msg);
    if (!ok) {
      this.clientPressured = true;
      this.outputQueue.push(base64);
      this.outputBytes += base64.length;
      if (
        this.outputQueue.length > MAX_QUEUED_FRAMES ||
        this.outputBytes > MAX_QUEUED_BYTES
      ) {
        this.half.terminate("Device output exceeded buffered capacity");
      }
    }
  }

  /** The browser half drained; flush any buffered device output. */
  onClientDrained(): void {
    if (!this.clientPressured || this.closed) return;
    while (this.outputQueue.length > 0) {
      const next = this.outputQueue[0];
      const ok = this.half.forward({ type: "terminal_output", data: next });
      if (!ok) return;
      this.outputQueue.shift();
      this.outputBytes -= next.length;
    }
    if (this.outputQueue.length === 0) this.clientPressured = false;
  }

  /** The agent could not start the requested PTY session. */
  onFailed(reason: string): void {
    if (this.endedByAgent) return;
    this.endedByAgent = true;
    this.link.removeChannel(this.sessionId);
    this.half.terminate(`Device session failed: ${reason}`);
  }

  /** The agent's terminal exited on its own. */
  onExited(): void {
    if (this.endedByAgent) return;
    this.endedByAgent = true;
    this.link.removeChannel(this.sessionId);
    this.half.terminate("Terminal session ended");
  }

  /** The agent link closed entirely (device went offline). */
  onLinkGone(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.half.terminate(reason);
  }

  /**
   * Client half closed (browser disconnected) or the relay tore the session
   * down. Clean up the channel; the agent is asked to kill the PTY.
   */
  terminate(reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    if (!this.endedByAgent) {
      this.link.removeChannel(this.sessionId, reason ?? "Session closed");
    }
  }

  hasPausedInput(): boolean {
    return this.inputQueue.length > 0;
  }

  flushInput(): void {
    while (this.inputQueue.length > 0 && !this.closed) {
      const next = this.inputQueue[0];
      const ok = this.link.send({
        type: "device_session_input",
        sessionId: this.sessionId,
        data: next,
      });
      if (!ok) return;
      this.inputQueue.shift();
      this.inputBytes -= next.length;
    }
  }

  private bufferInput(payload: string): void {
    this.inputQueue.push(payload);
    this.inputBytes += payload.length;
    if (
      this.inputQueue.length > MAX_QUEUED_FRAMES ||
      this.inputBytes > MAX_QUEUED_BYTES
    ) {
      this.half.terminate("Client sent too much data while the device was busy");
      return;
    }
    this.link.notePaused(this);
  }
}
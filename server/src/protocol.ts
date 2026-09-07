import type {
  AuthRequestMessage,
  ClientMessage,
  ProtocolState,
  ServerMessage,
  TerminalResizeMessage,
} from "../../shared/protocol/types.js";
import { FrameError } from "../../shared/protocol/framing.js";

export interface ProtocolCallbacks {
  /** Send an outbound message to the peer. */
  send: (msg: ServerMessage) => void;
  /** Client submitted an auth request; connection must verify and resolve. */
  onAuthRequest: (msg: AuthRequestMessage) => void;
  /** Authenticated payload data received from the client. */
  onData: (payload: string) => void;
  /** Authenticated binary payload received from the client. */
  onBinary: (payload: string) => void;
  /** Terminal input bytes received from the client (base64). */
  onTerminalInput: (payload: string) => void;
  /** Client requests a terminal resize. */
  onTerminalResize: (msg: TerminalResizeMessage) => void;
}

/**
 * Server-side protocol state machine.
 *
 * Deterministic and independent of socket handling so it can be unit tested.
 *
 * States:
 *   connecting → authenticating → ready → closing
 */
export class Protocol {
  private state: ProtocolState = "connecting";

  constructor(private callbacks: ProtocolCallbacks) {}

  /** Transition out of connecting and greet the client. */
  hello(authMethods: string[]): void {
    this.current("connecting");
    this.state = "authenticating";
    this.callbacks.send({
      type: "hello",
      version: 1,
      auth_methods: authMethods,
    });
  }

  /** Feed an incoming client message, applying state-machine rules. */
  handle(msg: ClientMessage): void {
    switch (msg.type) {
      case "auth_request":
        this.current("authenticating");
        this.callbacks.onAuthRequest(msg);
        break;
      case "data":
        this.current("ready");
        this.callbacks.onData(msg.data);
        break;
      case "binary":
        this.current("ready");
        this.callbacks.onBinary(msg.data);
        break;
      case "terminal_input":
        this.current("ready");
        this.callbacks.onTerminalInput(msg.data);
        break;
      case "terminal_resize":
        this.current("ready");
        this.callbacks.onTerminalResize(msg);
        break;
      case "ping":
        this.current("ready");
        this.callbacks.send({ type: "pong" });
        break;
      case "goodbye":
        this.current("ready", "authenticating");
        this.state = "closing";
        this.callbacks.send({ type: "goodbye", reason: msg.reason });
        break;
    }
  }

  /** Mark authentication as successful. */
  authOk(sessionId: string): void {
    this.current("authenticating");
    this.state = "ready";
    this.callbacks.send({ type: "auth_ok", session_id: sessionId });
  }

  /** Mark authentication as failed. */
  authFail(reason: string): void {
    this.current("authenticating");
    this.callbacks.send({ type: "auth_fail", reason });
  }

  /** Stream PTY output bytes (base64) to the client while ready. */
  terminalOutput(payload: string): void {
    if (!this.isReady) return;
    this.callbacks.send({ type: "terminal_output", data: payload });
  }

  /** The peer has gone away; enter closing state. */
  peerClosed(reason?: string): void {
    if (this.state !== "closing") {
      this.state = "closing";
    }
  }

  /** Whether data messages are currently permitted. */
  get isReady(): boolean {
    return this.state === "ready";
  }

  /** Current protocol state. */
  get stateValue(): ProtocolState {
    return this.state;
  }

  private current(...allowed: ProtocolState[]): void {
    if (!allowed.includes(this.state)) {
      throw new FrameError(
        `Message not valid in state "${this.state}" (valid: ${allowed.join(
          ", ",
        )})`,
      );
    }
  }
}

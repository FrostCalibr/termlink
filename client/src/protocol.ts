import type {
  ServerMessage,
  ClientMessage,
  ProtocolState,
} from "../../shared/protocol/types.js";
import { FrameError } from "../../shared/protocol/framing.js";

export type ClientProtocolState =
  | "disconnected"
  | "connecting"
  | "waiting_hello"
  | "authenticating"
  | "ready"
  | "closing";

export interface ClientProtocolCallbacks {
  /** Server greeted us; the connection should send an auth_request. */
  onHello: (authMethods: string[]) => void;
  /** Authentication succeeded. */
  onAuthOk: (sessionId: string) => void;
  /** Authentication failed. */
  onAuthFail: (reason: string) => void;
  /** Server sent application data while ready. */
  onData: (payload: string) => void;
  /** Server sent binary data while ready. */
  onBinary: (payload: string) => void;
  /** Server streamed PTY output (base64) while ready. */
  onTerminalOutput: (payload: string) => void;
  /** Server requested a clean close or sent a goodbye. */
  onGoodbye: (reason?: string) => void;
  /** Server answered our ping. */
  onPong: () => void;
}

/**
 * Client-side protocol state machine.
 *
 * Mirrors the server's states from the client's perspective. Deterministic and
 * independently testable (no socket I/O).
 */
export class ClientProtocol {
  private state: ClientProtocolState = "disconnected";

  constructor(private callbacks: ClientProtocolCallbacks) {}

  /** TCP connection established; expect a hello. */
  connected(): void {
    this.current("disconnected", "waiting_hello");
    this.state = "waiting_hello";
  }

  /** Feed an inbound server message. */
  handle(msg: ServerMessage): void {
    switch (msg.type) {
      case "hello":
        this.current("waiting_hello");
        this.state = "authenticating";
        this.callbacks.onHello(msg.auth_methods);
        break;
      case "auth_ok":
        this.current("authenticating");
        this.state = "ready";
        this.callbacks.onAuthOk(msg.session_id);
        break;
      case "auth_fail":
        this.current("authenticating");
        this.callbacks.onAuthFail(msg.reason);
        break;
      case "data":
        this.current("ready");
        this.callbacks.onData(msg.data);
        break;
      case "binary":
        this.current("ready");
        this.callbacks.onBinary(msg.data);
        break;
      case "terminal_output":
        this.current("ready");
        this.callbacks.onTerminalOutput(msg.data);
        break;
      case "pong":
        this.current("ready");
        this.callbacks.onPong();
        break;
      case "goodbye":
        this.current("ready", "authenticating");
        this.state = "closing";
        this.callbacks.onGoodbye(msg.reason);
        break;
    }
  }

  /** Send-side transitions handled by the connection. */
  requestSentAuth(): void {
    // no state change; we remain in "authenticating"
  }

  /** Called when the socket closes. */
  disconnected(): void {
    this.state = "disconnected";
  }

  /** Whether we are fully authenticated and ready. */
  get isReady(): boolean {
    return this.state === "ready";
  }

  /** Current state. */
  get stateValue(): ClientProtocolState {
    return this.state;
  }

  private current(...allowed: ClientProtocolState[]): void {
    if (!allowed.includes(this.state)) {
      throw new FrameError(
        `Server message not valid in client state "${this.state}" (valid: ${allowed.join(
          ", ",
        )})`,
      );
    }
  }
}

/**
 * Build the auth_request message for this connection given the server's
 * advertised auth methods and the configured credentials.
 */
export function buildAuthRequest(
  authMethods: string[],
  creds: { token?: string; username?: string; password?: string },
): ClientMessage {
  if (authMethods.includes("token") && creds.token) {
    return { type: "auth_request", method: "token", token: creds.token };
  }
  if (
    authMethods.includes("password") &&
    creds.username &&
    creds.password
  ) {
    return {
      type: "auth_request",
      method: "password",
      username: creds.username,
      password: creds.password,
    };
  }
  throw new Error(
    "No usable credentials for the server's advertised auth methods",
  );
}

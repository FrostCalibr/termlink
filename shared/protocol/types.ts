import type { PROTOCOL_VERSION } from "./constants.js";

// ── Server → Client messages ────────────────────────────────────────────────

export interface HelloMessage {
  type: "hello";
  version: typeof PROTOCOL_VERSION;
  auth_methods: string[];
}

export interface AuthOkMessage {
  type: "auth_ok";
  session_id: string;
}

export interface AuthFailMessage {
  type: "auth_fail";
  reason: string;
}

export interface DataMessage {
  type: "data";
  data: string;
}

export interface BinaryMessage {
  type: "binary";
  data: string; // base64-encoded arbitrary bytes
}

/** Terminal input bytes from the client (base64), forwarded to the PTY stdin. */
export interface TerminalInputMessage {
  type: "terminal_input";
  data: string; // base64-encoded arbitrary bytes
}

/** PTY stdout/stderr bytes (base64), streamed to the client. */
export interface TerminalOutputMessage {
  type: "terminal_output";
  data: string; // base64-encoded arbitrary bytes
}

/** Client requests a terminal resize (PTY winsize). */
export interface TerminalResizeMessage {
  type: "terminal_resize";
  cols: number;
  rows: number;
}

export interface PongMessage {
  type: "pong";
}

export interface GoodbyeMessage {
  type: "goodbye";
  reason?: string;
}

export type ServerMessage =
  | HelloMessage
  | AuthOkMessage
  | AuthFailMessage
  | DataMessage
  | BinaryMessage
  | TerminalOutputMessage
  | PongMessage
  | GoodbyeMessage;

// ── Client → Server messages ────────────────────────────────────────────────

export interface AuthRequestToken {
  type: "auth_request";
  method: "token";
  token: string;
}

export interface AuthRequestPassword {
  type: "auth_request";
  method: "password";
  username: string;
  password: string;
}

export type AuthRequestMessage = AuthRequestToken | AuthRequestPassword;

export interface PingMessage {
  type: "ping";
}

export type ClientMessage =
  | AuthRequestMessage
  | DataMessage
  | BinaryMessage
  | TerminalInputMessage
  | TerminalResizeMessage
  | PingMessage
  | GoodbyeMessage;

// ── Protocol state ──────────────────────────────────────────────────────────

export type ProtocolState =
  | "connecting"
  | "authenticating"
  | "ready"
  | "closing";

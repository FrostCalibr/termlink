import type { Server, Socket } from "node:net";
import { createServer } from "node:net";
import { RelayServer } from "../src/relay.js";
import { loadRelayConfig } from "../src/config.js";
import { encodeFrame } from "../../shared/protocol/framing.js";
import { FrameDecoder, type Message } from "../../shared/protocol/framing.js";

export const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface ApiResult {
  status: number;
  json: Record<string, unknown> | null;
}

export async function api(
  port: number,
  path: string,
  opts: { method?: string; token?: string; body?: unknown } = {},
): Promise<ApiResult> {
  const { method = "GET", token, body } = opts;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json: Record<string, unknown> | null = null;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    /* non-JSON response */
  }
  return { status: res.status, json };
}

/** Minimal relay-protocol echo backend that tags replies with its id. */
export class TagEchoServer {
  server: Server;
  port = 0;
  constructor(private tag: string) {
    this.server = createServer((socket) => this.handle(socket));
  }
  private handle(socket: Socket): void {
    socket.on("error", () => undefined);
    socket.write(encodeFrame({ type: "hello", version: 1, auth_methods: ["token"] }));
    const decoder = new FrameDecoder(1024 * 1024);
    socket.on("data", (chunk) => {
      decoder.feed(chunk);
      let msg: Message | null;
      while ((msg = decoder.read())) {
        if (msg.type === "auth_request") {
          socket.write(encodeFrame({ type: "auth_ok", session_id: "s:" + this.tag }));
        } else if (msg.type === "data" || msg.type === "binary") {
          if (msg.type === "data") {
            socket.write(encodeFrame({ type: "data", data: `[${this.tag}]${msg.data}` }));
          } else {
            socket.write(encodeFrame({ type: "binary", data: msg.data }));
          }
        }
      }
    });
  }
  listen(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server.address() as { port: number };
        this.port = addr.port;
        resolve();
      });
    });
  }
  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

export async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const relays: RelayServer[] = [];
const servers: Array<{ close: () => Promise<void> }> = [];

export function trackRelay(relay: RelayServer): RelayServer {
  relays.push(relay);
  return relay;
}

export function trackServer(server: { close: () => Promise<void> }): void {
  servers.push(server);
}

export async function resetTracked(): Promise<void> {
  while (servers.length) {
    const s = servers.pop()!;
    await s.close().catch(() => undefined);
  }
  while (relays.length) {
    const r = relays.pop()!;
    await r.close().catch(() => undefined);
  }
}

/**
 * Start a relay with two echo backends: `alpha` (shell) → tagged "A" and
 * `beta` (ssh) → tagged "B" (unless `beta` is overridden). Returns the relay's
 * HTTP/WS port. `extraTargets` append additional `TARGETS` entries.
 */
export async function makeRelay(opts: {
  targets?: string[];
  passwordUsers?: string;
} = {}): Promise<{ port: number; alpha: TagEchoServer; beta: TagEchoServer }> {
  const { targets, passwordUsers = "alice:secret,bob:pw" } = opts;
  const alpha = new TagEchoServer("A");
  const beta = new TagEchoServer("B");
  await alpha.listen();
  await beta.listen();
  trackServer(alpha);
  trackServer(beta);
  const alphaTarget = `alpha|Alpha|shell=backendtok@127.0.0.1:${alpha.port}`;
  const betaTarget = `beta|Beta host|ssh=backendtok@127.0.0.1:${beta.port}`;
  const list = targets ?? [alphaTarget, betaTarget];
  const config = loadRelayConfig({
    RELAY_HOST: "127.0.0.1",
    RELAY_PORT: "0",
    WS_ENABLED: "true",
    WS_PORT: "0",
    AUTH_TOKENS: "relaytok",
    PASSWORD_USERS: passwordUsers,
    TARGETS: list.join(","),
    WS_AUTH_TIMEOUT_MS: "3000",
    WS_IDLE_TIMEOUT_MS: "10000",
    IDLE_TIMEOUT_MS: "10000",
  });
  const relay = trackRelay(new RelayServer({ config, logger: silentLogger }));
  await relay.listen();
  return { port: relay.wsPort, alpha, beta };
}

/** Login and return the web session token. */
export async function login(port: number, creds: { token?: string; username?: string; password?: string }): Promise<string> {
  const res = await api(port, "/api/auth/login", { method: "POST", body: creds });
  if (res.status !== 200) throw new Error("login failed: " + res.status);
  return (res.json as { session: { token: string } }).session.token;
}
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { TcpServer } from "../../server/src/server.js";
import { loadConfig } from "../../server/src/config.js";
import { RelayServer } from "../src/relay.js";
import { loadRelayConfig, type RelayConfig } from "../src/config.js";
import { encodeFrame } from "../../shared/protocol/framing.js";
import { FrameDecoder } from "../../shared/protocol/framing.js";
import type { Message } from "../../shared/protocol/framing.js";
import { WebSocket } from "ws";
import type { WebSocket as WsClient } from "ws";

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function makeRelayConfig(overrides: Partial<RelayConfig>): RelayConfig {
  const base = loadRelayConfig({
    RELAY_HOST: "127.0.0.1",
    RELAY_PORT: "0",
    WS_ENABLED: "true",
    WS_PORT: "0",
    AUTH_TOKENS: "relaytok",
    TARGETS: "pty=127.0.0.1:1",
    WS_AUTH_TIMEOUT_MS: "3000",
    WS_IDLE_TIMEOUT_MS: "5000",
    IDLE_TIMEOUT_MS: "5000",
  });
  return { ...base, ...overrides };
}

function makeBackendConfig() {
  return loadConfig({
    HOST: "127.0.0.1",
    PORT: "0",
    AUTH_TOKENS: "backendtok",
    ECHO_DATA: "true",
  });
}

/** A minimal protocol peer that echoes typed data/binary frames. */
class EchoBinaryServer {
  server: Server;
  port = 0;
  constructor(private denyAuth = false, private denyAuthDelayMs = 0) {
    this.server = createServer((socket) => this.handle(socket));
  }

  private handle(socket: Socket): void {
    socket.write(
      encodeFrame({ type: "hello", version: 1, auth_methods: ["token"] }),
    );
    const decoder = new FrameDecoder(1024 * 1024);
    socket.on("data", (chunk) => {
      decoder.feed(chunk);
      let msg: Message | null;
      while ((msg = decoder.read())) {
        if (msg.type === "auth_request") {
          const reply = (): Message =>
            this.denyAuth
              ? { type: "auth_fail", reason: "backend rejects you" }
              : { type: "auth_ok", session_id: "s" };
          if (this.denyAuthDelayMs > 0) {
            setTimeout(() => socket.write(encodeFrame(reply())), this.denyAuthDelayMs);
          } else {
            socket.write(encodeFrame(reply()));
          }
        } else if (msg.type === "data" || msg.type === "binary") {
          socket.write(encodeFrame({ type: msg.type, data: msg.data }));
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

/** Build a relay config with a reachable echo backend and optional ws tweaks. */
async function makeRelayWithBackend(
  wsOverrides: Partial<NonNullable<RelayConfig["websocket"]>>,
): Promise<{ backend: EchoBinaryServer; config: RelayConfig }> {
  const backend = new EchoBinaryServer();
  await backend.listen();
  const config = makeRelayConfig({
    targets: [
      { id: "pty", host: "127.0.0.1", port: backend.port, token: "backendtok" },
    ],
  });
  if (wsOverrides) {
    config.websocket = { ...(config.websocket as NonNullable<RelayConfig["websocket"]>), ...wsOverrides };
  }
  return { backend, config };
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Connect using the ws client library (allows custom Origin/headers). */
function connectWs(
  port: number,
  opts: { origin?: string } = {},
): Promise<{
  ws: WsClient;
  messages: Array<{ data: string | Buffer; isBinary: boolean }>;
  closes: Array<{ code: number; reason: string }>;
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: opts.origin ? { Origin: opts.origin } : {},
    });
    const messages: Array<{ data: string | Buffer; isBinary: boolean }> = [];
    const closes: Array<{ code: number; reason: string }> = [];
    ws.on("message", (data, isBinary) =>
      messages.push({ data: data as Buffer, isBinary }),
    );
    ws.on("close", (code, reason) => closes.push({ code, reason: reason.toString() }));
    ws.on("error", () => undefined);
    ws.on("open", () => resolve({ ws, messages, closes }));
    setTimeout(() => reject(new Error("ws open timeout")), 3000);
  });
}

async function handshake(
  ws: WsClient,
  messages: Array<{ data: string | Buffer; isBinary: boolean }>,
  token = "relaytok",
): Promise<void> {
  await waitFor(() =>
    messages.some((m) => String(m.data).includes('"hello"')),
  );
  ws.send(
    JSON.stringify({ type: "auth_request", method: "token", token }),
  );
  await waitFor(() =>
    messages.some((m) => String(m.data).includes('"auth_ok"')),
  );
}

const relays: RelayServer[] = [];
const servers: Array<{ close: () => Promise<void> }> = [];
const sockets: WsClient[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  while (servers.length) {
    const s = servers.pop()!;
    await s.close().catch(() => undefined);
  }
  while (relays.length) {
    const r = relays.pop()!;
    await r.close().catch(() => undefined);
  }
});

describe("WebSocket front door", () => {
  it("authenticates a token over WebSocket and round-trips text through the backend", async () => {
    const backend = new EchoBinaryServer();
    await backend.listen();
    servers.push(backend);

    const relay = new RelayServer({
      config: makeRelayConfig({
        targets: [{ id: "pty", host: "127.0.0.1", port: backend.port, token: "backendtok" }],
      }),
      logger: silentLogger,
    });
    await relay.listen();
    relays.push(relay);

    const { ws, messages } = await connectWs(relay.wsPort);
    sockets.push(ws);
    await handshake(ws, messages);
    expect(relay.sessionCount).toBe(1);

    ws.send(JSON.stringify({ type: "data", data: "hola from ws" }));
    await waitFor(() =>
      messages.some(
        (m) => !m.isBinary && String(m.data) === '{"type":"data","data":"hola from ws"}',
      ),
    );
  });

  it("round-trips binary payloads as raw WebSocket binary frames", async () => {
    const backend = new EchoBinaryServer();
    await backend.listen();
    servers.push(backend);

    const relay = new RelayServer({
      config: makeRelayConfig({
        targets: [{ id: "pty", host: "127.0.0.1", port: backend.port, token: "backendtok" }],
      }),
      logger: silentLogger,
    });
    await relay.listen();
    relays.push(relay);

    const { ws, messages } = await connectWs(relay.wsPort);
    sockets.push(ws);
    await handshake(ws, messages);

    const bytes = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    ws.send(bytes);
    await waitFor(() => messages.some((m) => m.isBinary));
    const got = messages.find((m) => m.isBinary)!.data as Buffer;
    expect(got.equals(bytes)).toBe(true);
  });

  it("rejects invalid credentials with auth_fail and no session", async () => {
    const relay = new RelayServer({
      config: makeRelayConfig({
        targets: [{ id: "pty", host: "127.0.0.1", port: 1 }],
      }),
      logger: silentLogger,
    });
    await relay.listen();
    relays.push(relay);

    const { ws, messages, closes } = await connectWs(relay.wsPort);
    sockets.push(ws);
    await waitFor(() => messages.some((m) => String(m.data).includes('"hello"')));

    ws.send(JSON.stringify({ type: "auth_request", method: "token", token: "nope" }));
    await waitFor(() =>
      messages.some((m) => String(m.data).includes('"auth_fail"')),
    );
    expect(relay.sessionCount).toBe(0);
    await waitFor(() => closes.length > 0);
  });

  it("terminates early when a client sends data before authenticating", async () => {
    const relay = new RelayServer({
      config: makeRelayConfig({
        targets: [{ id: "pty", host: "127.0.0.1", port: 1 }],
      }),
      logger: silentLogger,
    });
    await relay.listen();
    relays.push(relay);

    const { ws, messages, closes } = await connectWs(relay.wsPort);
    sockets.push(ws);
    await waitFor(() => messages.some((m) => String(m.data).includes('"hello"')));

    ws.send(JSON.stringify({ type: "data", data: "too early" }));
    await waitFor(() => closes.length > 0);
    expect(relay.sessionCount).toBe(0);
  });

  it("rejects a disallowed Origin and a missing Origin when an allow-list is configured", async () => {
    const { config } = await makeRelayWithBackend({
      allowedOrigins: ["http://relay.example"],
    });
    const relay = new RelayServer({ config, logger: silentLogger });
    await relay.listen();
    relays.push(relay);

    const badOrigin = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${relay.wsPort}/ws`, {
        headers: { Origin: "http://evil.example" },
      });
      ws.on("error", () => resolve(true));
      ws.on("open", () => resolve(false));
    });
    expect(badOrigin).toBe(true);

    const missingOrigin = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${relay.wsPort}/ws`);
      ws.on("error", () => resolve(true));
      ws.on("open", () => resolve(false));
    });
    expect(missingOrigin).toBe(true);
  });

  it("accepts a configured origin", async () => {
    const { config } = await makeRelayWithBackend({
      allowedOrigins: ["http://relay.example"],
    });
    const relay = new RelayServer({ config, logger: silentLogger });
    await relay.listen();
    relays.push(relay);

    const { ws, messages } = await connectWs(relay.wsPort, {
      origin: "http://relay.example/",
    });
    sockets.push(ws);
    await handshake(ws, messages);
    expect(relay.connectionCount).toBe(1);
  });

  it("enforces the WebSocket connection limit", async () => {
    const { config } = await makeRelayWithBackend({ maxConnections: 1 });
    const relay = new RelayServer({ config, logger: silentLogger });
    await relay.listen();
    relays.push(relay);

    const first = await connectWs(relay.wsPort);
    sockets.push(first.ws);
    await waitFor(() => relay.connectionCount === 1);

    const rejected = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${relay.wsPort}/ws`, {
        headers: { Origin: "http://relay.example" },
      });
      ws.on("error", () => resolve(true));
      ws.on("open", () => resolve(false));
    });
    expect(rejected).toBe(true);

    first.ws.terminate();
    sockets.splice(sockets.indexOf(first.ws), 1);
    await waitFor(() => relay.connectionCount === 0);

    const second = await connectWs(relay.wsPort);
    sockets.push(second.ws);
    await handshake(second.ws, second.messages);
    expect(relay.connectionCount).toBe(1);
  });

  it("closes oversized WebSocket messages (message limit)", async () => {
    const base = makeRelayConfig({
      targets: [{ id: "pty", host: "127.0.0.1", port: 1 }],
    });
    base.websocket = {
      ...(base.websocket as NonNullable<RelayConfig["websocket"]>),
      maxMessageSize: 512,
    };
    const relay = new RelayServer({ config: base, logger: silentLogger });
    await relay.listen();
    relays.push(relay);

    const { ws, messages, closes } = await connectWs(relay.wsPort);
    sockets.push(ws);
    await waitFor(() => messages.some((m) => String(m.data).includes('"hello"')));

    ws.send("x".repeat(2000));
    await waitFor(() => closes.length > 0);
    expect(closes[0].code).toBe(1009);
  });

  it("terms the session when the backend fails to authenticate", async () => {
    const backend = new EchoBinaryServer(true, 300);
    await backend.listen();
    servers.push(backend);
    const relay = new RelayServer({
      config: makeRelayConfig({
        targets: [
          { id: "pty", host: "127.0.0.1", port: backend.port, token: "backendtok" },
        ],
      }),
      logger: silentLogger,
    });
    await relay.listen();
    relays.push(relay);

    const { ws, messages, closes } = await connectWs(relay.wsPort);
    sockets.push(ws);
    await handshake(ws, messages);
    expect(relay.sessionCount).toBe(1);
    await waitFor(() =>
      messages.some((m) => String(m.data).includes('"goodbye"')),
    );
    await waitFor(() => closes.length > 0);
    await waitFor(() => relay.sessionCount === 0, 2000);
    expect(relay.sessionCount).toBe(0);
  });
});
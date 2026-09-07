import { describe, it, expect, afterEach } from "vitest";
import { TcpServer } from "../../server/src/server.js";
import { loadConfig } from "../../server/src/config.js";
import { RelayServer } from "../src/relay.js";
import { loadRelayConfig, type RelayConfig } from "../src/config.js";
import { WebSocket } from "ws";
import type { WebSocket as WsClient } from "ws";

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function makeRelayConfig(overrides: {
  env?: Record<string, string>;
  relay?: Partial<RelayConfig>;
} = {}): RelayConfig {
  return {
    ...loadRelayConfig({
      RELAY_HOST: "127.0.0.1",
      RELAY_PORT: "0",
      WS_ENABLED: "true",
      WS_PORT: "0",
      AUTH_TOKENS: "relaytok",
      TARGETS: "pty=127.0.0.1:1",
      WS_AUTH_TIMEOUT_MS: "3000",
      WS_IDLE_TIMEOUT_MS: "5000",
      IDLE_TIMEOUT_MS: "5000",
      ...overrides.env,
    }),
    ...(overrides.relay ?? {}),
  };
}

async function startEchoBackend() {
  const server = new TcpServer({
    config: loadConfig({
      HOST: "127.0.0.1",
      PORT: "0",
      AUTH_TOKENS: "backendtok",
      ECHO_DATA: "true",
    }),
    logger: silentLogger,
  });
  await server.listen();
  return server;
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function connectWs(
  port: number,
): Promise<{
  ws: WsClient;
  messages: string[];
  closes: Array<{ code: number; reason: string }>;
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const messages: string[] = [];
    const closes: Array<{ code: number; reason: string }> = [];
    ws.on("message", (data) => messages.push(String(data)));
    ws.on("close", (code, reason) => closes.push({ code, reason: reason.toString() }));
    ws.on("error", () => undefined);
    ws.on("open", () => resolve({ ws, messages, closes }));
    setTimeout(() => reject(new Error("ws open timeout")), 3000);
  });
}

async function authenticate(
  ws: WsClient,
  messages: string[],
  token = "relaytok",
): Promise<void> {
  await waitFor(() => messages.some((m) => m.includes('"hello"')));
  ws.send(JSON.stringify({ type: "auth_request", method: "token", token }));
  await waitFor(() => messages.some((m) => m.includes('"auth_ok"')));
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

describe("relay security hardening", () => {
  it("rate-limits authentication attempts across separate connections", async () => {
    const relay = new RelayServer({
      config: makeRelayConfig({ relay: { authRateLimitPerIp: 2 } }),
      logger: silentLogger,
    });
    await relay.listen();
    relays.push(relay);

    // Connection 1: single bad attempt (allowed, count 1).
    const c1 = await connectWs(relay.wsPort);
    sockets.push(c1.ws);
    await waitFor(() => c1.messages.some((m) => m.includes('"hello"')));
    c1.ws.send(JSON.stringify({ type: "auth_request", method: "token", token: "bad" }));
    await waitFor(() => c1.messages.some((m) => m.includes('"auth_fail"')));
    expect(c1.messages.some((m) => m.includes("Invalid credentials"))).toBe(true);
    c1.ws.terminate();

    // Connection 2: bad attempt (allowed, count 2).
    const c2 = await connectWs(relay.wsPort);
    sockets.push(c2.ws);
    await waitFor(() => c2.messages.some((m) => m.includes('"hello"')));
    c2.ws.send(JSON.stringify({ type: "auth_request", method: "token", token: "bad" }));
    await waitFor(() => c2.messages.some((m) => m.includes('"auth_fail"')));
    c2.ws.terminate();

    // Connection 3: bad attempt is now throttled by the shared limiter.
    const c3 = await connectWs(relay.wsPort);
    sockets.push(c3.ws);
    await waitFor(() => c3.messages.some((m) => m.includes('"hello"')));
    c3.ws.send(JSON.stringify({ type: "auth_request", method: "token", token: "bad" }));
    await waitFor(() => c3.messages.some((m) => m.includes('"auth_fail"')));
    expect(
      c3.messages.some((m) => m.includes("Too many authentication attempts")),
    ).toBe(true);
    expect(relay.sessionCount).toBe(0);
  });

  it("expires WS sessions after the session TTL", async () => {
    const backend = await startEchoBackend();
    servers.push(backend);
    const relay = new RelayServer({
      config: makeRelayConfig({
        env: { TARGETS: `pty=backendtok@127.0.0.1:${backend.port}` },
        relay: { sessionTtlMs: 200 },
      }),
      logger: silentLogger,
    });
    await relay.listen();
    relays.push(relay);

    const { ws, messages } = await connectWs(relay.wsPort);
    sockets.push(ws);
    await authenticate(ws, messages);
    expect(relay.sessionCount).toBe(1);

    await waitFor(() => relay.sessionCount === 0, 5000);
    // The half was terminated with a "Session expired" goodbye.
    await waitFor(() => messages.some((m) => m.includes("Session expired")), 5000);
  });

  it("only ever connects to the configured target — a second (decoy) target gets no connections", async () => {
    const primary = await startEchoBackend();
    servers.push(primary);
    const decoy = await startEchoBackend();
    servers.push(decoy);

    const relay = new RelayServer({
      config: makeRelayConfig({
        env: {
          TARGETS: `primary=backendtok@127.0.0.1:${primary.port},decoy=backendtok@127.0.0.1:${decoy.port}`,
        },
      }),
      logger: silentLogger,
    });
    await relay.listen();
    relays.push(relay);

    const { ws, messages } = await connectWs(relay.wsPort);
    sockets.push(ws);
    await authenticate(ws, messages);
    expect(relay.sessionCount).toBe(1);

    ws.send(JSON.stringify({ type: "data", data: "pick me" }));
    await waitFor(() => messages.some((m) => m.includes("pick me")));

    // Only the first configured target was paired with.
    expect(primary.connectionCount).toBe(1);
    expect(decoy.connectionCount).toBe(0);
  });
});
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:net";
import { TcpServer } from "../../server/src/server.js";
import { loadConfig } from "../../server/src/config.js";
import { TcpClient } from "../../client/src/transport.js";
import { loadClientConfig } from "../../client/src/config.js";
import { RelayServer } from "../src/relay.js";
import { loadRelayConfig, type RelayConfig } from "../src/config.js";
import { encodeFrame } from "../../shared/protocol/framing.js";
import { FrameDecoder } from "../../shared/protocol/framing.js";
import type { Message } from "../../shared/protocol/framing.js";
import type { Socket } from "node:net";

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function makeBackendConfig() {
  return loadConfig({
    HOST: "127.0.0.1",
    PORT: "0",
    AUTH_TOKENS: "backendtok",
    ECHO_DATA: "true",
  });
}

function makeRelayConfig(overrides: Partial<RelayConfig>): RelayConfig {
  const base = loadRelayConfig({
    RELAY_HOST: "127.0.0.1",
    RELAY_PORT: "0",
    AUTH_TOKENS: "relaytok",
    TARGETS: "pty=127.0.0.1:1",
    IDLE_TIMEOUT_MS: "5000",
  });
  return { ...base, ...overrides };
}

function makeClientConfig(port: number, token = "relaytok") {
  return loadClientConfig({
    SERVER_HOST: "127.0.0.1",
    SERVER_PORT: String(port),
    AUTH_TOKEN: token,
    CONNECT_TIMEOUT_MS: "2000",
    IDLE_TIMEOUT_MS: "5000",
    RECONNECT: "false",
  });
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A minimal protocol peer that echoes typed data/binary frames (used for the binary path). */
class EchoBinaryServer {
  server: Server;
  port = 0;
  constructor() {
    this.server = createServer((socket) => this.handle(socket));
  }

  private handle(socket: Socket): void {
    socket.write(encodeFrame({ type: "hello", version: 1, auth_methods: ["token"] }));
    const decoder = new FrameDecoder(1024 * 1024);
    socket.on("data", (chunk) => {
      decoder.feed(chunk);
      let msg: Message | null;
      while ((msg = decoder.read())) {
        if (msg.type === "auth_request") {
          socket.write(encodeFrame({ type: "auth_ok", session_id: "s" }));
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

async function closedPort(): Promise<number> {
  const srv: Server = createServer();
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));
  const addr = srv.address() as { port: number };
  const port = addr.port;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

const relays: RelayServer[] = [];
const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  while (servers.length) {
    const s = servers.pop()!;
    await s.close().catch(() => undefined);
  }
  while (relays.length) {
    const r = relays.pop()!;
    await r.close().catch(() => undefined);
  }
});

describe("Relay integration", () => {
  it("authenticates client→relay→server and round-trips data end to end", async () => {
    const backend = new TcpServer({ config: makeBackendConfig(), logger: silentLogger });
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

    const events: string[] = [];
    const dataEvents: string[] = [];
    const client = new TcpClient({
      config: makeClientConfig(relay.port),
      onEvent: (e) => {
        events.push(e.type);
        if (e.type === "data") dataEvents.push(e.payload);
      },
    });
    await client.connect();
    await waitFor(() => events.includes("ready"));
    expect(relay.sessionCount).toBe(1);

    client.sendData("all the way through");
    await waitFor(() => dataEvents.includes("all the way through"));
    expect(dataEvents).toContain("all the way through");

    client.close();
    await waitFor(() => relay.sessionCount === 0);
    expect(relay.sessionCount).toBe(0);
  });

  it("round-trips binary payloads through the relay when the backend echoes binary", async () => {
    const backend = new EchoBinaryServer();
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

    const binaryEvents: string[] = [];
    const client = new TcpClient({
      config: makeClientConfig(relay.port),
      onEvent: (e) => {
        if (e.type === "binary") binaryEvents.push(e.payload);
      },
    });
    await client.connect();
    await waitFor(() => client.isReady);

    client.sendBinary("AQIDBQ==");
    await waitFor(() => binaryEvents.length > 0);
    expect(binaryEvents[0]).toBe("AQIDBQ==");

    client.close();
    await waitFor(() => relay.sessionCount === 0);
  });

  it("rejects a client that authenticates with invalid credentials", async () => {
    const relay = new RelayServer({
      config: makeRelayConfig({
        targets: [{ id: "pty", host: "127.0.0.1", port: 1 }],
      }),
      logger: silentLogger,
    });
    await relay.listen();
    relays.push(relay);

    const events: string[] = [];
    const client = new TcpClient({
      config: makeClientConfig(relay.port, "wrongtoken"),
      onEvent: (e) => events.push(e.type),
    });
    await client.connect();
    await waitFor(() => events.includes("auth_failed"));
    expect(events).toContain("auth_failed");
    expect(relay.sessionCount).toBe(0);
  });

  it("terminates the client session when the configured backend is unreachable", async () => {
    const unavailable = await closedPort();
    const relay = new RelayServer({
      config: makeRelayConfig({
        targets: [{ id: "pty", host: "127.0.0.1", port: unavailable }],
      }),
      logger: silentLogger,
    });
    await relay.listen();
    relays.push(relay);

    const events: string[] = [];
    const client = new TcpClient({
      config: makeClientConfig(relay.port),
      onEvent: (e) => events.push(e.type),
    });
    await client.connect();
    // The relay still authenticates the client…
    await waitFor(() => events.includes("ready"));
    // …but the backend connection fails, so the session is torn down.
    await waitFor(() => events.includes("goodbye"));
    await waitFor(() => events.includes("disconnected"));
    expect(relay.sessionCount).toBe(0);
  });
});
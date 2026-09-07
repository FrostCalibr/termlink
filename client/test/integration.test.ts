import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { TcpServer } from "../../server/src/server.js";
import { loadConfig } from "../../server/src/config.js";
import { TcpClient } from "../src/transport.js";
import { loadClientConfig } from "../src/config.js";

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

async function startServer(port: number) {
  const server = new TcpServer({
    config: loadConfig({
      HOST: "127.0.0.1",
      PORT: String(port),
      MAX_FRAME_SIZE: "65536",
      MAX_CONNECTIONS: "16",
      IDLE_TIMEOUT_MS: "10000",
      MAX_AUTH_ATTEMPTS: "3",
      AUTH_BACKOFF_MS: "50",
      AUTH_TOKENS: "client-integration-token",
      PASSWORD_USERS: "alice:pw",
      ECHO_DATA: "true",
    }),
    logger: silentLogger,
  });
  await server.listen();
  return server;
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("client ↔ server integration", () => {
  let server: TcpServer;
  let freePort: number;
  const usedPorts = new Set<number>();

  async function nextFreePort(): Promise<number> {
    let port: number;
    do {
      port = 25000 + Math.floor(Math.random() * 10000);
    } while (usedPorts.has(port));
    usedPorts.add(port);
    return port;
  }

  beforeEach(async () => {
    freePort = await nextFreePort();
    server = await startServer(freePort);
  });

  afterEach(async () => {
    await server.close();
  });

  it("authenticates against the real server with a token", async () => {
    const events: string[] = [];
    const client = new TcpClient({
      config: loadClientConfig({
        SERVER_HOST: "127.0.0.1",
        SERVER_PORT: String(freePort),
        AUTH_TOKEN: "client-integration-token",
        CONNECT_TIMEOUT_MS: "2000",
        RECONNECT: "false",
      }),
      onEvent: (e) => events.push(e.type),
    });
    await client.connect();
    await waitFor(() => client.isReady);
    expect(client.isReady).toBe(true);
    // Server now has one authenticated session.
    expect(server.sessionCount).toBe(1);
    await client.close();
  });

  it("rejects invalid credentials against the real server", async () => {
    const events: string[] = [];
    const client = new TcpClient({
      config: loadClientConfig({
        SERVER_HOST: "127.0.0.1",
        SERVER_PORT: String(freePort),
        AUTH_TOKEN: "wrong-token",
        CONNECT_TIMEOUT_MS: "2000",
        RECONNECT: "false",
      }),
      onEvent: (e) => events.push(e.type),
    });
    await client.connect();
    await waitFor(() => events.includes("auth_failed"));
    expect(events).toContain("auth_failed");
    expect(client.isReady).toBe(false);
    await client.close();
  });

  it("round-trips data through the echo server", async () => {
    const received: string[] = [];
    const client = new TcpClient({
      config: loadClientConfig({
        SERVER_HOST: "127.0.0.1",
        SERVER_PORT: String(freePort),
        AUTH_TOKEN: "client-integration-token",
        CONNECT_TIMEOUT_MS: "2000",
        RECONNECT: "false",
      }),
      onEvent: (e) => {
        if (e.type === "data") received.push(e.payload);
      },
    });
    await client.connect();
    await waitFor(() => client.isReady);

    client.sendData("hello echo");
    client.sendData("second line");
    await waitFor(() => received.length >= 2);
    expect(received).toEqual(["hello echo", "second line"]);
    await client.close();
  });

  it("exchanges ping/pong against the real server", async () => {
    let ponged = false;
    const client = new TcpClient({
      config: loadClientConfig({
        SERVER_HOST: "127.0.0.1",
        SERVER_PORT: String(freePort),
        AUTH_TOKEN: "client-integration-token",
        CONNECT_TIMEOUT_MS: "2000",
        RECONNECT: "false",
      }),
      onEvent: (e) => {
        if (e.type === "pong") ponged = true;
      },
    });
    await client.connect();
    await waitFor(() => client.isReady);
    client.ping();
    await waitFor(() => ponged);
    expect(ponged).toBe(true);
    await client.close();
  });

  it("reconnects when the server restarts", async () => {
    const events: string[] = [];
    const client = new TcpClient({
      config: loadClientConfig({
        SERVER_HOST: "127.0.0.1",
        SERVER_PORT: String(freePort),
        AUTH_TOKEN: "client-integration-token",
        CONNECT_TIMEOUT_MS: "2000",
        RECONNECT: "true",
        RECONNECT_DELAY_MS: "30",
        MAX_RECONNECT_ATTEMPTS: "5",
      }),
      onEvent: (e) => events.push(e.type),
    });
    await client.connect();
    await waitFor(() => client.isReady);

    // Stop the server; the client should notice and attempt to reconnect.
    await server.close();
    // Restart it on the same port.
    server = await startServer(freePort);

    await waitFor(() => events.filter((e) => e === "connected").length >= 2);
    expect(events).toContain("reconnecting");
    await waitFor(() => client.isReady);
    expect(client.isReady).toBe(true);
    await client.close();
  });
});
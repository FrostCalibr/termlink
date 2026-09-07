import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, connect, type Server, type Socket } from "node:net";
import { TcpClient } from "../src/transport.js";
import { loadClientConfig } from "../src/config.js";
import {
  FrameDecoder,
  encodeFrame,
  type Message,
} from "../../shared/protocol/framing.js";

/**
 * Test harness: a controllable TCP peer that implements the server side of
 * the protocol well enough to exercise the client transport.
 */
class FakeServer {
  server: Server;
  port = 0;
  connections: Socket[] = [];
  private decoder = new FrameDecoder(1024 * 1024);

  constructor(options?: {
    onAuthRequest?: (socket: Socket, msg: unknown) => void;
    onMessage?: (socket: Socket, msg: Message) => void;
    greet?: boolean;
  }) {
    const greet = options?.greet ?? true;
    this.server = createServer((socket) => {
      this.connections.push(socket);
      if (greet) {
        socket.write(
          encodeFrame({ type: "hello", version: 1, auth_methods: ["token", "password"] }),
        );
      }
      socket.on("data", (chunk) => {
        this.decoder.feed(chunk);
        let msg: Message | null;
        while ((msg = this.decoder.read())) {
          options?.onMessage?.(socket, msg);
        }
      });
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

  sendToAll(msg: Message): void {
    const frame = encodeFrame(msg);
    for (const s of [...this.connections]) {
      s.write(frame);
    }
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      for (const s of this.connections) s.destroy();
      this.connections = [];
      this.server.close(() => resolve());
    });
  }
}

function testConfig(overrides: Record<string, string> = {}): ReturnType<typeof loadClientConfig> {
  return loadClientConfig({
    SERVER_HOST: "127.0.0.1",
    SERVER_PORT: String(0), // filled in per-test
    AUTH_TOKEN: "tok",
    CONNECT_TIMEOUT_MS: "2000",
    IDLE_TIMEOUT_MS: "5000",
    RECONNECT: "false",
    MAX_RECONNECT_ATTEMPTS: "2",
    RECONNECT_DELAY_MS: "50",
    ...overrides,
  });
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("TcpClient transport", () => {
  let server: FakeServer;
  let received: Message[];

  beforeEach(async () => {
    server = new FakeServer({
      onMessage: (_s, msg) => received.push(msg),
    });
    await server.listen();
    received = [];
  });

  afterEach(async () => {
    await server.close();
  });

  it("connects, authenticates, and reaches ready", async () => {
    const client = new TcpClient({
      config: { ...testConfig(), port: server.port },
    });

    // After connect, server sees auth_request
    await client.connect();
    await waitFor(() => received.length > 0);
    expect(received[0]).toMatchObject({ type: "auth_request", method: "token" });

    // Server replies, client becomes ready
    server.sendToAll({ type: "auth_ok", session_id: "s1" });
    await waitFor(() => client.isReady);
    expect(client.isReady).toBe(true);
    await client.close();
  });

  it("delivers data frames from the server", async () => {
    const dataEvents: string[] = [];
    const client = new TcpClient({
      config: { ...testConfig(), port: server.port },
      onEvent: (e) => {
        if (e.type === "data") dataEvents.push(e.payload);
      },
    });
    await client.connect();
    server.sendToAll({ type: "auth_ok", session_id: "s1" });
    await waitFor(() => client.isReady);
    server.sendToAll({ type: "data", data: "hello from server" });
    await waitFor(() => dataEvents.length > 0);
    expect(dataEvents).toEqual(["hello from server"]);
    await client.close();
  });

  it("handles data split across multiple reads", async () => {
    const dataEvents: string[] = [];
    const client = new TcpClient({
      config: { ...testConfig(), port: server.port },
      onEvent: (e) => {
        if (e.type === "data") dataEvents.push(e.payload);
      },
    });
    await client.connect();
    server.sendToAll({ type: "auth_ok", session_id: "s1" });
    await waitFor(() => client.isReady);

    // Send one frame in two TCP writes.
    const frame = encodeFrame({ type: "data", data: "chunked" });
    const mid = Math.floor(frame.length / 2);
    const conn = server.connections[0];
    conn.write(frame.subarray(0, mid));
    await new Promise((r) => setTimeout(r, 10));
    conn.write(frame.subarray(mid));
    await waitFor(() => dataEvents.length > 0);
    expect(dataEvents[0]).toBe("chunked");
    await client.close();
  });

  it("detects a server disconnect", async () => {
    const events: string[] = [];
    const client = new TcpClient({
      config: { ...testConfig({ RECONNECT: "false" }), port: server.port },
      onEvent: (e) => events.push(e.type),
    });
    await client.connect();
    server.sendToAll({ type: "auth_ok", session_id: "s1" });
    await waitFor(() => client.isReady);

    // Server drops the connection.
    server.connections[0].destroy();
    await waitFor(() => events.includes("disconnected"));
    expect(events).toContain("disconnected");
    await client.close();
  });

  it("reconnects after the server drops the connection", async () => {
    const events: string[] = [];
    const client = new TcpClient({
      config: {
        ...testConfig({ RECONNECT: "true", MAX_RECONNECT_ATTEMPTS: "3", RECONNECT_DELAY_MS: "30" }),
        port: server.port,
      },
      onEvent: (e) => events.push(e.type),
    });
    await client.connect();
    server.sendToAll({ type: "auth_ok", session_id: "s1" });
    await waitFor(() => client.isReady);

    // Drop; then client reconnects and re-authenticates.
    server.connections[0].destroy();
    await waitFor(() => events.includes("reconnecting"));
    await waitFor(() => events.filter((e) => e === "connected").length >= 2);
    expect(events).toContain("disconnected");
    await client.close();
  });

  it("gives up after max reconnect attempts", async () => {
    const events: string[] = [];
    const client = new TcpClient({
      config: {
        ...testConfig({ RECONNECT: "true", MAX_RECONNECT_ATTEMPTS: "2", RECONNECT_DELAY_MS: "10" }),
        port: server.port,
      },
      onEvent: (e) => events.push(e.type),
    });
    await client.connect();
    server.sendToAll({ type: "auth_ok", session_id: "s1" });
    await waitFor(() => client.isReady);

    // Drop the connection AND stop listening so reconnects are refused.
    const conn = server.connections[0];
    conn.destroy();
    await server.close();
    await waitFor(() => events.includes("reconnect_failed"));
    expect(events).toContain("reconnect_failed");
  });

  it("rejects without a goodbye when credentials are invalid", async () => {
    const fs = new FakeServer({
      onMessage: (socket, msg) => {
        if (msg.type === "auth_request") {
          socket.write(encodeFrame({ type: "auth_fail", reason: "bad token" }));
        }
      },
    });
    await fs.listen();
    const events: string[] = [];
    const client = new TcpClient({
      config: {
        ...testConfig({ RECONNECT: "false" }),
        port: fs.port,
      },
      onEvent: (e) => events.push(e.type),
    });
    await client.connect();
    await waitFor(() => events.includes("auth_failed"));
    expect(events).toContain("auth_failed");
    await client.close();
  });

  it("buffers data sent before authentication and flushes after ready", async () => {
    const client = new TcpClient({
      config: { ...testConfig(), port: server.port },
    });
    const connectPromise = client.connect();
    // Wait for the actual TCP connection and hello round-trip before auth_ok.
    await waitFor(() => received.some((m) => m.type === "auth_request"));
    // Send before auth completes (queued).
    client.sendData("early");
    server.sendToAll({ type: "auth_ok", session_id: "s1" });
    await waitFor(() => client.isReady);
    await connectPromise;
    await waitFor(() => received.some((m) => m.type === "data"));
    expect(
      received.find((m) => m.type === "data" && (m as { data: string }).data === "early"),
    ).toBeTruthy();
    await client.close();
  });
});
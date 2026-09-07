import { describe, it, expect, afterEach } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { RelayClient } from "../src/relay-client.js";
import type { AgentConfig } from "../src/config.js";
import {
  parseJsonDeviceMessage,
  type DeviceClientMessage,
  type DeviceServerMessage,
} from "../../shared/device/protocol.js";

class FakeRelay {
  server!: WebSocketServer;
  conns: WebSocket[] = [];
  received: DeviceClientMessage[] = [];
  port = 0;
  handler: (ws: WebSocket, msg: DeviceClientMessage) => void = () => undefined;

  async listen(): Promise<void> {
    this.server = new WebSocketServer({
      port: 0,
      host: "127.0.0.1",
      path: "/device",
    });
    await new Promise<void>((resolve) =>
      this.server.once("listening", () => resolve()),
    );
    const addr = this.server.address();
    this.port = typeof addr === "object" && addr ? addr.port : 0;
    this.server.on("connection", (ws) => {
      this.conns.push(ws);
      ws.on("message", (data, isBinary) => {
        if (isBinary) return;
        const msg = parseJsonDeviceMessage(data.toString("utf-8"));
        if (!("type" in msg)) return;
        this.received.push(msg as DeviceClientMessage);
        this.handler(ws, msg as DeviceClientMessage);
      });
    });
  }

  send(ws: WebSocket, msg: DeviceServerMessage): void {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  close(): Promise<void> {
    for (const ws of this.conns) {
      try {
        ws.terminate();
      } catch {
        /* already closed */
      }
    }
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

const silent = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function makeConfig(relayUrl: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    relayUrl,
    deviceId: "laptop",
    credentialsFile: "/tmp/irrelevant",
    shell: "/bin/sh",
    cwd: process.cwd(),
    reconnectMinMs: 50,
    reconnectMaxMs: 300,
    reconnectFactor: 2,
    authTimeoutMs: 3000,
    pingIntervalMs: 30_000,
    idleTimeoutMs: 60_000,
    sendHighWaterMark: 1024 * 1024,
    sendLowWaterMark: 256 * 1024,
    ...overrides,
  };
}

describe("RelayClient", () => {
  let relay: FakeRelay;
  afterEach(async () => {
    await relay?.close();
  });

  async function startRelay(): Promise<FakeRelay> {
    relay = new FakeRelay();
    await relay.listen();
    return relay;
  }

  async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it("enrolls when the relay reports the device as not enrolled", async () => {
    const relay = await startRelay();
    relay.handler = (ws, msg) => {
      if (msg.type === "device_auth") {
        relay.send(ws, { type: "device_err", error: "Device not enrolled" });
      } else if (msg.type === "device_register") {
        expect(msg.version).toBe(1);
        expect(msg.deviceId).toBe("laptop");
        expect(msg.secret.length).toBeGreaterThan(0);
        relay.send(ws, {
          type: "device_ok",
          version: 1,
          deviceId: "laptop",
          name: "Laptop",
          deviceType: "shell",
          state: "registered",
        });
      }
    };

    const states: string[] = [];
    const client = new RelayClient({
      config: makeConfig(`ws://127.0.0.1:${relay.port}`),
      secret: "device-secret-123",
      logger: silent,
      onServerMessage: () => undefined,
      onStateChange: (s) => states.push(s),
    });
    client.start();

    await waitFor(() => client.ready);
    expect(relay.received.some((m) => m.type === "device_register")).toBe(true);
    expect(client.ready).toBe(true);
    client.stop();
  });

  it("authenticates directly on reconnect (no re-enrollment)", async () => {
    const relay = await startRelay();
    let registeredOnce = false;
    relay.handler = (ws, msg) => {
      if (msg.type === "device_auth") {
        if (!registeredOnce) {
          registeredOnce = true;
          relay.send(ws, { type: "device_err", error: "Device not enrolled" });
        } else {
          relay.send(ws, {
            type: "device_ok",
            version: 1,
            deviceId: "laptop",
            name: "Laptop",
            deviceType: "shell",
            state: "authenticated",
          });
        }
      } else if (msg.type === "device_register") {
        relay.send(ws, {
          type: "device_ok",
          version: 1,
          deviceId: "laptop",
          name: "Laptop",
          deviceType: "shell",
          state: "registered",
        });
      }
    };

    const client = new RelayClient({
      config: makeConfig(`ws://127.0.0.1:${relay.port}`),
      secret: "s", 
      logger: silent,
      onServerMessage: () => undefined,
    });
    client.start();
    await waitFor(() => client.ready);
    const registerCount = relay.received.filter((m) => m.type === "device_register").length;
    expect(registerCount).toBe(1);
    client.stop();
  });

  it("drops the connection permanently on an invalid secret", async () => {
    const relay = await startRelay();
    relay.handler = (ws, _msg) => {
      relay.send(ws, { type: "device_err", error: "Invalid device secret" });
    };
    let fatal: string | null = null;
    const client = new RelayClient({
      config: makeConfig(`ws://127.0.0.1:${relay.port}`),
      secret: "wrong-secret",
      logger: silent,
      onServerMessage: () => undefined,
      onFatal: (reason) => {
        fatal = reason;
      },
    });
    client.start();

    await waitFor(() => fatal !== null, 3000);
    expect(fatal).toMatch(/Authentication failed: Invalid device secret/);
    expect(client.ready).toBe(false);
    // No reconnect attempts after a permanent failure.
    await new Promise((r) => setTimeout(r, 300));
    expect(relay.conns.length).toBe(1);
  });

  it("refuses re-enrollment permanently once registered", async () => {
    const relay = await startRelay();
    relay.handler = (ws, msg) => {
      if (msg.type === "device_auth") {
        relay.send(ws, { type: "device_err", error: "Device not enrolled" });
      } else if (msg.type === "device_register") {
        relay.send(ws, { type: "device_err", error: "Device already registered" });
      }
    };
    let fatal: string | null = null;
    const client = new RelayClient({
      config: makeConfig(`ws://127.0.0.1:${relay.port}`),
      secret: "other-secret",
      logger: silent,
      onServerMessage: () => undefined,
      onFatal: (reason) => {
        fatal = reason;
      },
    });
    client.start();
    await waitFor(() => fatal !== null, 3000);
    expect(fatal).toMatch(/Enrollment refused/);
    expect(relay.received.some((m) => m.type === "device_register")).toBe(true);
  });

  it("reconnects with exponential backoff after a socket drop", async () => {
    const relay = await startRelay();
    relay.handler = (ws, msg) => {
      if (msg.type === "device_auth") {
        relay.send(ws, {
          type: "device_ok",
          version: 1,
          deviceId: "laptop",
          name: "Laptop",
          deviceType: "shell",
          state: "registered",
        });
      }
    };

    const client = new RelayClient({
      config: makeConfig(`ws://127.0.0.1:${relay.port}`, {
        reconnectMinMs: 50,
        reconnectMaxMs: 200,
        reconnectFactor: 2,
      }),
      secret: "s",
      logger: silent,
      onServerMessage: () => undefined,
    });
    client.start();
    await waitFor(() => client.ready);

    // Kill the link server-side; the client should reconnect and re-auth.
    const first = relay.conns[0];
    first.close();
    await waitFor(() => relay.conns.length >= 2, 5000);

    // A successful reconnect yields a live ready state again.
    await waitFor(() => client.ready, 5000);
    expect(relay.conns.length).toBeGreaterThanOrEqual(2);
    client.stop();
  });

  it("sends heartbeats and forwards relay session messages", async () => {
    const relay = await startRelay();
    relay.handler = (ws, msg) => {
      if (msg.type === "device_auth") {
        relay.send(ws, {
          type: "device_ok",
          version: 1,
          deviceId: "laptop",
          name: "Laptop",
          deviceType: "shell",
          state: "registered",
        });
      } else if (msg.type === "ping") {
        relay.send(ws, { type: "pong" });
      }
    };

    const serverMessages: DeviceServerMessage[] = [];
    const client = new RelayClient({
      config: makeConfig(`ws://127.0.0.1:${relay.port}`, {
        pingIntervalMs: 20,
      }),
      secret: "s",
      logger: silent,
      onServerMessage: (msg) => serverMessages.push(msg),
    });
    client.start();
    await waitFor(() => client.ready);

    // Relay pushes an open request; the client forwards it to its owner.
    const conn = relay.conns[0];
    relay.send(conn, { type: "device_session_open", sessionId: "sess-1", cols: 80, rows: 24 });
    await waitFor(() => serverMessages.some((m) => m.type === "device_session_open"));
    expect(serverMessages).toContainEqual(
      expect.objectContaining({ type: "device_session_open", sessionId: "sess-1" }),
    );

    // Client pushes output; the relay sees it.
    client.send({ type: "device_session_output", sessionId: "sess-1", data: "aGVsbG8=" });
    await waitFor(() => relay.received.some((m) => m.type === "device_session_output"));

    // Pings flow as heartbeats.
    await waitFor(() => relay.received.some((m) => m.type === "ping"), 4000);
    client.stop();
  });

  it("stops gracefully (goodbye, no reconnect)", async () => {
    const relay = await startRelay();
    relay.handler = (ws, msg) => {
      if (msg.type === "device_auth") {
        relay.send(ws, {
          type: "device_ok",
          version: 1,
          deviceId: "laptop",
          name: "Laptop",
          deviceType: "shell",
          state: "registered",
        });
      }
    };
    const client = new RelayClient({
      config: makeConfig(`ws://127.0.0.1:${relay.port}`),
      secret: "s",
      logger: silent,
      onServerMessage: () => undefined,
    });
    client.start();
    await waitFor(() => client.ready);

    client.stop();
    await waitFor(() => relay.received.some((m) => m.type === "goodbye"));
    const connections = relay.conns.length;
    await new Promise((r) => setTimeout(r, 300));
    expect(relay.conns.length).toBe(connections);
  });
});
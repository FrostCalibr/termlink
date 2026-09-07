import { describe, it, expect, afterEach } from "vitest";
import { WebSocketServer, WebSocket, type AddressInfo } from "ws";
import { WebTransport, type WebTransportEvent } from "../src/transport.js";
import { RelayServer } from "../../relay/src/relay.js";
import { loadConfig } from "../../server/src/config.js";
import { loadRelayConfig } from "../../relay/src/config.js";
import { TcpServer } from "../../server/src/server.js";

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const wssList: WebSocketServer[] = [];
const clientSockets: WebSocket[] = [];
const relays: RelayServer[] = [];
const backends: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  for (const s of clientSockets.splice(0)) s.terminate();
  for (const w of wssList.splice(0)) await new Promise((r) => w.close(() => r()));
  for (const b of backends.splice(0)) await b.close().catch(() => undefined);
  for (const r of relays.splice(0)) await r.close().catch(() => undefined);
});

async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Scripted WebSocket server with a per-connection handler. */
function startServer(): Promise<{ wss: WebSocketServer; port: number }> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    wssList.push(wss);
    wss.on("listening", () => {
      const port = (wss.address() as AddressInfo).port;
      resolve({ wss, port });
    });
  });
}

/** A server that answers the token handshake and echoes text + binary. */
function echoHandler(timeoutMs = 0): (sock: WebSocket) => void {
  return (sock) => {
    clientSockets.push(sock);
    const reply = (payload: unknown): void =>
      setTimeout(
        () => sock.send(JSON.stringify(payload)),
        timeoutMs,
      );
    sock.send(
      JSON.stringify({ type: "hello", version: 1, auth_methods: ["token"] }),
    );
    sock.on("message", (data, isBinary) => {
      if (isBinary) {
        reply({ type: "binary", data: (data as Buffer).toString("base64") });
        return;
      }
      const msg = JSON.parse(String(data));
      if (msg.type === "auth_request") {
        sock.send(JSON.stringify({ type: "auth_ok", session_id: "sess-1" }));
      } else if (msg.type === "data") {
        reply({ type: "data", data: msg.data });
      } else if (msg.type === "ping") {
        sock.send(JSON.stringify({ type: "pong" }));
      }
    });
  };
}

function makeTransport(
  url: string,
  events: WebTransportEvent[],
  opts: Record<string, unknown> = {},
): WebTransport {
  const t = new WebTransport({
    url,
    token: "relaytok",
    reconnect: false,
    ...opts,
    onEvent: (e) => events.push(e),
  });
  t.connect();
  return t;
}

function findEvent<T extends WebTransportEvent["type"]>(
  events: WebTransportEvent[],
  type: T,
): Extract<WebTransportEvent, { type: T }> | undefined {
  return events.find((e) => e.type === type) as
    | Extract<WebTransportEvent, { type: T }>
    | undefined;
}

describe("WebTransport", () => {
  it("authenticates and becomes ready against a scripted server", async () => {
    const { wss, port } = await startServer();
    wss.on("connection", echoHandler());
    const events: WebTransportEvent[] = [];
    const t = makeTransport(`ws://127.0.0.1:${port}/ws`, events);

    await waitFor(() => events.some((e) => e.type === "ready"));
    expect(findEvent(events, "ready")).toEqual({ type: "ready", sessionId: "sess-1" });
    expect(t.isReady).toBe(true);
    t.close();
  });

  it("round-trips text data through the server", async () => {
    const { wss, port } = await startServer();
    wss.on("connection", echoHandler());
    const events: WebTransportEvent[] = [];
    const t = makeTransport(`ws://127.0.0.1:${port}/ws`, events);
    await waitFor(() => t.isReady);

    expect(t.sendData("hello browser")).toBe(true);
    await waitFor(() =>
      events.some((e) => e.type === "data" && e.payload === "hello browser"),
    );
    expect(findEvent(events, "data")).toEqual({ type: "data", payload: "hello browser" });
    t.close();
  });

  it("sends and receives binary frames as raw payload bytes", async () => {
    const { wss, port } = await startServer();
    wss.on("connection", echoHandler());
    const events: WebTransportEvent[] = [];
    const t = makeTransport(`ws://127.0.0.1:${port}/ws`, events);
    await waitFor(() => t.isReady);

    expect(t.sendBinary(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))).toBe(true);
    await waitFor(() => events.some((e) => e.type === "binary"));
    const bin = findEvent(events, "binary")!;
    expect(new Uint8Array(bin.payload)).toEqual(
      new Uint8Array(Buffer.from([0xde, 0xad, 0xbe, 0xef])),
    );
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(t.isReady).toBe(true);
    t.close();
  });

  it("stops and does not reconnect after auth rejection", async () => {
    const { wss, port } = await startServer();
    wss.on("connection", (sock) => {
      clientSockets.push(sock);
      sock.send(
        JSON.stringify({ type: "hello", version: 1, auth_methods: ["token"] }),
      );
      sock.on("message", () =>
        sock.send(JSON.stringify({ type: "auth_fail", reason: "bad token" })),
      );
    });
    const events: WebTransportEvent[] = [];
    const t = makeTransport(`ws://127.0.0.1:${port}/ws`, events, {
      reconnect: true,
      maxReconnectAttempts: 3,
    });

    await waitFor(() => events.some((e) => e.type === "auth_failed"));
    await new Promise((r) => setTimeout(r, 400));
    expect(findEvent(events, "reconnect_failed")).toBeUndefined();
    expect(events.filter((e) => e.type === "connecting").length).toBe(1);
    t.destroy();
  });

  it("reconnects with bounded backoff and gives up after the attempt cap", async () => {
    const { wss, port } = await startServer();
    wss.on("connection", (sock) => {
      clientSockets.push(sock);
      sock.close(1001, "server reset"); // close every connection immediately
    });
    const events: WebTransportEvent[] = [];
    makeTransport(`ws://127.0.0.1:${port}/ws`, events, {
      reconnect: true,
      maxReconnectAttempts: 2,
      reconnectBaseDelayMs: 50,
      reconnectMaxDelayMs: 200,
    });

    await waitFor(() => events.some((e) => e.type === "reconnect_failed"));
    const attempts = events.filter((e) => e.type === "connecting");
    expect(attempts.length).toBeGreaterThanOrEqual(1);
    expect(events.filter((e) => e.type === "closed").length).toBeGreaterThan(0);
  });

  it("cleans up on goodbye without reconnecting", async () => {
    const { wss, port } = await startServer();
    wss.on("connection", echoHandler());
    const events: WebTransportEvent[] = [];
    const t = makeTransport(`ws://127.0.0.1:${port}/ws`, events, {
      reconnect: true,
      maxReconnectAttempts: 3,
    });
    await waitFor(() => t.isReady);

    const serverSock = clientSockets.at(-1)!;
    serverSock.send(JSON.stringify({ type: "goodbye", reason: "maintenance" }));
    await waitFor(() => events.some((e) => e.type === "goodbye"));
    expect(findEvent(events, "goodbye")).toEqual({
      type: "goodbye",
      reason: "maintenance",
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(findEvent(events, "reconnect_failed")).toBeUndefined();
    t.destroy();
  });

  it("rejects out-of-order server messages", async () => {
    const { wss, port } = await startServer();
    wss.on("connection", (sock) => {
      clientSockets.push(sock);
      // Data before hello violates the protocol state machine.
      sock.send(JSON.stringify({ type: "data", data: "too early" }));
    });
    const events: WebTransportEvent[] = [];
    const t = makeTransport(`ws://127.0.0.1:${port}/ws`, events);

    await waitFor(() =>
      events.some((e) => e.type === "error" && e.message.includes("unexpected data")),
    );
    expect(t.isReady).toBe(false);
    t.destroy();
  });

  it("round-trips browser-style WebTransport through the real relay and echo backend", async () => {
    // Real TCP backend — websocket → relay → TCP echo → relay → websocket.
    const backend = new TcpServer({
      config: loadConfig({
        HOST: "127.0.0.1",
        PORT: "0",
        AUTH_TOKENS: "backendtok",
        ECHO_DATA: "true",
      }),
      logger: silentLogger,
    });
    await backend.listen();
    backends.push(backend);

    const relay = new RelayServer({
      config: loadRelayConfig({
        RELAY_HOST: "127.0.0.1",
        RELAY_PORT: "0",
        WS_ENABLED: "true",
        WS_PORT: "0",
        AUTH_TOKENS: "relaytok",
        TARGETS: `pty=backendtok@127.0.0.1:${backend.port}`,
      }),
      logger: silentLogger,
    });
    await relay.listen();
    relays.push(relay);

    const events: WebTransportEvent[] = [];
    const t = makeTransport(`ws://127.0.0.1:${relay.wsPort}/ws`, events, {
      reconnect: false,
    });

    await waitFor(() => events.some((e) => e.type === "ready"));
    expect(t.isReady).toBe(true);
    expect(relay.connectionCount).toBe(1);

    t.sendData("hello world via websocket");
    await waitFor(() =>
      events.some((e) => e.type === "data" && e.payload === "hello world via websocket"),
    );

    t.sendBinary(new Uint8Array([1, 2, 3, 4]));
    await waitFor(() => events.some((e) => e.type === "binary"));
    const bin = findEvent(events, "binary")!;
    expect(new Uint8Array(bin.payload)).toEqual(new Uint8Array([1, 2, 3, 4]));

    t.close();
    await waitFor(() => relay.sessionCount === 0);
  });

  it("runs a live interactive shell: browser → WebSocket → relay → TCP → PTY", async () => {
    // Real PTY backend (not an echo): exercises the full Phase 5 path.
    const backend = new TcpServer({
      config: loadConfig({
        HOST: "127.0.0.1",
        PORT: "0",
        MAX_FRAME_SIZE: "65536",
        IDLE_TIMEOUT_MS: "10000",
        AUTH_TOKENS: "backendtok",
        PTY_ENABLED: "true",
        PTY_SHELL: "/bin/sh",
        PTY_COLS: "80",
        PTY_ROWS: "24",
        PTY_CWD: process.env.HOME ?? process.cwd(),
      }),
      logger: silentLogger,
    });
    await backend.listen();
    backends.push(backend);

    const relay = new RelayServer({
      config: loadRelayConfig({
        RELAY_HOST: "127.0.0.1",
        RELAY_PORT: "0",
        WS_ENABLED: "true",
        WS_PORT: "0",
        AUTH_TOKENS: "relaytok",
        TARGETS: `pty=backendtok@127.0.0.1:${backend.port}`,
      }),
      logger: silentLogger,
    });
    await relay.listen();
    relays.push(relay);

    const events: WebTransportEvent[] = [];
    const t = makeTransport(`ws://127.0.0.1:${relay.wsPort}/ws`, events, {
      reconnect: false,
    });
    await waitFor(() => events.some((e) => e.type === "ready"));

    // Type a command into the remote shell through the browser.
    const typed = Buffer.from("printf 'WEBPTY-MARKER-42'\n").toString("base64");
    t.sendTerminalInput(new Uint8Array(Buffer.from(typed, "base64")));
    await waitFor(() =>
      events.some(
        (e) =>
          e.type === "terminal_output" &&
          Buffer.from(new Uint8Array(e.payload)).toString("latin1").includes("WEBPTY-MARKER-42"),
      ),
    );

    // Resize propagates to the live PTY: `stty size` must report 100x50.
    t.sendTerminalResize(100, 50);
    t.sendTerminalInput(new Uint8Array(Buffer.from("stty size\n")));
    await waitFor(() =>
      events.some(
        (e) =>
          e.type === "terminal_output" &&
          Buffer.from(new Uint8Array(e.payload)).toString("latin1").includes("50 100"),
      ),
    );

    // Closing the browser kills the remote shell (no orphan, no duplicate).
    t.close();
    await waitFor(() => relay.sessionCount === 0);
    await waitFor(() => backend.ptyCount === 0);
  });
});
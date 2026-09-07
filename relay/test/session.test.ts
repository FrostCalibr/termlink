import { describe, it, expect } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import {
  FrameDecoder,
  encodeFrame,
  type Message,
} from "../../shared/protocol/framing.js";
import {
  RelaySession,
  type RelayClient,
} from "../src/session.js";

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Fake RelayClient: records what the bridge forwards and simulates terminal
 * behavior, so the bridge logic is testable without a full relay server.
 */
class MockClient implements RelayClient {
  connectionId = "mock-conn";
  forwarded: Message[] = [];
  paused = 0;
  resumed = 0;
  terminatedWith: string | undefined;
  blocked = false;

  forward(msg: Message): boolean {
    this.forwarded.push(msg);
    return !this.blocked;
  }

  pause(): void {
    this.paused++;
  }

  resume(): void {
    this.resumed++;
  }

  terminate(reason?: string): void {
    this.terminatedWith = reason ?? "default";
  }
}

/**
 * A controllable backend implementing the server side of the protocol:
 * greets, authenticates (optionally delayed or failed), and echoes data and
 * binary frames back.
 */
class FakeBackend {
  server: Server;
  port = 0;
  connections: Socket[] = [];
  received: Message[] = [];
  authDelayMs = 0;
  replyAuthFail = false;
  echo = true;
  private decoder = new FrameDecoder(1024 * 1024);

  constructor() {
    this.server = createServer((socket) => {
      this.connections.push(socket);
      socket.write(
        encodeFrame({
          type: "hello",
          version: 1,
          auth_methods: ["token", "password"],
        }),
      );
      socket.on("data", (chunk) => this.onData(socket, chunk));
    });
  }

  private onData(socket: Socket, chunk: Buffer): void {
    this.decoder.feed(chunk);
    let msg: Message | null;
    while ((msg = this.decoder.read())) {
      this.received.push(msg);
      if (msg.type === "auth_request") {
        const reply: Message = this.replyAuthFail
          ? { type: "auth_fail", reason: "bad creds" }
          : { type: "auth_ok", session_id: "backend-sess" };
        if (this.authDelayMs > 0) {
          setTimeout(() => socket.write(encodeFrame(reply)), this.authDelayMs);
        } else {
          socket.write(encodeFrame(reply));
        }
      } else if (this.echo && (msg.type === "data" || msg.type === "binary")) {
        socket.write(encodeFrame({ type: msg.type, data: msg.data }));
      }
    }
  }

  push(msg: Message): void {
    const frame = encodeFrame(msg);
    for (const s of [...this.connections]) s.write(frame);
  }

  dropConnections(): void {
    for (const s of [...this.connections]) s.destroy();
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
    return new Promise((resolve) => {
      for (const s of [...this.connections]) s.destroy();
      this.connections = [];
      this.server.close(() => resolve());
    });
  }
}

function makeSession(client: MockClient, backend: FakeBackend): RelaySession {
  return new RelaySession({
    client,
    targetHost: "127.0.0.1",
    targetPort: backend.port,
    targetToken: "backendtok",
    connectTimeoutMs: 2000,
    idleTimeoutMs: 5000,
    maxFrameSize: 1024 * 1024,
    logger: silentLogger,
    onClose: () => undefined,
  });
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("RelaySession bridge", () => {
  it("authenticates to the backend and forwards client data once both sides are ready", async () => {
    const backend = new FakeBackend();
    backend.authDelayMs = 200;
    await backend.listen();
    const client = new MockClient();
    const session = makeSession(client, backend);
    session.start();

    // Client sends BEFORE backend ready: must be buffered, not forwarded.
    session.onClientData("early");
    await new Promise((r) => setTimeout(r, 30));
    expect(
      backend.received.some(
        (m) => m.type === "data" && (m as { data: string }).data === "early",
      ),
    ).toBe(false);

    // When the backend reaches ready, the buffered message must flush.
    session.onClientData("after");
    await waitFor(() => backend.received.some((m) => m.type === "auth_request"));
    await waitFor(() =>
      backend.received.some(
        (m) => m.type === "data" && (m as { data: string }).data === "early",
      ),
    );
    expect(
      backend.received.some((m) => m.type === "data" && (m as { data: string }).data === "after"),
    ).toBe(true);

    // Backend echo reaches the client.
    await waitFor(() => {
      const has = (d: string) =>
        client.forwarded.some((m) => m.type === "data" && (m as { data: string }).data === d);
      return has("early") && has("after");
    });
    expect(client.forwarded).toContainEqual({ type: "data", data: "early" });
    expect(client.forwarded).toContainEqual({ type: "data", data: "after" });

    session.terminate();
    await backend.close();
  });

  it("forwards binary payloads through transparently", async () => {
    const backend = new FakeBackend();
    await backend.listen();
    const client = new MockClient();
    const session = makeSession(client, backend);
    session.start();

    session.onClientBinary("AQIDBQ");
    await waitFor(() =>
      backend.received.some(
        (m) => m.type === "binary" && (m as { data: string }).data === "AQIDBQ",
      ),
    );
    await waitFor(() => client.forwarded.some((m) => m.type === "binary"));
    expect(client.forwarded).toContainEqual({ type: "binary", data: "AQIDBQ" });

    session.terminate();
    await backend.close();
  });

  it("forwards terminal_input and terminal_resize to the backend and terminal_output back to the client", async () => {
    const backend = new FakeBackend();
    await backend.listen();
    const client = new MockClient();
    const session = makeSession(client, backend);
    session.start();

    session.onClientTerminalInput("aGVsbG8=");
    session.onClientTerminalResize(140, 40);
    await waitFor(() =>
      backend.received.some(
        (m) => m.type === "terminal_input" && (m as { data: string }).data === "aGVsbG8=",
      ),
    );
    expect(backend.received).toContainEqual({ type: "terminal_resize", cols: 140, rows: 40 });

    backend.push({ type: "terminal_output", data: "b3V0" });
    await waitFor(() => client.forwarded.some((m) => m.type === "terminal_output"));
    expect(client.forwarded).toContainEqual({ type: "terminal_output", data: "b3V0" });

    session.terminate();
    await backend.close();
  });

  it("buffers terminal input sent before the backend is ready and flushes it after", async () => {
    const backend = new FakeBackend();
    backend.authDelayMs = 200;
    await backend.listen();
    const client = new MockClient();
    const session = makeSession(client, backend);
    session.start();

    session.onClientTerminalInput("ZWFybHk=");
    await new Promise((r) => setTimeout(r, 30));
    expect(
      backend.received.some(
        (m) => m.type === "terminal_input" && (m as { data: string }).data === "ZWFybHk=",
      ),
    ).toBe(false);

    await waitFor(() =>
      backend.received.some(
        (m) => m.type === "terminal_input" && (m as { data: string }).data === "ZWFybHk=",
      ),
    );
    session.terminate();
    await backend.close();
  });

  it("terminates the client session when backend authentication fails", async () => {
    const backend = new FakeBackend();
    backend.replyAuthFail = true;
    await backend.listen();
    const client = new MockClient();
    const session = makeSession(client, backend);
    session.start();

    await waitFor(() => client.terminatedWith !== undefined);
    expect(client.terminatedWith).toContain("Backend authentication failed");
    await backend.close();
  });

  it("terminates the client session when the backend disconnects mid-session", async () => {
    const backend = new FakeBackend();
    await backend.listen();
    const client = new MockClient();
    const session = makeSession(client, backend);
    session.start();

    await waitFor(() => backend.received.some((m) => m.type === "auth_request"));
    await new Promise((r) => setTimeout(r, 30));

    backend.dropConnections();
    await waitFor(() => client.terminatedWith !== undefined);
    expect(client.terminatedWith).toContain("Backend connection lost");
    await backend.close();
  });

  it("applies client-side backpressure: pauses the backend until the client drains", async () => {
    const backend = new FakeBackend();
    await backend.listen();
    const client = new MockClient();
    const session = makeSession(client, backend);
    session.start();

    // Wait until the backend session is established.
    await waitFor(() => backend.received.some((m) => m.type === "auth_request"));
    await new Promise((r) => setTimeout(r, 30));

    client.blocked = true;
    backend.push({ type: "data", data: "a" });
    await waitFor(() => client.forwarded.some((m) => m.type === "data"));
    expect(
      client.forwarded.filter((m) => m.type === "data" && (m as { data: string }).data === "a"),
    ).toHaveLength(1);

    // While the client is write-pressured, more backend data must not arrive.
    backend.push({ type: "data", data: "b" });
    await new Promise((r) => setTimeout(r, 50));
    expect(
      client.forwarded.some((m) => m.type === "data" && (m as { data: string }).data === "b"),
    ).toBe(false);

    // Once the client drains, forwarding resumes.
    client.blocked = false;
    session.onClientDrained();
    await waitFor(() =>
      client.forwarded.some((m) => m.type === "data" && (m as { data: string }).data === "b"),
    );
    expect(client.forwarded).toContainEqual({ type: "data", data: "b" });

    session.terminate();
    await backend.close();
  });

  it("terminates when a client floods data before the backend is ready", async () => {
    const backend = new FakeBackend();
    backend.authDelayMs = 60000; // keep the pre-ready window open
    await backend.listen();
    const client = new MockClient();
    const session = makeSession(client, backend);
    session.start();

    // Exceed MAX_PRE_READY_FRAMES (1024) before the backend authenticates.
    for (let i = 0; i < 1025; i++) {
      session.onClientData("x");
    }
    await waitFor(() => client.terminatedWith !== undefined);
    expect(client.terminatedWith).toContain("too much data");

    session.terminate();
    await backend.close();
  });

  it("is idempotent when terminated twice", async () => {
    const backend = new FakeBackend();
    await backend.listen();
    const client = new MockClient();
    const session = makeSession(client, backend);
    session.start();

    session.terminate("first");
    const closeCalls = client.terminatedWith;
    session.terminate("second");
    expect(client.terminatedWith).toBe(closeCalls);
    await backend.close();
  });
});
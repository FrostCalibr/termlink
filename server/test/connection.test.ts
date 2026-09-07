import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { connect, type Socket } from "node:net";
import { TcpServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import {
  FrameDecoder,
  FrameError,
  encodeFrame,
  type Message,
} from "../../shared/protocol/framing.js";

interface TestContext {
  server: TcpServer;
}

function silentLogger() {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

const cfgOptions: Record<string, string> = {
  HOST: "127.0.0.1",
  PORT: "0",
  MAX_FRAME_SIZE: "65536",
  MAX_CONNECTIONS: "10",
  IDLE_TIMEOUT_MS: "5000",
  MAX_AUTH_ATTEMPTS: "3",
  AUTH_BACKOFF_MS: "50",
  AUTH_TOKENS: "correct-horse",
  PASSWORD_USERS: "alice:secret",
};

async function startServer(
  overrides: Record<string, string> = {},
): Promise<TestContext> {
  const config = loadConfig({
    ...cfgOptions,
    ...overrides,
  });
  const server = new TcpServer({ config, logger: silentLogger() });
  await server.listen();
  return { server };
}

function portOf(server: TcpServer): number {
  const addr = (server as unknown as { server: { address(): { port: number } } })
    .server.address();
  return addr!.port;
}

function openConnection(context: TestContext): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ port: portOf(context.server) });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function readNext(socket: Socket): Promise<Message> {
  const decoder = new FrameDecoder(64 * 1024);
  return new Promise((resolve) => {
    socket.on("data", (chunk) => {
      decoder.feed(chunk);
      let msg: Message | null;
      while ((msg = decoder.read())) {
        resolve(msg);
      }
    });
  });
}

async function authenticate(
  socket: Socket,
  body: Record<string, string>,
): Promise<Message> {
  socket.write(encodeFrame({ type: "auth_request", ...body } as never));
  return readNext(socket);
}

describe("TcpServer connection tests", () => {
  let context: TestContext;

  beforeEach(async () => {
    context = await startServer();
  });

  afterEach(async () => {
    await context.server.close();
  });

  it("greets a new connection with hello", async () => {
    const socket = await openConnection(context);
    const msg = await readNext(socket);
    expect(msg).toEqual({
      type: "hello",
      version: 1,
      auth_methods: ["token", "password"],
    });
    socket.end();
  });

  it("authenticates a valid token", async () => {
    const socket = await openConnection(context);
    await readNext(socket); // hello
    socket.write(encodeFrame({ type: "auth_request", method: "token", token: "correct-horse" }));
    const msg = await readNext(socket);
    expect(msg).toMatchObject({ type: "auth_ok", session_id: expect.any(String) });
    socket.end();
  });

  it("rejects an invalid token", async () => {
    const socket = await openConnection(context);
    await readNext(socket);
    socket.write(encodeFrame({ type: "auth_request", method: "token", token: "wrong" }));
    const msg = await readNext(socket);
    expect(msg).toMatchObject({ type: "auth_fail" });
    socket.end();
  });

  it("authenticates a valid password", async () => {
    const socket = await openConnection(context);
    await readNext(socket);
    socket.write(
      encodeFrame({
        type: "auth_request",
        method: "password",
        username: "alice",
        password: "secret",
      }),
    );
    const msg = await readNext(socket);
    expect(msg).toMatchObject({ type: "auth_ok", session_id: expect.any(String) });
    socket.end();
  });

  it("rejects an invalid password", async () => {
    const socket = await openConnection(context);
    await readNext(socket);
    socket.write(
      encodeFrame({
        type: "auth_request",
        method: "password",
        username: "alice",
        password: "nope",
      }),
    );
    const msg = await readNext(socket);
    expect(msg).toMatchObject({ type: "auth_fail" });
    socket.end();
  });

  it("rejects data before authentication", async () => {
    const socket = await openConnection(context);
    await readNext(socket);
    socket.write(encodeFrame({ type: "data", data: "boom" }));
    await expect(
      readNext(socket).then((m) => {
        expect(m).toMatchObject({ type: "goodbye" });
      }),
    ).resolves.toBeUndefined();
    socket.end();
  });

  it("supports multiple concurrent clients", async () => {
    const sockets = await Promise.all(
      Array.from({ length: 5 }, () => openConnection(context)),
    );
    const hellos = await Promise.all(sockets.map((s) => readNext(s)));
    for (const msg of hellos) {
      expect(msg).toMatchObject({ type: "hello" });
    }
    const acks: Message[] = [];
    for (const s of sockets) {
      const p = readNext(s);
      s.write(
        encodeFrame({ type: "auth_request", method: "token", token: "correct-horse" }),
      );
      acks.push(await p);
    }
    for (const ack of acks) expect(ack.type).toBe("auth_ok");
    for (const s of sockets) s.end();
  });

  it("enforces the maximum connection count", async () => {
    const limited = await startServer({ MAX_CONNECTIONS: "2" });
    const sockets = await Promise.all([
      openConnection(limited),
      openConnection(limited),
    ]);
    await Promise.all(sockets.map((s) => readNext(s))); // both get hello
    // Third connection is rejected (server destroys it)
    const third = connect({ port: portOf(limited.server) });
    await new Promise<void>((resolve) => {
      third.on("close", () => resolve());
      third.on("error", () => resolve());
    });
    for (const s of sockets) s.end();
    await limited.server.close();
  });

  it("expires idle connections", async () => {
    const ctx = await startServer({ IDLE_TIMEOUT_MS: "200" });
    const socket = await openConnection(ctx);
    socket.on("data", () => undefined);
    const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()));
    socket.write(
      encodeFrame({ type: "auth_request", method: "token", token: "correct-horse" }),
    );
    await closed;
    await ctx.server.close();
  });

  it("rejects an oversized frame", async () => {
    const ctx = await startServer({ MAX_FRAME_SIZE: "100" });
    const socket = await openConnection(ctx);
    await readNext(socket); // hello
    const header = Buffer.alloc(4);
    header.writeUInt32BE(200, 0);
    socket.write(header);
    const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()));
    await closed;
    await ctx.server.close();
  });

  it("rejects a malformed frame (bad JSON)", async () => {
    const socket = await openConnection(context);
    await readNext(socket);
    const payload = Buffer.from("{not json", "utf-8");
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length, 0);
    socket.write(Buffer.concat([header, payload]));
    await new Promise<void>((resolve) => socket.on("close", () => resolve()));
    socket.end();
  });

  it("rejects a message of an unexpected type", async () => {
    const socket = await openConnection(context);
    await readNext(socket);
    socket.write(encodeFrame({ type: "hello" } as never));
    await new Promise<void>((resolve) => socket.on("close", () => resolve()));
    socket.end();
  });

  it("cleans up sessions when a client disconnects", async () => {
    const socket = await openConnection(context);
    await readNext(socket);
    socket.write(encodeFrame({ type: "auth_request", method: "token", token: "correct-horse" }));
    await readNext(socket);
    expect(context.server.sessionCount).toBe(1);
    socket.end();
    await new Promise<void>((resolve) => socket.on("close", () => resolve()));
    await waitFor(() => context.server.sessionCount === 0);
    expect(context.server.sessionCount).toBe(0);
  });

  it("graceful shutdown closes active connections", async () => {
    const ctx = await startServer();
    const socket = await openConnection(ctx);
    await readNext(socket);
    const goodbye = readNext(socket);
    await ctx.server.close();
    const msg = await goodbye;
    expect(msg).toMatchObject({ type: "goodbye", reason: "Server shutting down" });
    socket.end();
  });
});

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}
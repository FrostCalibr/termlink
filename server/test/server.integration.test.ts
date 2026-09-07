import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { connect, type Socket } from "node:net";
import { TcpServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import {
  encodeFrame,
  FrameDecoder,
  type Message,
} from "../../shared/protocol/framing.js";

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const baseConfig = {
  HOST: "127.0.0.1",
  PORT: "0",
  MAX_FRAME_SIZE: "65536",
  MAX_CONNECTIONS: "10",
  IDLE_TIMEOUT_MS: "5000",
  MAX_AUTH_ATTEMPTS: "3",
  AUTH_BACKOFF_MS: "50",
  AUTH_TOKENS: "integration-token",
  PASSWORD_USERS: "admin:s3cret",
};

describe("full lifecycle integration", () => {
  let server: TcpServer;
  let port: number;

  beforeEach(async () => {
    server = new TcpServer({ config: loadConfig(baseConfig), logger: silentLogger });
    await server.listen();
    port = (server as unknown as { server: { address(): { port: number } } })
      .server.address()!
      .port;
  });

  afterEach(async () => {
    await server.close();
  });

  it("runs the complete connect→hello→auth→data→ping→goodbye flow", async () => {
    const socket = await dial(port);
    try {
      // hello
      const hello = await readMessage(socket);
      expect(hello).toEqual({
        type: "hello",
        version: 1,
        auth_methods: ["token", "password"],
      });

      // auth_request → auth_ok
      socket.write(
        encodeFrame({
          type: "auth_request",
          method: "token",
          token: "integration-token",
        }),
      );
      const authOk = await readMessage(socket);
      expect(authOk.type).toBe("auth_ok");
      const sessionId = (authOk as { session_id: string }).session_id;
      expect(sessionId).toBeTruthy();

      // data (accepted; echoed back is not yet implemented, but must not error)
      socket.write(encodeFrame({ type: "data", data: "hello server" }));
      expect(server.sessionCount).toBe(1);

      // ping → pong
      socket.write(encodeFrame({ type: "ping" }));
      const pong = await readMessage(socket);
      expect(pong).toEqual({ type: "pong" });

      // goodbye → goodbye ack
      socket.write(encodeFrame({ type: "goodbye", reason: "done" }));
      const goodbye = await readMessage(socket);
      expect(goodbye).toMatchObject({ type: "goodbye", reason: "done" });
    } finally {
      socket.destroy();
    }
  });

  it("throttles repeated authentication failures", async () => {
    const socket = await dial(port);
    await readMessage(socket); // hello

    for (let i = 0; i < 3; i++) {
      socket.write(encodeFrame({ type: "auth_request", method: "token", token: "bad" }));
      const fail = await readMessage(socket);
      expect(fail.type).toBe("auth_fail");
    }

    // A 4th attempt is beyond MAX_AUTH_ATTEMPTS and is rejected
    socket.write(encodeFrame({ type: "auth_request", method: "token", token: "bad" }));
    const fourth = await readMessage(socket);
    expect(fourth.type).toBe("auth_fail");

    socket.end();
    await new Promise<void>((resolve) => socket.on("close", () => resolve()));
  });
});

function dial(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ port });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function readMessage(socket: Socket): Promise<Message> {
  const decoder = new FrameDecoder(64 * 1024);
  return new Promise((resolve) => {
    const onData = (chunk: Buffer) => {
      decoder.feed(chunk);
      let msg: Message | null;
      while ((msg = decoder.read())) {
        socket.off("data", onData);
        resolve(msg);
      }
    };
    socket.on("data", onData);
  });
}
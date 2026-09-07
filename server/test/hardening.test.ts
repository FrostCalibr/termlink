import { describe, it, expect, afterEach } from "vitest";
import { connect, type Socket } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { TcpServer } from "../src/server.js";
import { loadConfig, ConfigError } from "../src/config.js";
import { TcpClient } from "../../client/src/transport.js";
import { loadClientConfig } from "../../client/src/config.js";
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

const certPath = (name: string): string =>
  join(process.cwd(), "test", "certs", name);

function makeConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    HOST: "127.0.0.1",
    PORT: "0",
    MAX_FRAME_SIZE: "65536",
    MAX_CONNECTIONS: "10",
    IDLE_TIMEOUT_MS: "5000",
    AUTH_TOKENS: "hardening-token",
    ...overrides,
  });
}

async function dial(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ port });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function readMessage(socket: Socket): Promise<Message> {
  const decoder = new FrameDecoder(1024 * 1024);
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

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const servers: TcpServer[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  while (servers.length) {
    const s = servers.pop()!;
    await s.close().catch(() => undefined);
  }
});

async function startServer(overrides: Record<string, string> = {}): Promise<{
  server: TcpServer;
  port: number;
}> {
  const server = new TcpServer({ config: makeConfig(overrides), logger: silentLogger });
  await server.listen();
  servers.push(server);
  return { server, port: server.port };
}

describe("TCP hardening", () => {
  it("terminates connections that stay unauthenticated past the auth timeout", async () => {
    const { server, port } = await startServer({ AUTH_TIMEOUT_MS: "200" });
    const socket = await dial(port);
    sockets.push(socket);
    const hello = await readMessage(socket);
    expect(hello).toMatchObject({ type: "hello" });

    // Never authenticate; the server must end us with an explicit goodbye.
    const now = Date.now();
    while (Date.now() - now < 3000) {
      const got = await readMessage(socket).catch(() => null);
      if (got) {
        expect(got).toMatchObject({
          type: "goodbye",
          reason: "Authentication timed out",
        });
        break;
      }
    }
    await waitFor(() => socket.destroyed);
    expect(server.connectionCount).toBe(0);
  });

  it("expires authenticated sessions after the session TTL and tears down", async () => {
    const { server, port } = await startServer({ SESSION_TTL_MS: "150" });

    for (let i = 0; i < 2; i++) {
      const socket = await dial(port);
      sockets.push(socket);
      await readMessage(socket); // hello
      socket.write(
        encodeFrame({ type: "auth_request", method: "token", token: "hardening-token" }),
      );
      const authOk = await readMessage(socket);
      expect(authOk.type).toBe("auth_ok");
    }
    expect(server.sessionCount).toBe(2);

    // The 1s prune interval + 150ms TTL must clear both sessions.
    await waitFor(() => server.sessionCount === 0, 5000);
    // Connections already tore down with a "Session expired" goodbye.
    for (const socket of sockets.splice(0)) {
      await waitFor(() => socket.destroyed);
    }
  });

  it("rate-limits authentication attempts globally per client IP", async () => {
    const { server, port } = await startServer({
      MAX_AUTH_ATTEMPTS: "20",
      AUTH_TIMEOUT_MS: "5000",
      AUTH_PER_IP_RATE_LIMIT: "2",
      AUTH_RATE_WINDOW_MS: "60000",
    });
    const socket = await dial(port);
    sockets.push(socket);
    await readMessage(socket); // hello

    // First two attempts pass the limiter...
    for (let i = 0; i < 2; i++) {
      socket.write(
        encodeFrame({ type: "auth_request", method: "token", token: "bad" }),
      );
      const fail = await readMessage(socket);
      expect(fail).toMatchObject({ type: "auth_fail", reason: "Invalid credentials" });
    }
    // ...the third is blocked before verification despite being under
    // MAX_AUTH_ATTEMPTS (20) — the per-IP window is exhausted.
    socket.write(encodeFrame({ type: "auth_request", method: "token", token: "bad" }));
    const third = await readMessage(socket);
    expect(third).toMatchObject({
      type: "auth_fail",
      reason: "Too many authentication attempts; try again later",
    });
    expect(server.sessionCount).toBe(0);
  });

  it("rejects raw TCP frames that exceed the configured frame size", async () => {
    const { port } = await startServer({ MAX_FRAME_SIZE: "1024" });
    const socket = await dial(port);
    sockets.push(socket);
    await readMessage(socket); // hello

    // Craft a header claiming a 4 KB payload; decoder must reject it.
    socket.write(Buffer.concat([
      Buffer.from([0x00, 0x00, 0x10, 0x00]), // 4096-byte payload length
      Buffer.alloc(1024), // just a prefix of the (never-arriving) payload
    ]));

    const goodbye = await readMessage(socket);
    expect(goodbye).toMatchObject({ type: "goodbye" });
    expect((goodbye as Message & { reason?: string }).reason)
      .toMatch(/exceeds maximum/);
    await waitFor(() => socket.destroyed);
  });
});

describe("TCP TLS", () => {
  const tlsEnv = {
    TLS_ENABLED: "true",
    TLS_CERT_FILE: certPath("server-cert.pem"),
    TLS_KEY_FILE: certPath("server-key.pem"),
  };

  it("accepts TLS connections verified with the trusted CA and round-trips data", async () => {
    const { server, port } = await startServer({
      ...tlsEnv,
      ECHO_DATA: "true",
      IDLE_TIMEOUT_MS: "10000",
    });
    expect(server.connectionCount).toBe(0);

    const received: string[] = [];
    const client = new TcpClient({
      config: loadClientConfig({
        SERVER_HOST: "127.0.0.1",
        SERVER_PORT: String(port),
        AUTH_TOKEN: "hardening-token",
        TLS_ENABLED: "true",
        TLS_CA_FILE: certPath("ca-cert.pem"),
        CONNECT_TIMEOUT_MS: "3000",
        RECONNECT: "false",
      }),
      onEvent: (e) => {
        if (e.type === "data") received.push(e.payload);
      },
    });
    await client.connect(); // resolves after the TLS handshake completes
    await waitFor(() => client.isReady);
    client.sendData("over tls");
    await waitFor(() => received.length >= 1);
    expect(received).toEqual(["over tls"]);
    expect(server.sessionCount).toBe(1);
    await client.close();
  });

  it("rejects the client when it does not trust the server CA (self-signed)", async () => {
    const { port } = await startServer({ ...tlsEnv });
    const client = new TcpClient({
      config: loadClientConfig({
        SERVER_HOST: "127.0.0.1",
        SERVER_PORT: String(port),
        AUTH_TOKEN: "hardening-token",
        TLS_ENABLED: "true",
        TLS_CA_FILE: certPath("untrusted-cert.pem"),
        CONNECT_TIMEOUT_MS: "3000",
        RECONNECT: "false",
      }),
    });
    await expect(client.connect()).rejects.toBeTruthy();
    expect(client.isReady).toBe(false);
    await client.close();
  });

  it("rejects a hostname that is not covered by the server certificate", async () => {
    const { port } = await startServer({ ...tlsEnv });
    const client = new TcpClient({
      config: loadClientConfig({
        SERVER_HOST: "127.0.0.1",
        SERVER_PORT: String(port),
        AUTH_TOKEN: "hardening-token",
        TLS_ENABLED: "true",
        TLS_CA_FILE: certPath("ca-cert.pem"),
        TLS_SERVER_NAME: "not-in-san.example",
        CONNECT_TIMEOUT_MS: "3000",
        RECONNECT: "false",
      }),
    });
    await expect(client.connect()).rejects.toBeTruthy();
    await client.close();
  });

  it("rejects plain TCP clients that cannot complete a TLS handshake", async () => {
    const { server, port } = await startServer({ ...tlsEnv });
    const socket = await dial(port);
    sockets.push(socket);
    socket.write("HTTP/1.1 0\r\nnot-a-tls-hello\r\n\r\n");
    await waitFor(() => socket.destroyed);
    // The server must not have accepted the connection or crashed.
    expect(server.connectionCount).toBe(0);
  });

  it("fails configuration cleanly when TLS is enabled without credentials", () => {
    expect(() =>
      makeConfig({ TLS_ENABLED: "true" }),
    ).toThrow(ConfigError);
    expect(() =>
      makeConfig({ TLS_ENABLED: "true" }),
    ).toThrow(/certificate and key/);
  });

  it("accepts a TLS connection using the CA path instead of inline material", async () => {
    const { port } = await startServer({ ...tlsEnv, ECHO_DATA: "true" });
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = tlsConnect({
        host: "127.0.0.1",
        port,
        ca: readFileSync(certPath("ca-cert.pem")),
      });
      s.once("secureConnect", () => resolve(s));
      s.once("error", reject);
    });
    sockets.push(socket);
    await readMessage(socket); // hello
    socket.write(
      encodeFrame({ type: "auth_request", method: "token", token: "hardening-token" }),
    );
    const authOk = await readMessage(socket);
    expect(authOk.type).toBe("auth_ok");
  });
});
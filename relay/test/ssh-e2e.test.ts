import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, join as pathJoin } from "node:fs";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { WebSocket as WsClient } from "ws";
import { TcpServer } from "../../server/src/server.js";
import { loadConfig } from "../../server/src/config.js";
import { RelayServer } from "../src/relay.js";
import { loadRelayConfig, type RelayConfig } from "../src/config.js";
import { startTestSshServer, type TestSshServer } from "../../server/test/helpers/ssh-test-server.js";

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const certPath = (name: string): string => join(process.cwd(), "test", "certs", name);
const pem = (name: string): string => readFileSync(certPath(name), "utf-8");

async function waitFor(cond: () => boolean, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface WsHandle {
  ws: WsClient;
  messages: string[];
  closes: Array<{ code: number; reason: string }>;
}

async function connectWss(port: number, token: string): Promise<WsHandle> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://127.0.0.1:${port}/ws`, {
      ca: pem("ca-cert.pem"),
      rejectUnauthorized: true,
    });
    const messages: string[] = [];
    const closes: Array<{ code: number; reason: string }> = [];
    ws.on("message", (data) => messages.push(String(data)));
    ws.on("close", (code, reason) => closes.push({ code, reason: reason.toString() }));
    ws.on("error", (err) => {
      void err;
    });

    ws.on("open", () => {
      const waitHello = () => {
        if (!messages.some((m) => m.includes('"hello"'))) return false;
        ws.send(JSON.stringify({ type: "auth_request", method: "token", token }));
        return true;
      };
      const poll = setInterval(() => {
        if (messages.some((m) => m.includes('"auth_ok"'))) {
          clearInterval(poll);
          resolve({ ws, messages, closes });
        }
      }, 10);
      const drain = setInterval(() => {
        if (waitHello()) clearInterval(drain);
      }, 10);
      setTimeout(() => {
        clearInterval(poll);
        clearInterval(drain);
        reject(new Error("wss handshake timeout"));
      }, 5000);
    });
  });
}

function terminalHas(messages: string[], needle: string): boolean {
  return terminalDecoded(messages).includes(needle);
}

function terminalDecoded(messages: string[]): string {
  let out = "";
  for (const m of messages) {
    try {
      const parsed = JSON.parse(m) as { type?: string; data?: string };
      if (parsed.type !== "terminal_output") continue;
      out += Buffer.from(parsed.data ?? "", "base64").toString("utf-8");
    } catch {
      /* ignore */
    }
  }
  return out;
}

const relays: RelayServer[] = [];
const servers: Array<{ close: () => Promise<void> }> = [];
const sockets: WsClient[] = [];
const sshds: TestSshServer[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  for (const d of sshds.splice(0)) await d.close().catch(() => undefined);
  while (servers.length) {
    const s = servers.pop()!;
    await s.close().catch(() => undefined);
  }
  while (relays.length) {
    const r = relays.pop()!;
    await r.close().catch(() => undefined);
  }
});

async function startTlsSshBackend(sshd: TestSshServer) {
  const server = new TcpServer({
    config: loadConfig({
      HOST: "127.0.0.1",
      PORT: "0",
      AUTH_TOKENS: "backendtok",
      IDLE_TIMEOUT_MS: "30000",
      TLS_ENABLED: "true",
      TLS_CERT_FILE: certPath("server-cert.pem"),
      TLS_KEY_FILE: certPath("server-key.pem"),
      SSH_ENABLED: "true",
      SSH_HOST: "127.0.0.1",
      SSH_PORT: String(sshd.port),
      SSH_USERNAME: "tester",
      SSH_PASSWORD: "secret",
      SSH_HOST_KEY_FINGERPRINTS: sshd.fingerprint,
    }),
    logger: silentLogger,
  });
  await server.listen();
  servers.push(server);
  return { port: server.port, server };
}

function makeRelayConfig(
  env: Record<string, string>,
  overrides: Partial<RelayConfig> = {},
): RelayConfig {
  return {
    ...loadRelayConfig({
      RELAY_HOST: "127.0.0.1",
      RELAY_PORT: "0",
      AUTH_TOKENS: "relaytok",
      IDLE_TIMEOUT_MS: "30000",
      ...env,
    }),
    ...overrides,
  };
}

describe("relay SSH (WSS front door + TLS relay→backend + SSH remote host)", () => {
  it("round-trips a full browser→WSS→relay→TLS→SSH→remote-shell session", async () => {
    const sshd = await startTestSshServer({ password: "secret" });
    sshds.push(sshd);
    const backend = await startTlsSshBackend(sshd);

    const relay = new RelayServer({
      config: makeRelayConfig(
        {
          WS_ENABLED: "true",
          WS_PORT: "0",
          TARGETS: `pty=backendtok@127.0.0.1:${backend.port}`,
          TLS_ENABLED: "true",
          TLS_CERT_FILE: certPath("server-cert.pem"),
          TLS_KEY_FILE: certPath("server-key.pem"),
          TLS_CA_FILE: certPath("ca-cert.pem"),
        },
        {
          websocket: {
            port: 0,
            host: "127.0.0.1",
            maxConnections: 4,
            maxMessageSize: 1024 * 1024,
            authTimeoutMs: 3000,
            idleTimeoutMs: 30000,
            allowedOrigins: [],
            sendHighWaterMark: 1024 * 1024,
            sendLowWaterMark: 256 * 1024,
            tls: {
              key: pem("server-key.pem"),
              cert: pem("server-cert.pem"),
            },
          },
        },
      ),
      logger: silentLogger,
    });
    await relay.listen();
    relays.push(relay);

    const { ws, messages } = await connectWss(relay.wsPort, "relaytok");
    sockets.push(ws);
    expect(relay.sessionCount).toBe(1);
    await waitFor(() => backend.server.sshCount === 1);
    await waitFor(() => sshd.shells === 1);
    await waitFor(() => terminalHas(messages, "READY"), 15000);

    ws.send(JSON.stringify({ type: "terminal_input", data: Buffer.from("echo SSH-E2E-OK\n").toString("base64") }));
    await waitFor(() => terminalHas(messages, "SSH-E2E-OK"));

    ws.send(JSON.stringify({ type: "terminal_input", data: Buffer.from("<msg>stderr\n").toString("base64") }));
    await waitFor(() => terminalHas(messages, "STDERR-VISIBLE"));

    // Remote channel teardown propagates to the browser client.
    ws.send(JSON.stringify({ type: "terminal_input", data: Buffer.from("<msg>ttyclose\n").toString("base64") }));
    await waitFor(() => messages.some((m) => m.includes('"goodbye"')));
    await waitFor(() => relay.sessionCount === 0);
  }, 20000);

  it("surfaces an SSH host-key failure to the browser as a goodbye", async () => {
    const sshd = await startTestSshServer({ password: "secret" });
    sshds.push(sshd);
    const badFingerprint = Buffer.alloc(32, 9).toString("base64");
    const server = new TcpServer({
      config: loadConfig({
        HOST: "127.0.0.1",
        PORT: "0",
        AUTH_TOKENS: "backendtok",
        IDLE_TIMEOUT_MS: "30000",
        TLS_ENABLED: "true",
        TLS_CERT_FILE: certPath("server-cert.pem"),
        TLS_KEY_FILE: certPath("server-key.pem"),
        SSH_ENABLED: "true",
        SSH_HOST: "127.0.0.1",
        SSH_PORT: String(sshd.port),
        SSH_USERNAME: "tester",
        SSH_PASSWORD: "secret",
        // Wrong fingerprint: the relay sees the goodbye on connect.
        SSH_HOST_KEY_FINGERPRINTS: badFingerprint,
      }),
      logger: silentLogger,
    });
    await server.listen();
    servers.push(server);

    const relay = new RelayServer({
      config: makeRelayConfig(
        {
          WS_ENABLED: "true",
          WS_PORT: "0",
          TARGETS: `pty=backendtok@127.0.0.1:${server.port}`,
          TLS_ENABLED: "true",
          TLS_CERT_FILE: certPath("server-cert.pem"),
          TLS_KEY_FILE: certPath("server-key.pem"),
          TLS_CA_FILE: certPath("ca-cert.pem"),
        },
        {
          websocket: {
            port: 0,
            host: "127.0.0.1",
            maxConnections: 4,
            maxMessageSize: 1024 * 1024,
            authTimeoutMs: 3000,
            idleTimeoutMs: 30000,
            allowedOrigins: [],
            sendHighWaterMark: 1024 * 1024,
            sendLowWaterMark: 256 * 1024,
            tls: {
              key: pem("server-key.pem"),
              cert: pem("server-cert.pem"),
            },
          },
        },
      ),
      logger: silentLogger,
    });
    await relay.listen();
    relays.push(relay);

    const { ws, messages } = await connectWss(relay.wsPort, "relaytok");
    sockets.push(ws);
    await waitFor(() => messages.some((m) => m.includes("SSH host key verification failed")));
    await waitFor(() => relay.sessionCount === 0);
  }, 20000);
});
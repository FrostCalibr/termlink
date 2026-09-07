import { describe, it, expect, afterEach } from "vitest";
import { request } from "node:https";
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { WebSocket as WsClient } from "ws";
import { TcpServer } from "../../server/src/server.js";
import { loadConfig } from "../../server/src/config.js";
import { RelayServer } from "../src/relay.js";
import { loadRelayConfig, type RelayConfig } from "../src/config.js";

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const certPath = (name: string): string =>
  join(process.cwd(), "test", "certs", name);

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

/** Connect to a WSS front door trusting our test CA. */
async function connectWss(
  port: number,
  token: string,
): Promise<WsHandle> {
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
      // Ignore handshake errors; surface via open/close state where relevant.
      void err;
    });

    ws.on("open", () => {
      const waitHello = () => {
        if (!messages.some((m) => m.includes('"hello"'))) return false;
        ws.send(
          JSON.stringify({ type: "auth_request", method: "token", token }),
        );
        return true;
      };
      const poll = setInterval(() => {
        if (messages.some((m) => m.includes('"auth_ok"'))) {
          clearInterval(poll);
          resolve({ ws, messages, closes });
        }
      }, 10);
      // Ensure the hello was seen and auth sent before polling for auth_ok.
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

const relays: RelayServer[] = [];
const servers: Array<{ close: () => Promise<void> }> = [];
const sockets: WsClient[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  while (servers.length) {
    const s = servers.pop()!;
    await s.close().catch(() => undefined);
  }
  while (relays.length) {
    const r = relays.pop()!;
    await r.close().catch(() => undefined);
  }
});

/** A TLS backend with a real PTY (shell), greeting like a PTY server. */
async function startTlsPtyBackend() {
  const server = new TcpServer({
    config: loadConfig({
      HOST: "127.0.0.1",
      PORT: "0",
      AUTH_TOKENS: "backendtok",
      IDLE_TIMEOUT_MS: "30000",
      TLS_ENABLED: "true",
      TLS_CERT_FILE: certPath("server-cert.pem"),
      TLS_KEY_FILE: certPath("server-key.pem"),
      PTY_ENABLED: "true",
      PTY_SHELL: "/bin/sh",
      PTY_COLS: "80",
      PTY_ROWS: "24",
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

describe("relay TLS (WSS front door + TLS relay→backend)", () => {
  it("round-trips a full browser→WSS→relay→TLS→PTY shell session", async () => {
    const backend = await startTlsPtyBackend();

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
    // The relay's backend half must connect and spawn the PTY on the TLS
    // backend shortly after the relay session starts.
    await waitFor(() => backend.server.ptyCount === 1);

    // Drive the shell through the encrypted path end to end.
    const echo = Buffer.from("echo TLS-PATH-OK\n").toString("base64");
    ws.send(JSON.stringify({ type: "terminal_input", data: echo }));
    // terminal_output frames carry base64 payloads; decode before matching.
    await waitFor(() =>
      messages.some((m) => {
        try {
          const parsed = JSON.parse(m) as { type?: string; data?: string };
          if (parsed.type !== "terminal_output") return false;
          return Buffer.from(parsed.data ?? "", "base64")
            .toString("utf-8")
            .includes("TLS-PATH-OK");
        } catch {
          return false;
        }
      }),
    );

    // Clean shutdown of the shell.
    ws.send(JSON.stringify({ type: "terminal_input", data: Buffer.from("exit\n").toString("base64") }));
    await waitFor(() => relays[0].sessionCount === 0, 10000);
  });

  it("rejects relay→backend connections when the relay does not trust the backend CA", async () => {
    const backend = await startTlsPtyBackend();

    const relay = new RelayServer({
      config: makeRelayConfig(
        {
          WS_ENABLED: "true",
          WS_PORT: "0",
          TARGETS: `pty=backendtok@127.0.0.1:${backend.port}`,
          TLS_ENABLED: "true",
          TLS_CERT_FILE: certPath("server-cert.pem"),
          TLS_KEY_FILE: certPath("server-key.pem"),
          // Wrong CA: relay will not trust the backend's certificate.
          TLS_CA_FILE: certPath("untrusted-cert.pem"),
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

    // The relay's backend half fails its TLS handshake, so the session ends
    // and the client sees the failure.
    await waitFor(() =>
      messages.some((m) => m.includes('"goodbye"')),
    );
    expect(messages.some((m) => m.includes("Backend connection failed"))).toBe(true);
    await waitFor(() => relay.sessionCount === 0, 5000);
  });

  it("serves the health endpoint and static web files over HTTPS with path traversal protected", async () => {
    const root = mkdtempSync(join(tmpdir(), "ws-static-"));
    mkdirSync(join(root, "js"), { recursive: true });
    writeFileSync(join(root, "index.html"), "<h1>hello</h1>");
    writeFileSync(join(root, "js", "bundle.js"), "console.log(1)");

    const port = 0;
    const relay = new RelayServer({
      config: makeRelayConfig(
        {
          WS_ENABLED: "true",
          WS_PORT: String(port),
          AUTH_TOKENS: "relaytok",
          TARGETS: "pty=127.0.0.1:1",
          TLS_ENABLED: "true",
          TLS_CERT_FILE: certPath("server-cert.pem"),
          TLS_KEY_FILE: certPath("server-key.pem"),
          WS_STATIC_DIR: root,
        },
        {
          websocket: {
            port,
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
            webroot: root,
          },
        },
      ),
      logger: silentLogger,
    });
    await relay.listen();
    relays.push(relay);

    const base = `https://127.0.0.1:${relay.wsPort}`;
    const ca = pem("ca-cert.pem");

    const health = await httpsGet(`${base}/healthz`, ca);
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body).status).toBe("ok");

    const index = await httpsGet(`${base}/`, ca);
    expect(index.status).toBe(200);
    expect(index.body).toContain("<h1>hello</h1>");

    const bundle = await httpsGet(`${base}/js/bundle.js`, ca);
    expect(bundle.status).toBe(200);
    expect(bundle.body).toContain("console.log(1)");

    // A literal traversal attempt in the request line must be refused.
    const escape = await httpsGet(`${base}/../README.md`, ca, "/../README.md");
    expect(escape.status).toBe(403);

    const missing = await httpsGet(`${base}/nope.txt`, ca);
    expect(missing.status).toBe(404);
  });
});

function httpsGet(
  url: string,
  caPath: string,
  rawPath?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = request(
      {
        hostname: u.hostname,
        port: u.port,
        path: rawPath ?? u.pathname + u.search,
        method: "GET",
        ca: caPath,
        rejectUnauthorized: true,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8") }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}
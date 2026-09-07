import { describe, it, expect, afterEach } from "vitest";
import { request } from "node:http";
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { WebSocket as WsClient } from "ws";
import { RelayServer } from "../src/relay.js";
import { loadRelayConfig, type RelayConfig } from "../src/config.js";

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function makeRelayConfig(overrides: Partial<RelayConfig> = {}): RelayConfig {
  const base = loadRelayConfig({
    RELAY_HOST: "127.0.0.1",
    RELAY_PORT: "0",
    WS_ENABLED: "true",
    WS_PORT: "0",
    AUTH_TOKENS: "relaytok",
    TARGETS: "pty=127.0.0.1:1",
    WS_AUTH_TIMEOUT_MS: "3000",
    WS_IDLE_TIMEOUT_MS: "5000",
    IDLE_TIMEOUT_MS: "5000",
  });
  return { ...base, ...overrides };
}

const relays: RelayServer[] = [];
const sockets: WsClient[] = [];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  while (relays.length) {
    const r = relays.pop()!;
    await r.close().catch(() => undefined);
  }
});

// ── Render configuration tests ─────────────────────────────────────────────

describe("Render deployment: config", () => {
  it("auto-enables WS and maps PORT to WS_PORT when RENDER=1 and no explicit WS/R ports", () => {
    const cfg = loadRelayConfig({
      RENDER: "1",
      PORT: "8080",
      AUTH_TOKENS: "tok",
      TARGETS: "t=1:2",
    });
    expect(cfg.port).toBe(0); // RELAY_PORT=0 (ephemeral TCP backend)
    expect(cfg.websocket).toBeDefined();
    expect(cfg.websocket!.port).toBe(8080); // WS_PORT = Render's PORT
  });

  it("auto-enables WS and maps PORT to WS_PORT when RENDER=true", () => {
    const cfg = loadRelayConfig({
      RENDER: "true",
      PORT: "3000",
      AUTH_TOKENS: "tok",
      TARGETS: "t=1:2",
    });
    expect(cfg.port).toBe(0);
    expect(cfg.websocket).toBeDefined();
    expect(cfg.websocket!.port).toBe(3000);
  });

  it("detects Render from injected RENDER_* env vars without RENDER", () => {
    const cfg = loadRelayConfig({
      RENDER_SERVICE_ID: "srv-cat",
      PORT: "9000",
      AUTH_TOKENS: "tok",
      TARGETS: "t=1:2",
    });
    expect(cfg.port).toBe(0);
    expect(cfg.websocket).toBeDefined();
    expect(cfg.websocket!.port).toBe(9000);
  });

  it("forces WSS front door onto Render's PORT even when WS_PORT is explicit", () => {
    // Render only routes public traffic to `PORT`; a separate WS_PORT would
    // be unreachable, so it must not survive on a Render deploy.
    const cfg = loadRelayConfig({
      RENDER: "1",
      PORT: "8080",
      WS_PORT: "9090",
      RELAY_PORT: "0",
      AUTH_TOKENS: "tok",
      TARGETS: "t=1:2",
    });
    expect(cfg.websocket!.port).toBe(8080);
    expect(cfg.port).toBe(0);
  });

  it("does not override explicit RELAY_PORT when RENDER is set", () => {
    const cfg = loadRelayConfig({
      RENDER: "1",
      PORT: "8080",
      RELAY_PORT: "5555",
      AUTH_TOKENS: "tok",
      TARGETS: "t=1:2",
    });
    expect(cfg.port).toBe(5555);
    expect(cfg.websocket!.port).toBe(8080);
  });

  it("defaults WS_STATIC_DIR to ./web on Render when the directory exists", () => {
    const cfg = loadRelayConfig({
      RENDER: "1",
      PORT: "8080",
      AUTH_TOKENS: "tok",
      TARGETS: "t=1:2",
    });
    expect(cfg.websocket!.webroot).toBe("web");
  });

  it("keeps an explicit WS_STATIC_DIR on Render", () => {
    const cfg = loadRelayConfig({
      RENDER: "1",
      PORT: "8080",
      WS_STATIC_DIR: "somewhere/else",
      AUTH_TOKENS: "tok",
      TARGETS: "t=1:2",
    });
    expect(cfg.websocket!.webroot).toBe("somewhere/else");
  });

  it("does nothing when RENDER is not set (normal development)", () => {
    const cfg = loadRelayConfig({
      RELAY_HOST: "127.0.0.1",
      RELAY_PORT: "9000",
      AUTH_TOKENS: "tok",
      TARGETS: "t=1:2",
    });
    expect(cfg.port).toBe(9000);
    expect(cfg.websocket).toBeUndefined();
  });

  it("binds to 0.0.0.0 by default (Render/PaaS compatible)", () => {
    const cfg = loadRelayConfig({
      AUTH_TOKENS: "tok",
      TARGETS: "t=1:2",
    });
    expect(cfg.host).toBe("0.0.0.0");
  });

  it("allows explicit RELAY_HOST override", () => {
    const cfg = loadRelayConfig({
      RELAY_HOST: "127.0.0.1",
      RELAY_PORT: "0",
      AUTH_TOKENS: "tok",
      TARGETS: "t=1:2",
    });
    expect(cfg.host).toBe("127.0.0.1");
  });

  it("allows WS_STATIC_DIR to be set even if directory does not exist", () => {
    const cfg = loadRelayConfig({
      RELAY_PORT: "0",
      WS_ENABLED: "true",
      WS_PORT: "0",
      AUTH_TOKENS: "tok",
      TARGETS: "t=1:2",
      WS_STATIC_DIR: "/nonexistent/path/to/web/dist",
    });
    // webroot is preserved (graceful skip) so the HTTP handler can
    // serve 404s until the directory is created by the build step.
    expect(cfg.websocket).toBeDefined();
    expect(cfg.websocket!.webroot).toBe("/nonexistent/path/to/web/dist");
  });

  it("preserves WS_STATIC_DIR when directory exists", () => {
    const root = mkdtempSync(join(tmpdir(), "ws-static-"));
    mkdirSync(join(root, "js"), { recursive: true });
    writeFileSync(join(root, "index.html"), "<h1>hello</h1>");

    const cfg = loadRelayConfig({
      RELAY_PORT: "0",
      WS_ENABLED: "true",
      WS_PORT: "0",
      AUTH_TOKENS: "tok",
      TARGETS: "t=1:2",
      WS_STATIC_DIR: root,
    });
    expect(cfg.websocket!.webroot).toBe(root);
  });
});

// ── /healthz tests ────────────────────────────────────────────────────────

describe("Render deployment: /healthz", () => {
  it("returns 200 with status ok and connection counts", async () => {
    const relay = new RelayServer({ config: makeRelayConfig(), logger: silentLogger });
    await relay.listen();
    relays.push(relay);

    const body = await httpGet(`http://127.0.0.1:${relay.wsPort}/healthz`);
    expect(body.status).toBe(200);
    const json = JSON.parse(body.body);
    expect(json.status).toBe("ok");
    expect(typeof json.uptime).toBe("number");
    expect(typeof json.connections).toBe("number");
    expect(typeof json.maxConnections).toBe("number");
  });

  it("works on the same port as the WebSocket front door", async () => {
    const relay = new RelayServer({ config: makeRelayConfig(), logger: silentLogger });
    await relay.listen();
    relays.push(relay);

    // Verify both /healthz and /ws share the same port
    const health = await httpGet(`http://127.0.0.1:${relay.wsPort}/healthz`);
    expect(health.status).toBe(200);

    const wsCheck = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${relay.wsPort}/ws`);
      ws.on("open", () => { ws.close(); resolve(true); });
      ws.on("error", () => resolve(false));
      ws.on("close", () => undefined);
    });
    expect(wsCheck).toBe(true);
  });
});

// ── Static GUI serving tests ──────────────────────────────────────────────

describe("Render deployment: static GUI serving", () => {
  it("serves index.html at / and bundles from /dist", async () => {
    const root = mkdtempSync(join(tmpdir(), "render-static-"));
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "index.html"), "<!doctype html><h1>GUI</h1>");
    writeFileSync(join(root, "dist", "bundle.js"), "console.log(1)");
    writeFileSync(join(root, "dist", "bundle.css"), "body{}");

    const relay = new RelayServer({
      config: makeRelayConfig({ websocket: { ...makeRelayConfig().websocket!, webroot: root } }),
      logger: silentLogger,
    });
    await relay.listen();
    relays.push(relay);

    const index = await httpGet(`http://127.0.0.1:${relay.wsPort}/`);
    expect(index.status).toBe(200);
    expect(index.body).toContain("<h1>GUI</h1>");

    const bundle = await httpGet(`http://127.0.0.1:${relay.wsPort}/dist/bundle.js`);
    expect(bundle.status).toBe(200);
    expect(bundle.body).toContain("console.log(1)");

    const css = await httpGet(`http://127.0.0.1:${relay.wsPort}/dist/bundle.css`);
    expect(css.status).toBe(200);
    expect(css.body).toContain("body{}");
  });

  it("returns SPA fallback (index.html) for extensionless paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "render-spa-"));
    writeFileSync(join(root, "index.html"), "<!doctype html><h1>SPA</h1>");

    const relay = new RelayServer({
      config: makeRelayConfig({ websocket: { ...makeRelayConfig().websocket!, webroot: root } }),
      logger: silentLogger,
    });
    await relay.listen();
    relays.push(relay);

    // Extensionless path should serve index.html (SPA fallback)
    const spa = await httpGet(`http://127.0.0.1:${relay.wsPort}/some/deep/path`);
    expect(spa.status).toBe(200);
    expect(spa.body).toContain("<h1>SPA</h1>");
  });

  it("returns 404 for requests with file extensions that do not exist", async () => {
    const root = mkdtempSync(join(tmpdir(), "render-noext-"));
    writeFileSync(join(root, "index.html"), "<h1>hello</h1>");

    const relay = new RelayServer({
      config: makeRelayConfig({ websocket: { ...makeRelayConfig().websocket!, webroot: root } }),
      logger: silentLogger,
    });
    await relay.listen();
    relays.push(relay);

    const missing = await httpGet(`http://127.0.0.1:${relay.wsPort}/missing.js`);
    expect(missing.status).toBe(404);
  });

  it("blocks path traversal", async () => {
    const root = mkdtempSync(join(tmpdir(), "render-traversal-"));
    writeFileSync(join(root, "index.html"), "<h1>safe</h1>");

    const relay = new RelayServer({
      config: makeRelayConfig({ websocket: { ...makeRelayConfig().websocket!, webroot: root } }),
      logger: silentLogger,
    });
    await relay.listen();
    relays.push(relay);

    // Use raw socket to send a path that Node's HTTP client would normalize.
    const escape = await httpGetRaw(relay.wsPort, "/../README.md");
    expect(escape.status).toBe(403);
  });
});

// ── API login test ────────────────────────────────────────────────────────

describe("Render deployment: API login", () => {
  it("authenticates via POST /api/auth/login and returns session token", async () => {
    const relay = new RelayServer({
      config: makeRelayConfig({
        targets: [{ id: "pty", host: "127.0.0.1", port: 1 }],
      }),
      logger: silentLogger,
    });
    await relay.listen();
    relays.push(relay);

    const res = await httpPost(
      `http://127.0.0.1:${relay.wsPort}/api/auth/login`,
      { token: "relaytok" },
    );
    expect(res.status).toBe(200);
    const json = JSON.parse(res.body);
    expect(json.user).toBeDefined();
    expect(json.user.name).toBe("token");
    expect(json.session.token).toBeDefined();
  });

  it("rejects invalid credentials", async () => {
    const relay = new RelayServer({ config: makeRelayConfig(), logger: silentLogger });
    await relay.listen();
    relays.push(relay);

    const res = await httpPost(
      `http://127.0.0.1:${relay.wsPort}/api/auth/login`,
      { token: "wrong-token" },
    );
    expect(res.status).toBe(401);
  });
});

// ── WebSocket upgrade test ────────────────────────────────────────────────

describe("Render deployment: WebSocket upgrade", () => {
  it("upgrades /ws from the same HTTP port", async () => {
    const relay = new RelayServer({ config: makeRelayConfig(), logger: silentLogger });
    await relay.listen();
    relays.push(relay);

    const { ws, messages } = await connectWs(relay.wsPort);
    await waitFor(() => messages.some((m) => String(m.data).includes('"hello"')));
    expect(messages.some((m) => String(m.data).includes('"auth_methods"'))).toBe(true);
    ws.terminate();
  });

  it("upgrades /device from the same HTTP port", async () => {
    const relay = new RelayServer({
      config: makeRelayConfig({
        DEVICES: "laptop|PC|shell",
      }),
      logger: silentLogger,
    });
    await relay.listen();
    relays.push(relay);

    const connected = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${relay.wsPort}/device`);
      ws.on("open", () => { ws.close(); resolve(true); });
      ws.on("error", () => resolve(false));
      setTimeout(() => resolve(false), 3000);
    });
    expect(connected).toBe(true);
  });

  it("keys per-IP auth rate limits on X-Forwarded-For behind the proxy", async () => {
    const relay = new RelayServer({
      config: makeRelayConfig({ authRateLimitPerIp: 2 }),
      logger: silentLogger,
    });
    await relay.listen();
    relays.push(relay);

    // Two bad attempts from forwarded IP A exhaust its bucket.
    const a1 = await connectWsHeader(relay.wsPort, "203.0.113.7");
    sockets.push(a1.ws);
    await waitFor(() => a1.messages.some((m) => m.includes('"hello"')));
    a1.ws.send(JSON.stringify({ type: "auth_request", method: "token", token: "bad" }));
    await waitFor(() => a1.messages.some((m) => m.includes('"auth_fail"')));
    a1.ws.terminate();

    const a2 = await connectWsHeader(relay.wsPort, "203.0.113.7");
    sockets.push(a2.ws);
    await waitFor(() => a2.messages.some((m) => m.includes('"hello"')));
    a2.ws.send(JSON.stringify({ type: "auth_request", method: "token", token: "bad" }));
    await waitFor(() => a2.messages.some((m) => m.includes('"auth_fail"')));
    a2.ws.terminate();

    // A third bad attempt from the same forwarded IP is throttled...
    const a3 = await connectWsHeader(relay.wsPort, "203.0.113.7");
    sockets.push(a3.ws);
    await waitFor(() => a3.messages.some((m) => m.includes('"hello"')));
    a3.ws.send(JSON.stringify({ type: "auth_request", method: "token", token: "bad" }));
    await waitFor(() => a3.messages.some((m) => m.includes('"auth_fail"')));
    expect(
      a3.messages.some((m) => m.includes("Too many authentication attempts")),
    ).toBe(true);
    a3.ws.terminate();

    // ...but a different forwarded IP still has its own fresh bucket.
    const b = await connectWsHeader(relay.wsPort, "198.51.100.9");
    sockets.push(b.ws);
    await waitFor(() => b.messages.some((m) => m.includes('"hello"')));
    b.ws.send(JSON.stringify({ type: "auth_request", method: "token", token: "bad" }));
    await waitFor(() => b.messages.some((m) => m.includes('"auth_fail"')));
    expect(
      b.messages.some((m) => m.includes("Too many authentication attempts")),
    ).toBe(false);
    b.ws.terminate();
  });
});

// ── End-to-end Browser → Relay → Agent path ──────────────────────────────

describe("Render deployment: browser → relay → agent e2e", () => {
  it("browser creates a session and connects over WebSocket to an agent device", async () => {
    // 1. Start relay with an agent device
    const relay = new RelayServer({
      config: loadRelayConfig({
        RELAY_HOST: "127.0.0.1",
        RELAY_PORT: "0",
        WS_ENABLED: "true",
        WS_PORT: "0",
        AUTH_TOKENS: "relaytok",
        TARGETS: "",
        DEVICES: "laptop|Workstation|shell",
        WS_AUTH_TIMEOUT_MS: "3000",
        WS_IDLE_TIMEOUT_MS: "10000",
        IDLE_TIMEOUT_MS: "10000",
      }),
      logger: silentLogger,
    });
    await relay.listen();
    relays.push(relay);

    // 2. Browser logs in
    const login = await httpPost(
      `http://127.0.0.1:${relay.wsPort}/api/auth/login`,
      { token: "relaytok" },
    );
    expect(login.status).toBe(200);
    const loginJson = JSON.parse(login.body);
    const sessionToken = loginJson.session.token;

    // 3. Device agent connects via real RelayClient (handles enrollment automatically)
    const tmpDir = mkdtempSync(join(tmpdir(), "render-agent-"));
    const { RelayClient } = await import("../../agent/src/relay-client.js");
    const { PtyManager } = await import("../../agent/src/pty-manager.js");
    const { ensureDeviceSecret } = await import("../../agent/src/credentials.js");

    const agentConfig = {
      relayUrl: `ws://127.0.0.1:${relay.wsPort}`,
      deviceId: "laptop",
      credentialsFile: join(tmpDir, "device.secret"),
      shell: process.env.SHELL || "/bin/bash",
      cwd: tmpDir,
      reconnectMinMs: 50,
      reconnectMaxMs: 300,
      reconnectFactor: 2,
      authTimeoutMs: 5000,
      pingIntervalMs: 30_000,
      idleTimeoutMs: 60_000,
      sendHighWaterMark: 1024 * 1024,
      sendLowWaterMark: 256 * 1024,
    };
    const creds = ensureDeviceSecret(agentConfig.credentialsFile);
    const pty = new PtyManager(
      { shell: agentConfig.shell, cols: 80, rows: 24, cwd: agentConfig.cwd },
      (msg) => client.send(msg),
      silentLogger,
    );
    const client = new RelayClient({
      config: agentConfig,
      secret: creds.secret,
      logger: silentLogger,
      onServerMessage: (msg) => {
        if (msg.type === "device_session_open") pty.start(msg.sessionId, msg.cols, msg.rows);
        if (msg.type === "device_session_close") pty.close(msg.sessionId);
        if (msg.type === "device_session_input") pty.input(msg.sessionId, msg.data);
        if (msg.type === "device_session_resize") pty.resize(msg.sessionId, msg.cols, msg.rows);
      },
    });
    client.start();
    await waitFor(() => client.ready);

    // 4. Browser lists devices — laptop should be online
    const devices = await httpGetAuth(
      `http://127.0.0.1:${relay.wsPort}/api/devices`,
      sessionToken,
    );
    expect(devices.status).toBe(200);
    const devicesJson = JSON.parse(devices.body);
    expect(devicesJson.devices.length).toBe(1);
    expect(devicesJson.devices[0].id).toBe("laptop");
    expect(devicesJson.devices[0].online).toBe(true);

    // 5. Browser creates a session on the agent device
    const createRes = await httpPostAuth(
      `http://127.0.0.1:${relay.wsPort}/api/devices/laptop/sessions`,
      { type: "shell" },
      sessionToken,
    );
    expect(createRes.status).toBe(201);
    const createJson = JSON.parse(createRes.body);
    expect(createJson.connect.path).toContain("/ws?");

    // 6. Browser connects via WebSocket using the session token
    const wsPath = createJson.connect.path;
    const wsUrl = `ws://127.0.0.1:${relay.wsPort}${wsPath}`;
    const browser = await connectWsUrl(wsUrl, sessionToken);

    // Wait for the agent to receive a channel_open
    await waitFor(() => client.ready);

    // Cleanup
    browser.ws.terminate();
    client.stop();
    pty.closeAll();
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────

function connectWs(
  port: number,
): Promise<{
  ws: WsClient;
  messages: Array<{ data: string | Buffer; isBinary: boolean }>;
  closes: Array<{ code: number; reason: string }>;
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const messages: Array<{ data: string | Buffer; isBinary: boolean }> = [];
    const closes: Array<{ code: number; reason: string }> = [];
    ws.on("message", (data, isBinary) =>
      messages.push({ data: data as Buffer, isBinary }),
    );
    ws.on("close", (code, reason) =>
      closes.push({ code, reason: reason.toString() }),
    );
    ws.on("error", () => undefined);
    ws.on("open", () => resolve({ ws, messages, closes }));
    setTimeout(() => reject(new Error("ws open timeout")), 3000);
  });
}

function connectWsHeader(
  port: number,
  forwardedFor: string,
): Promise<{
  ws: WsClient;
  messages: string[];
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { "X-Forwarded-For": forwardedFor },
    });
    const messages: string[] = [];
    ws.on("message", (data) => messages.push(String(data)));
    ws.on("error", () => undefined);
    ws.on("open", () => resolve({ ws, messages }));
    setTimeout(() => reject(new Error("ws open timeout")), 3000);
  });
}

function connectWsUrl(
  url: string,
  token: string,
): Promise<{
  ws: WsClient;
  messages: Array<{ data: string | Buffer; isBinary: boolean }>;
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages: Array<{ data: string | Buffer; isBinary: boolean }> = [];
    ws.on("message", (data, isBinary) =>
      messages.push({ data: data as Buffer, isBinary }),
    );
    ws.on("error", () => undefined);
    ws.on("open", () => {
      ws.on("message", (data) => {
        const msg = String(data);
        if (msg.includes('"hello"')) {
          ws.send(JSON.stringify({ type: "auth_request", method: "token", token }));
        }
      });
      resolve({ ws, messages });
    });
    setTimeout(() => reject(new Error("ws open timeout")), 3000);
  });
}

function httpGet(
  url: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: "GET" },
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

function httpPost(
  url: string,
  body: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = JSON.stringify(body);
    const req = request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
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
    req.write(payload);
    req.end();
  });
}

function httpGetAuth(
  url: string,
  token: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
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

function httpPostAuth(
  url: string,
  body: unknown,
  token: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = JSON.stringify(body);
    const req = request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          Authorization: `Bearer ${token}`,
        },
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
    req.write(payload);
    req.end();
  });
}

/**
 * Send an HTTP GET with a raw, un-normalized path (bypasses URL normalization
 * so traversal sequences like /../ survive to the server).
 */
function httpGetRaw(
  port: number,
  rawPath: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: "127.0.0.1", port, path: rawPath, method: "GET" },
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

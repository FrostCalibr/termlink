import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { WebSocket as WsClient } from "ws";
import { RelayServer } from "../src/relay.js";
import { loadRelayConfig } from "../src/config.js";
import { api, login, silentLogger, waitFor } from "./helpers.js";
import { RelayClient } from "../../agent/src/relay-client.js";
import { PtyManager } from "../../agent/src/pty-manager.js";
import { ensureDeviceSecret } from "../../agent/src/credentials.js";
import type { AgentConfig } from "../../agent/src/config.js";

const DEVICE_ID = "device";
const shellBin = process.env.SHELL || "/bin/bash";

interface AgentHandle {
  client: RelayClient;
  pty: PtyManager;
  fatal: string | null;
  states: string[];
  stop: () => void;
}

let relay: RelayServer;
let port = 0;
let agent: AgentHandle;
let tmpDir: string;
let sharedToken: string;

function baseAgentConfig(relayUrl: string, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    relayUrl,
    deviceId: DEVICE_ID,
    credentialsFile: join(tmpDir, "device.secret"),
    shell: shellBin,
    cwd: tmpDir,
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

async function startAgent(overrides: Partial<AgentConfig> = {}): Promise<AgentHandle> {
  const config = baseAgentConfig(`ws://127.0.0.1:${port}`, overrides);
  const creds = ensureDeviceSecret(config.credentialsFile);
  const pty = new PtyManager(
    { shell: config.shell, cols: 80, rows: 24, cwd: config.cwd },
    (msg) => client.send(msg),
    silentLogger,
  );
  const handle: AgentHandle = {
    client: undefined as unknown as RelayClient,
    pty,
    fatal: null,
    states: [],
    stop: () => {
      handle.client.stop();
      pty.closeAll();
    },
  };
  const client = new RelayClient({
    config,
    secret: creds.secret,
    logger: silentLogger,
    onServerMessage: (msg) => {
      switch (msg.type) {
        case "device_session_open":
          pty.start(msg.sessionId, msg.cols, msg.rows);
          break;
        case "device_session_close":
          pty.close(msg.sessionId);
          break;
        case "device_session_input":
          pty.input(msg.sessionId, msg.data);
          break;
        case "device_session_resize":
          pty.resize(msg.sessionId, msg.cols, msg.rows);
          break;
      }
    },
    onFatal: (reason) => {
      handle.fatal = reason;
    },
    onStateChange: (s) => handle.states.push(s),
  });
  handle.client = client;
  client.start();
  return handle;
}

/** Connect a browser WS with the given query and authenticate with a token. */
function connectBrowser(
  p: number,
  query: string,
  token: string,
): Promise<{
  ws: WsClient;
  messages: Array<{ data: string | Buffer; isBinary: boolean }>;
  closes: Array<{ code: number; reason: string }>;
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${p}/${query}`, {
      headers: { Origin: "http://relay.example" },
    });
    const messages: Array<{ data: string | Buffer; isBinary: boolean }> = [];
    const closes: Array<{ code: number; reason: string }> = [];
    ws.on("message", (data, isBinary) =>
      messages.push({ data: data as Buffer, isBinary }),
    );
    ws.on("close", (code, reason) => closes.push({ code, reason: reason.toString() }));
    ws.on("error", () => undefined);
    const timer = setTimeout(() => reject(new Error("ws open timeout")), 4000);
    ws.on("open", () => {
      clearTimeout(timer);
      resolve({ ws, messages, closes });
    });
  });
}

async function handshakeAsync(
  ws: WsClient,
  messages: Array<{ data: string | Buffer; isBinary: boolean }>,
  token: string,
): Promise<void> {
  await waitFor(() => messages.some((m) => String(m.data).includes('"hello"')));
  ws.send(JSON.stringify({ type: "auth_request", method: "token", token }));
  await waitFor(() => messages.some((m) => String(m.data).includes('"auth_ok"')));
}

async function sendTerminal(ws: WsClient, text: string): Promise<void> {
  const base64 = Buffer.from(text, "utf-8").toString("base64");
  ws.send(JSON.stringify({ type: "terminal_input", data: base64 }));
}

async function waitOutput(
  messages: Array<{ data: string | Buffer; isBinary: boolean }>,
  needle: string,
  timeoutMs = 5000,
): Promise<string> {
  const start = Date.now();
  while (true) {
    for (const m of messages) {
      if (m.isBinary) continue;
      const text = String(m.data);
      const decoded = terminalPayload(text);
      if (decoded !== null && decoded.includes(needle)) return decoded;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`output did not contain "${needle}"`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Decode the raw bytes of a terminal_output frame, or null for other frames. */
function terminalPayload(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const rec = parsed as { type?: string; data?: unknown };
  if (rec.type !== "terminal_output" || typeof rec.data !== "string") return null;
  return Buffer.from(rec.data, "base64").toString("utf-8");
}

async function createSession(devId: string): Promise<{ session: { id: string }; connect: { path: string } }> {
  const res = await api(port, `/api/devices/${devId}/sessions`, {
    method: "POST",
    token: sharedToken,
    body: { device: devId },
  });
  expect(res.status).toBe(201);
  const json = res.json as { session: { id: string }; connect: { path: string } };
  return json;
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "device-e2e-"));
  const config = loadRelayConfig({
    RELAY_HOST: "127.0.0.1",
    RELAY_PORT: "0",
    WS_ENABLED: "true",
    WS_PORT: "0",
    AUTH_TOKENS: "relaytok",
    PASSWORD_USERS: "alice:secret,bob:pw",
    TARGETS: "",
    DEVICES: `${DEVICE_ID}|Test device|shell`,
    WS_AUTH_TIMEOUT_MS: "3000",
    WS_IDLE_TIMEOUT_MS: "10000",
    IDLE_TIMEOUT_MS: "10000",
  });
  relay = new RelayServer({ config, logger: silentLogger });
  await relay.listen();
  port = relay.wsPort;
  sharedToken = await login(port, { username: "alice", password: "secret" });

  agent = await startAgent();
  await waitFor(() => agent.client.ready);
});

afterAll(async () => {
  agent?.stop();
  await relay?.close();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe("Phase 9 device agent (full stack)", () => {
  it("enrolls an agent and exposes the device via the API as online/enrolled", async () => {
    const res = await api(port, "/api/devices", { token: sharedToken });
    expect(res.status).toBe(200);
    const devices = (res.json as { devices: Array<Record<string, unknown>> }).devices;
    const dev = devices.find((d) => d.id === DEVICE_ID);
    expect(dev).toMatchObject({
      id: DEVICE_ID,
      name: "Test device",
      type: "shell",
      online: true,
      enrolled: true,
      latencyMs: null,
    });
    expect(agent.fatal).toBeNull();
  });

  it("runs a browser → relay → agent → local shell round-trip", async () => {
    const created = await createSession(DEVICE_ID);
    const { ws, messages, closes } = await connectBrowser(
      port,
      `ws?device=${DEVICE_ID}&type=shell&session=${created.session.id}`,
      sharedToken,
    );
    await handshakeAsync(ws, messages, sharedToken);

    await sendTerminal(ws, "echo PING_DEVICE_SHELL\n");
    await waitOutput(messages, "PING_DEVICE_SHELL");

    ws.terminate();
    await waitFor(() => closes.length > 0);
  });

  it("supports terminal resize without breaking the stream", async () => {
    const created = await createSession(DEVICE_ID);
    const { ws, messages } = await connectBrowser(
      port,
      `ws?device=${DEVICE_ID}&type=shell&session=${created.session.id}`,
      sharedToken,
    );
    await handshakeAsync(ws, messages, sharedToken);

    ws.send(
      JSON.stringify({ type: "terminal_resize", cols: 132, rows: 43 }),
    );
    await sendTerminal(ws, "echo RESIZE_STILL_WORKS\n");
    await waitOutput(messages, "RESIZE_STILL_WORKS");
    ws.terminate();
    await waitFor(() => agent.pty.backend.size === 0, 5000);
  });

  it("isolates multiple concurrent sessions on the same device", async () => {
    const a = await createSession(DEVICE_ID);
    const b = await createSession(DEVICE_ID);
    const ca = await connectBrowser(
      port,
      `ws?device=${DEVICE_ID}&type=shell&session=${a.session.id}`,
      sharedToken,
    );
    const cb = await connectBrowser(
      port,
      `ws?device=${DEVICE_ID}&type=shell&session=${b.session.id}`,
      sharedToken,
    );
    await handshakeAsync(ca.ws, ca.messages, sharedToken);
    await handshakeAsync(cb.ws, cb.messages, sharedToken);

    await sendTerminal(ca.ws, "echo UNIQUE_TAG_A\n");
    await sendTerminal(cb.ws, "echo UNIQUE_TAG_B\n");

    await waitOutput(ca.messages, "UNIQUE_TAG_A");
    await waitOutput(cb.messages, "UNIQUE_TAG_B");

    // Cross-talk: session A never sees B's output and vice versa.
    expect(ca.messages.some((m) => String(m.data).includes("UNIQUE_TAG_B"))).toBe(false);
    expect(cb.messages.some((m) => String(m.data).includes("UNIQUE_TAG_A"))).toBe(false);

    expect(agent.pty.size).toBe(2);
    ca.ws.terminate();
    cb.ws.terminate();
    await waitFor(() => agent.pty.size === 0, 5000);
  });

  it("closes the agent PTY when the browser disconnects", async () => {
    const created = await createSession(DEVICE_ID);
    const { ws, messages, closes } = await connectBrowser(
      port,
      `ws?device=${DEVICE_ID}&type=shell&session=${created.session.id}`,
      sharedToken,
    );
    await handshakeAsync(ws, messages, sharedToken);
    await sendTerminal(ws, "echo CLEANUP_PROBE\n");
    await waitOutput(messages, "CLEANUP_PROBE");
    expect(agent.pty.size).toBe(1);

    ws.terminate();
    await waitFor(() => closes.length > 0);
    await waitFor(() => agent.pty.size === 0, 5000);
  });

  it("closes the agent PTY when the session is deleted via the API", async () => {
    const created = await createSession(DEVICE_ID);
    const { ws, messages } = await connectBrowser(
      port,
      `ws?device=${DEVICE_ID}&type=shell&session=${created.session.id}`,
      sharedToken,
    );
    await handshakeAsync(ws, messages, sharedToken);
    await sendTerminal(ws, "echo DELETE_PROBE\n");
    await waitOutput(messages, "DELETE_PROBE");
    expect(agent.pty.size).toBe(1);

    const del = await api(port, `/api/sessions/${created.session.id}`, {
      method: "DELETE",
      token: sharedToken,
    });
    expect(del.status).toBe(200);
    await waitFor(() => agent.pty.size === 0, 5000);
  });

  it("takes the device offline: sessions are refused by the API and the WS front door", async () => {
    // Keep a valid session id around for the offline WS check, then stop the
    // agent (graceful) so the relay sees the device go offline.
    const created = await createSession(DEVICE_ID);
    agent.stop();
    await waitFor(() => !agent.client.ready);

    const res = await api(port, `/api/devices/${DEVICE_ID}/sessions`, {
      method: "POST",
      token: sharedToken,
      body: { device: DEVICE_ID },
    });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ error: "Device offline" });

    const listing = await api(port, "/api/devices", { token: sharedToken });
    const devices = (listing.json as { devices: Array<Record<string, unknown>> }).devices;
    expect(devices.find((d) => d.id === DEVICE_ID)).toMatchObject({ online: false });

    // A browser connecting to the (still-open) session is dropped instead of
    // silently hanging.
    const { ws, messages, closes } = await connectBrowser(
      port,
      `ws?device=${DEVICE_ID}&type=shell&session=${created.session.id}`,
      sharedToken,
    );
    await handshakeAsync(ws, messages, sharedToken);
    await waitFor(
      () =>
        messages.some((m) => String(m.data).includes('"goodbye"')) &&
        closes.length > 0,
      5000,
    );
    const goodbye = messages.find((m) => String(m.data).includes('"goodbye"'));
    expect(String(goodbye?.data)).toMatch(/Device offline/);

    // Bring the device back online for the remaining tests.
    agent = await startAgent();
    await waitFor(() => agent.client.ready);
  });

  it("denies a rogue agent that lacks the enrolled secret", async () => {
    const rogueDir = mkdtempSync(join(tmpDir, "rogue"));
    const rogue = await startAgent({
      credentialsFile: join(rogueDir, "rogue.secret"),
      deviceId: DEVICE_ID,
    });
    await waitFor(() => rogue.fatal !== null, 5000);
    // Its fresh secret does not match the enrolled hash and re-enrollment is
    // refused: the device cannot be hijacked by a second, unenrolled claimant.
    expect(rogue.fatal).toMatch(/Invalid device secret/);
    expect(rogue.client.ready).toBe(false);

    // The enrolled device is still healthy on the good agent.
    await waitFor(() => agent.client.ready);
    expect(agent.fatal).toBeNull();

    // Device remains online/enrolled and fully usable.
    const res = await api(port, "/api/devices", { token: sharedToken });
    const devices = (res.json as { devices: Array<Record<string, unknown>> }).devices;
    expect(devices.find((d) => d.id === DEVICE_ID)).toMatchObject({
      online: true,
      enrolled: true,
    });
    const created = await createSession(DEVICE_ID);
    const { ws, messages } = await connectBrowser(
      port,
      `ws?device=${DEVICE_ID}&type=shell&session=${created.session.id}`,
      sharedToken,
    );
    await handshakeAsync(ws, messages, sharedToken);
    await sendTerminal(ws, "echo STILL_HEALTHY\n");
    await waitOutput(messages, "STILL_HEALTHY");
    ws.terminate();
    rmSync(rogueDir, { recursive: true, force: true });
  });

  it("refuses an agent device session without a session id", async () => {
    const { ws, messages, closes } = await connectBrowser(
      port,
      `ws?device=${DEVICE_ID}&type=shell`,
      sharedToken,
    );
    await handshakeAsync(ws, messages, sharedToken);
    await waitFor(
      () =>
        messages.some((m) => String(m.data).includes('"goodbye"')) &&
        closes.length > 0,
      5000,
    );
    const goodbye = messages.find((m) => String(m.data).includes('"goodbye"'));
    expect(String(goodbye?.data)).toMatch(/session id/);
  });

  it("gracefully shuts the device down", async () => {
    agent.stop();
    await waitFor(() => !agent.client.ready);
    expect(agent.pty.size).toBe(0);
  });
});
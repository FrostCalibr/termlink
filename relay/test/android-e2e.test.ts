import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { WebSocket as WsClient } from "ws";
import { RelayServer } from "../src/relay.js";
import { loadRelayConfig } from "../src/config.js";
import { api, login, silentLogger, waitFor } from "./helpers.js";
import { AndroidAgent } from "../../agent/src/android/agent.js";
import { loadAndroidAgentConfig } from "../../agent/src/android/config.js";

const PHONE_DEVICE_ID = "phone";
const shellBin = process.env.SHELL || "/bin/bash";

let relay: RelayServer;
let port = 0;
let androidAgent: AndroidAgent;
let tmpDir: string;
let sharedToken: string;

function connectBrowser(
  p: number,
  query: string,
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
    body: { device: devId, type: "android" },
  });
  expect(res.status).toBe(201);
  const json = res.json as { session: { id: string }; connect: { path: string } };
  return json;
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "android-e2e-"));
  const config = loadRelayConfig({
    RELAY_HOST: "127.0.0.1",
    RELAY_PORT: "0",
    WS_ENABLED: "true",
    WS_PORT: "0",
    AUTH_TOKENS: "relaytok",
    PASSWORD_USERS: "alice:secret",
    TARGETS: "",
    DEVICES: `${PHONE_DEVICE_ID}|My Phone|android|enroll-secret-123`,
    WS_AUTH_TIMEOUT_MS: "3000",
    WS_IDLE_TIMEOUT_MS: "10000",
    IDLE_TIMEOUT_MS: "10000",
  });
  relay = new RelayServer({ config, logger: silentLogger });
  await relay.listen();
  port = relay.wsPort;
  sharedToken = await login(port, { username: "alice", password: "secret" });

  const agentConfig = loadAndroidAgentConfig({
    ANDROID_RELAY_URL: `ws://127.0.0.1:${port}`,
    ANDROID_DEVICE_ID: PHONE_DEVICE_ID,
    ANDROID_ENROLLMENT_TOKEN: "enroll-secret-123",
    ANDROID_CREDENTIALS_FILE: join(tmpDir, "phone-device.secret"),
    ANDROID_SHELL: shellBin,
    ANDROID_CWD: tmpDir,
    ANDROID_WAKE_LOCK: "false",
    ANDROID_RECONNECT_MIN_MS: "50",
    ANDROID_RECONNECT_MAX_MS: "300",
  });

  androidAgent = new AndroidAgent(agentConfig, silentLogger as any);
  await androidAgent.start();
  await waitFor(() => androidAgent.client.ready, 5000);
});

afterAll(async () => {
  if (androidAgent) await androidAgent.stop();
  await relay?.close();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe("Phase 10 Android Device Agent (Full Stack E2E)", () => {
  it("enrolls and displays Android device as online with android type", async () => {
    const res = await api(port, "/api/devices", { token: sharedToken });
    expect(res.status).toBe(200);
    const devices = (res.json as { devices: Array<Record<string, unknown>> }).devices;
    const dev = devices.find((d) => d.id === PHONE_DEVICE_ID);
    expect(dev).toMatchObject({
      id: PHONE_DEVICE_ID,
      name: "My Phone",
      type: "android",
      online: true,
      enrolled: true,
      latencyMs: null,
    });
  });

  it("runs a Browser -> WSS -> Relay -> Android Agent -> Android shell round-trip", async () => {
    const created = await createSession(PHONE_DEVICE_ID);
    const { ws, messages, closes } = await connectBrowser(
      port,
      `ws?device=${PHONE_DEVICE_ID}&type=android&session=${created.session.id}`,
    );
    await handshakeAsync(ws, messages, sharedToken);

    await sendTerminal(ws, "echo PING_ANDROID_SHELL\n");
    await waitOutput(messages, "PING_ANDROID_SHELL");

    ws.terminate();
    await waitFor(() => closes.length > 0);
  });

  it("forwards terminal window resizes to Android agent PTY", async () => {
    const created = await createSession(PHONE_DEVICE_ID);
    const { ws, messages } = await connectBrowser(
      port,
      `ws?device=${PHONE_DEVICE_ID}&type=android&session=${created.session.id}`,
    );
    await handshakeAsync(ws, messages, sharedToken);

    ws.send(JSON.stringify({ type: "terminal_resize", cols: 120, rows: 40 }));
    await sendTerminal(ws, "echo ANDROID_RESIZE_OK\n");
    await waitOutput(messages, "ANDROID_RESIZE_OK");
    ws.terminate();
    await waitFor(() => androidAgent.pty.backend.size === 0, 5000);
  });

  it("isolates multiple concurrent Android terminal sessions", async () => {
    const sessionA = await createSession(PHONE_DEVICE_ID);
    const sessionB = await createSession(PHONE_DEVICE_ID);

    const clientA = await connectBrowser(
      port,
      `ws?device=${PHONE_DEVICE_ID}&type=android&session=${sessionA.session.id}`,
    );
    const clientB = await connectBrowser(
      port,
      `ws?device=${PHONE_DEVICE_ID}&type=android&session=${sessionB.session.id}`,
    );

    await handshakeAsync(clientA.ws, clientA.messages, sharedToken);
    await handshakeAsync(clientB.ws, clientB.messages, sharedToken);

    await sendTerminal(clientA.ws, "echo SESSION_ALPHA_DATA\n");
    await sendTerminal(clientB.ws, "echo SESSION_BETA_DATA\n");

    await waitOutput(clientA.messages, "SESSION_ALPHA_DATA");
    await waitOutput(clientB.messages, "SESSION_BETA_DATA");

    expect(clientA.messages.some((m) => String(m.data).includes("SESSION_BETA_DATA"))).toBe(false);
    expect(clientB.messages.some((m) => String(m.data).includes("SESSION_ALPHA_DATA"))).toBe(false);

    expect(androidAgent.pty.size).toBe(2);
    clientA.ws.terminate();
    clientB.ws.terminate();
    await waitFor(() => androidAgent.pty.size === 0, 5000);
  });

  it("rejects unauthorized enrollment or access with invalid credentials", async () => {
    const badConfig = loadAndroidAgentConfig({
      ANDROID_RELAY_URL: `ws://127.0.0.1:${port}`,
      ANDROID_DEVICE_ID: PHONE_DEVICE_ID,
      ANDROID_ENROLLMENT_TOKEN: "wrong-token",
      ANDROID_CREDENTIALS_FILE: join(tmpDir, "bad-phone.secret"),
      ANDROID_WAKE_LOCK: "false",
    });

    let fatalReason: string | null = null;
    const badAgent = new AndroidAgent(badConfig, silentLogger as any);
    badAgent.client.options.onFatal = (r) => {
      fatalReason = r;
    };
    await badAgent.start();
    await waitFor(() => fatalReason !== null, 5000);
    expect(fatalReason).toMatch(/Authentication failed|Enrollment refused/);
    await badAgent.stop();
  });
});

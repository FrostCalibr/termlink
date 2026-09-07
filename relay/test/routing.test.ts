import { describe, it, expect, afterEach } from "vitest";
import { WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { WebSocket as WsClient } from "ws";
import {
  api,
  login,
  makeRelay,
  resetTracked,
  waitFor,
} from "./helpers.js";

const openSockets: WsClient[] = [];

afterEach(async () => {
  for (const s of openSockets.splice(0)) {
    if (s.readyState === WebSocket.CLOSED || s.readyState === WebSocket.CLOSING) continue;
    try {
      s.terminate();
    } catch {
      /* already closed */
    }
  }
  await resetTracked();
});

function connectWs(url: string): Promise<{
  ws: WsClient;
  messages: Array<{ data: string | Buffer; isBinary: boolean }>;
  closes: Array<{ code: number; reason: string }>;
}> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    openSockets.push(ws);
    const messages: Array<{ data: string | Buffer; isBinary: boolean }> = [];
    const closes: Array<{ code: number; reason: string }> = [];
    ws.on("message", (data, isBinary) =>
      messages.push({ data: data as Buffer, isBinary }),
    );
    ws.on("close", (code, reason) => closes.push({ code, reason: reason.toString() }));
    ws.on("error", (err) => {
      const res = (err as { request?: { res?: unknown } }).request?.res as
        | { statusCode?: number }
        | undefined;
      const status = res?.statusCode ?? 0;
      if (status) ws.emit("status", status);
    });
    ws.on("open", () => resolve({ ws, messages, closes }));
    setTimeout(() => reject(new Error("ws open timeout")), 3000);
  });
}

function expectRejected(url: string, expectedStatus: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    openSockets.push(ws);
    ws.on("error", () => undefined);
    ws.on("unexpected-response", (_req, res: IncomingMessage) => {
      res.resume();
      if (res.statusCode === expectedStatus) resolve();
      else reject(new Error(`expected status ${expectedStatus}, got ${res.statusCode}`));
    });
    ws.on("open", () => reject(new Error("expected rejection, got open")));
    setTimeout(() => reject(new Error("rejection status timeout")), 3000);
  });
}

async function handshake(
  ws: WsClient,
  messages: Array<{ data: string | Buffer; isBinary: boolean }>,
  token: string,
): Promise<string> {
  await waitFor(() => messages.some((m) => String(m.data).includes('"hello"')));
  ws.send(JSON.stringify({ type: "auth_request", method: "token", token }));
  await waitFor(() =>
    messages.some((m) => String(m.data).includes('"auth_ok"')),
  );
  const hello = messages.find((m) => String(m.data).includes('"hello"'))!;
  return String(hello.data);
}

describe("WS device/type/session routing", () => {
  it("routes an unselected connection to the default target", async () => {
    const { port } = await makeRelay();
    const { ws, messages } = await connectWs(`ws://127.0.0.1:${port}/ws`);
    await handshake(ws, messages, "relaytok");
    ws.send(JSON.stringify({ type: "data", data: "ping" }));
    await waitFor(() =>
      messages.some((m) => String(m.data) === '{"type":"data","data":"[A]ping"}'),
    );
  });

  it("routes a connection to the requested device via ?device=", async () => {
    const { port } = await makeRelay();
    const { ws, messages } = await connectWs(
      `ws://127.0.0.1:${port}/ws?device=beta&type=ssh`,
    );
    await handshake(ws, messages, "relaytok");
    ws.send(JSON.stringify({ type: "data", data: "ping" }));
    await waitFor(() =>
      messages.some((m) => String(m.data) === '{"type":"data","data":"[B]ping"}'),
    );
  });

  it("rejects an unknown device at upgrade time", async () => {
    const { port } = await makeRelay();
    await expectRejected(`ws://127.0.0.1:${port}/ws?device=nope`, 404);
  });

  it("rejects a device/target type mismatch at upgrade time", async () => {
    const { port } = await makeRelay();
    await expectRejected(`ws://127.0.0.1:${port}/ws?device=alpha&type=ssh`, 404);
  });

  it("rejects an invalid session type at upgrade time", async () => {
    const { port } = await makeRelay();
    await expectRejected(`ws://127.0.0.1:${port}/ws?device=alpha&type=warp`, 404);
  });

  it("routes a session to the device it was created on", async () => {
    const { port } = await makeRelay();
    const sid = await login(port, { username: "alice", password: "secret" });
    const created = await api(port, "/api/devices/beta/sessions", {
      method: "POST",
      token: sid,
      body: { type: "ssh" },
    });
    const session = (created.json as { session: { id: string } }).session;
    const connect = (created.json as { connect: { path: string } }).connect;

    const { ws, messages } = await connectWs(`ws://127.0.0.1:${port}${connect.path}`);
    await handshake(ws, messages, sid);
    ws.send(JSON.stringify({ type: "data", data: "ping" }));
    await waitFor(() =>
      messages.some((m) => String(m.data) === '{"type":"data","data":"[B]ping"}'),
    );

    expect(session.id).toBe(connect.path.split("session=")[1]);
  });

  it("refuses an unknown or closed GUI session id", async () => {
    const { port } = await makeRelay();
    await expectRejected(
      `ws://127.0.0.1:${port}/ws?device=alpha&type=shell&session=does-not-exist`,
      403,
    );
  });

  it("terminates a connection when the web session token is invalid", async () => {
    const { port } = await makeRelay();
    const sid = await login(port, { token: "relaytok" });
    const created = await api(port, "/api/devices/alpha/sessions", {
      method: "POST",
      token: sid,
      body: { type: "shell" },
    });
    const connect = (created.json as { connect: { path: string } }).connect;

    const { ws, messages, closes } = await connectWs(`ws://127.0.0.1:${port}${connect.path}`);
    await waitFor(() => messages.some((m) => String(m.data).includes('"hello"')));
    ws.send(JSON.stringify({ type: "auth_request", method: "token", token: "not-a-web-token" }));
    await waitFor(() =>
      messages.some((m) => String(m.data).includes('"auth_fail"')),
    );
    await waitFor(() => closes.length > 0, 5000);
  });

  it("rejects a user trying to attach to someone else's session", async () => {
    const { port } = await makeRelay();
    const alice = await login(port, { username: "alice", password: "secret" });
    const bob = await login(port, { username: "bob", password: "pw" });
    const created = await api(port, "/api/devices/alpha/sessions", {
      method: "POST",
      token: alice,
      body: { type: "shell" },
    });
    const connect = (created.json as { connect: { path: string } }).connect;

    const { ws, messages, closes } = await connectWs(`ws://127.0.0.1:${port}${connect.path}`);
    await handshake(ws, messages, bob);
    await waitFor(() => closes.length > 0, 5000);
    expect(closes[0].reason).toMatch(/does not belong/i);
  }, 10000);

  it("closes the terminal when the session is deleted via the API", async () => {
    const { port } = await makeRelay();
    const sid = await login(port, { username: "alice", password: "secret" });
    const created = await api(port, "/api/devices/alpha/sessions", {
      method: "POST",
      token: sid,
      body: { type: "shell" },
    });
    const session = (created.json as { session: { id: string } }).session;
    const connect = (created.json as { connect: { path: string } }).connect;

    const { ws, messages, closes } = await connectWs(`ws://127.0.0.1:${port}${connect.path}`);
    await handshake(ws, messages, sid);
    ws.send(JSON.stringify({ type: "data", data: "hi" }));
    await waitFor(() =>
      messages.some((m) => String(m.data).includes('"[A]hi"')),
    );

    const del = await api(port, `/api/sessions/${session.id}`, {
      method: "DELETE",
      token: sid,
    });
    expect(del.status).toBe(200);
    await waitFor(() => closes.length > 0, 5000);
  });
});
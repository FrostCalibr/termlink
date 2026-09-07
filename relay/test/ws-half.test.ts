import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { WebSocketClientHalf } from "../src/ws-client-half.js";
import type { WebSocketConfig } from "../src/config.js";
import { CredentialStore } from "../../server/src/auth.js";
import type { RelaySession } from "../src/session.js";

const cfg: WebSocketConfig = {
  host: "127.0.0.1",
  port: 0,
  maxConnections: 10,
  maxMessageSize: 1024 * 1024,
  authTimeoutMs: 2000,
  idleTimeoutMs: 10_000,
  allowedOrigins: [],
  sendHighWaterMark: 2000,
  sendLowWaterMark: 1000,
};

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const sessions = new (class {
  create(connectionId: string): { id: string } {
    return { id: `s-${connectionId}` };
  }
  removeByConnectionId(): void {
    /* no-op for unit tests */
  }
})();

const auth = new CredentialStore(["relaytok"], new Map());

type SendRecord = { data: string | Buffer; binary: boolean };

/** Minimal stand-in for ws.WebSocket, driven as an EventEmitter. */
class StubSocket extends EventEmitter {
  sends: SendRecord[] = [];
  private sendCbs = new Map<number, () => void>();
  readyStateNow = 1;

  get readyState(): number {
    return this.readyStateNow;
  }

  send(data: string | Buffer, cb?: () => void): void {
    const idx = this.sends.length;
    this.sends.push({ data, binary: Buffer.isBuffer(data) });
    if (cb) this.sendCbs.set(idx, cb);
  }

  ackAll(): void {
    for (const idx of [...this.sendCbs.keys()]) this.sendCbs.get(idx)!();
    this.sendCbs.clear();
  }

  close(code = 1000, reason = ""): void {
    this.readyStateNow = 3;
    this.emit("close", code, Buffer.from(reason));
  }

  terminate(): void {
    this.readyStateNow = 3;
    this.emit("close", 1006, Buffer.from(""));
  }

  hasText(text: string): boolean {
    return this.sends.some((s) => !s.binary && String(s.data).includes(text));
  }
}

function makeHalf(): { sock: StubSocket; half: WebSocketClientHalf } {
  const sock = new StubSocket();
  const half = new WebSocketClientHalf({
    ws: sock as never,
    auth,
    sessions: sessions as never,
    maxAuthAttempts: 3,
    authBackoffMs: 1000,
    authTimeoutMs: cfg.authTimeoutMs,
    idleTimeoutMs: cfg.idleTimeoutMs,
    sendHighWaterMark: cfg.sendHighWaterMark,
    sendLowWaterMark: cfg.sendLowWaterMark,
    logger: silentLogger,
    onAuthenticated: () => undefined,
    onClose: () => undefined,
  });
  half.start();
  return { sock, half };
}

function fakeBridge(onDrained: () => void): RelaySession {
  return {
    onClientData: () => undefined,
    onClientBinary: () => undefined,
    onClientDrained: onDrained,
    terminate: () => undefined,
  } as RelaySession;
}

/** Drive the fake socket through the auth handshake. */
async function authenticate(
  half: WebSocketClientHalf,
  sock: StubSocket,
): Promise<void> {
  sock.emit(
    "message",
    Buffer.from('{"type":"auth_request","method":"token","token":"relaytok"}'),
    false,
  );
  const start = Date.now();
  while (!sock.hasText('"auth_ok"')) {
    if (Date.now() - start > 3000) throw new Error("auth_ok not sent in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function dataFrame(payload: string): string {
  return JSON.stringify({ type: "data", data: payload });
}

describe("WebSocketClientHalf", () => {
  it("greets with hello on start and authenticates via replayed server Protocol", async () => {
    const { sock, half } = makeHalf();
    expect(sock.hasText('"hello"')).toBe(true);
    expect(sock.sends[0].binary).toBe(false);
    await authenticate(half, sock);
    expect(half.hasSession).toBe(true);
    half.terminate();
  });

  it("reports backpressure on forward and drains once acknowledged past low water", async () => {
    const { sock, half } = makeHalf();
    let drained = 0;
    half.attachBridge(fakeBridge(() => drained++));
    await authenticate(half, sock);

    // ~223-byte frames fill the 2000-byte high-water mark in flight (no acks
    // yet, so 8 * 223 = 1784 bytes sent; the 9th reports pressure).
    const results: boolean[] = [];
    for (let i = 0; i < 20 && results.at(-1) !== false; i++) {
      results.push(half.forward({ type: "data", data: "z".repeat(200) }));
    }
    expect(results.filter(Boolean).length).toBe(8);
    expect(results.filter((r) => !r).length).toBe(1);
    expect(drained).toBe(0);

    sock.ackAll();
    expect(drained).toBe(1);
    half.terminate();
  });

  it("stops forwarding once terminated", () => {
    const { sock, half } = makeHalf();
    half.terminate("done");
    expect(half.forward({ type: "data", data: "x" })).toBe(false);
    expect(sock.readyState).toBe(3);
  });

  it("buffers inbound while paused and terminates on overflow", async () => {
    const { sock, half } = makeHalf();
    await authenticate(half, sock);
    const closes: number[] = [];
    sock.on("close", (code: number) => closes.push(code));

    half.pause();
    for (let i = 0; i < 1100; i++) {
      sock.emit("message", Buffer.from(dataFrame("x")), false);
    }
    await new Promise((r) => setTimeout(r, 10));
    expect(closes.length).toBeGreaterThan(0);
    expect(half.forward({ type: "data", data: "x" })).toBe(false);
  });

  it("rejects malformed protocol messages", async () => {
    const { sock, half } = makeHalf();
    await authenticate(half, sock);
    const closes: number[] = [];
    sock.on("close", (code: number) => closes.push(code));
    sock.emit("message", Buffer.from('{"not-a-message":true}'), false);
    await new Promise((r) => setTimeout(r, 10));
    expect(closes.length).toBeGreaterThan(0);
  });

  it("sends a goodbye before closing when terminating after auth", async () => {
    const { sock, half } = makeHalf();
    await authenticate(half, sock);
    half.terminate("client went away");
    expect(sock.hasText("goodbye")).toBe(true);
    expect(sock.hasText("client went away")).toBe(true);
    expect(sock.readyState).toBe(3);
  });
});
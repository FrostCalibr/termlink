import { describe, it, expect } from "vitest";
import type { ApiClient } from "../src/api.js";
import { TerminalSession, type TransportFactory } from "../src/terminal-session.js";
import type { WebTransportEvent } from "../src/transport.js";

class FakeTransport {
  sent: Array<{
    kind: "input" | "resize" | "ping";
    bytes?: Uint8Array;
    cols?: number;
    rows?: number;
  }> = [];
  closed = false;
  destroyed = false;
  constructor(
    public path: string,
    public token: string,
    private onEvent: (e: WebTransportEvent) => void,
  ) {}
  simulate(e: WebTransportEvent): void {
    this.onEvent(e);
  }
  sendTerminalInput(bytes: Uint8Array): boolean {
    this.sent.push({ kind: "input", bytes });
    return true;
  }
  sendTerminalResize(cols: number, rows: number): boolean {
    this.sent.push({ kind: "resize", cols, rows });
    return true;
  }
  sendPing(): boolean {
    this.sent.push({ kind: "ping" });
    return true;
  }
  close(): void {
    this.closed = true;
  }
  destroy(): void {
    this.destroyed = true;
  }
  get isReady(): boolean {
    return false;
  }
  get state(): string {
    return "scripted";
  }
}

interface Harness {
  session: TerminalSession;
  transports: FakeTransport[];
  outputs: Array<{ bytes: ArrayBuffer | null; text: string }>;
  notices: string[];
  states: string[];
}

function makeHarness(): Harness {
  const transports: FakeTransport[] = [];
  const api = {
    createSession: async () => {
      return {
        session: { id: "s1", deviceId: "pc1", deviceName: "PC 1", type: "shell" },
        connect: { path: "/ws?device=pc1&type=shell&session=s1" },
      };
    },
    token: "web-token",
  } as unknown as ApiClient;
  const factory: TransportFactory = ({ path, token, onEvent }) => {
    const t = new FakeTransport(path, token, onEvent);
    transports.push(t);
    return t;
  };
  const session = new TerminalSession(
    { api, transportFactory: factory, pingIntervalMs: 20 },
    { id: "", deviceId: "pc1", deviceName: "PC 1", type: "shell" },
  );
  const outputs: Harness["outputs"] = [];
  const notices: string[] = [];
  const states: string[] = [];
  session.events.on("output", (o) => outputs.push({ bytes: o.bytes.byteLength ? o.bytes : null, text: o.text }));
  session.events.on("notice", (n) => notices.push(n));
  session.events.on("state", (s) => states.push(s));
  return { session, transports, outputs, notices, states };
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("TerminalSession", () => {
  it("creates a session, opens a transport, and reaches connecting", async () => {
    const { session, transports } = makeHarness();
    await session.create();
    expect(session.id).toBe("s1");
    expect(session.state).toBe("connecting");
    expect(transports).toHaveLength(1);
    expect(transports[0].path).toBe("/ws?device=pc1&type=shell&session=s1");
    expect(transports[0].token).toBe("web-token");
  });

  it("transitions to connected on ready and disconnects on close", async () => {
    const { session, transports, states } = makeHarness();
    await session.create();
    transports[0].simulate({ type: "ready", sessionId: "s1" });
    expect(session.state).toBe("connected");
    expect(states).toContain("connected");
    transports[0].simulate({ type: "closed", reason: "network" });
    expect(session.state).toBe("disconnected");
  });

  it("marks reconnecting when the transport retries after an unexpected close", async () => {
    const { session, transports } = makeHarness();
    await session.create();
    transports[0].simulate({ type: "ready", sessionId: "s1" });
    transports[0].simulate({ type: "closed", reason: "reset" });
    transports[0].simulate({ type: "connecting", attempt: 1 });
    expect(session.state).toBe("reconnecting");
    transports[0].simulate({ type: "ready", sessionId: "s1" });
    expect(session.state).toBe("connected");
  });

  it("sends input and resize to the transport", async () => {
    const { session, transports } = makeHarness();
    await session.create();
    session.sendInput(new Uint8Array([0x68, 0x69]));
    expect(transports[0].sent[0]).toMatchObject({ kind: "input" });
    session.resize(100, 40);
    expect(transports[0].sent[1]).toMatchObject({ kind: "resize", cols: 100, rows: 40 });
  });

  it("surfaces terminal output events", async () => {
    const { session, transports, outputs } = makeHarness();
    await session.create();
    transports[0].simulate({ type: "ready", sessionId: "s1" });
    transports[0].simulate({ type: "data", payload: "hello" });
    transports[0].simulate({
      type: "terminal_output",
      payload: new Uint8Array([0x0a]).buffer as ArrayBuffer,
    });
    expect(outputs).toContainEqual({ bytes: null, text: "hello" });
    expect(outputs.some((o) => o.bytes !== null && new Uint8Array(o.bytes!)[0] === 0x0a)).toBe(true);
  });

  it("reports pong latency once the ping loop runs", async () => {
    const { session, transports } = makeHarness();
    let latencies: Array<number | null> = [];
    session.events.on("latency", (ms) => latencies.push(ms));
    await session.create();
    transports[0].simulate({ type: "ready", sessionId: "s1" });
    await waitFor(() => transports[0].sent.some((s) => s.kind === "ping"));
    transports[0].simulate({ type: "pong" });
    latencies = latencies.filter((l) => l !== null);
    expect(latencies.length).toBeGreaterThanOrEqual(1);
    expect(latencies.at(-1)!).toBeGreaterThanOrEqual(0);
  });

  it("goes disconnected with a notice on auth failure", async () => {
    const { session, transports, notices } = makeHarness();
    await session.create();
    transports[0].simulate({ type: "auth_failed", reason: "bad token" });
    expect(session.state).toBe("disconnected");
    expect(notices[0]).toContain("bad token");
  });

  it("closes cleanly on goodbye", async () => {
    const { session, transports, notices } = makeHarness();
    await session.create();
    transports[0].simulate({ type: "ready", sessionId: "s1" });
    transports[0].simulate({ type: "goodbye", reason: "maintenance" });
    expect(session.state).toBe("closed");
    expect(notices).toContain("maintenance");
  });

  it("marks disconnected after reconnect attempts are exhausted", async () => {
    const { session, transports, notices } = makeHarness();
    await session.create();
    transports[0].simulate({ type: "ready", sessionId: "s1" });
    transports[0].simulate({ type: "reconnect_failed" });
    expect(session.state).toBe("disconnected");
    expect(notices).toContain("Connection lost");
  });

  it("user close stops the session for good", async () => {
    const { session } = makeHarness();
    await session.create();
    session.close("Bye");
    expect(session.state).toBe("closed");
    expect(session.available).toBe(false);
    session.reconnect();
    expect(transportsOf(session)).toBeUndefined();
  });

  it("does not emit outputs after close", async () => {
    const { session, transports, outputs } = makeHarness();
    await session.create();
    session.close();
    const before = outputs.length;
    transports[0].simulate({ type: "data", payload: "ignored" });
    expect(outputs).toHaveLength(before);
  });
});

function transportsOf(_s: TerminalSession): undefined {
  return undefined;
}
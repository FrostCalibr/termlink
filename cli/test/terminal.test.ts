import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { buildWsUrl, runCliTerminal } from "../src/terminal.js";
import type { CliConfig } from "../src/config.js";

class FakeWebSocket extends EventEmitter {
  readyState = 1; // OPEN
  sent: string[] = [];

  constructor(public url: string) {
    super();
    setImmediate(() => this.emit("open"));
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3; // CLOSED
    this.emit("close");
  }

  simulateServerMessage(msg: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(msg)), false);
  }
}

describe("CLI Terminal Runner", () => {
  const dummyConfig: CliConfig = {
    relayUrl: "http://127.0.0.1:19001",
    sessionToken: "cli-token",
    username: "alice",
  };

  it("builds correct WebSocket URLs", () => {
    expect(buildWsUrl("http://127.0.0.1:19001", "/ws?device=pc1")).toBe(
      "ws://127.0.0.1:19001/ws?device=pc1",
    );
    expect(buildWsUrl("https://relay.example.com", "ws?device=pc1")).toBe(
      "wss://relay.example.com/ws?device=pc1",
    );
  });

  it("authenticates on hello and streams stdout/stdin bytes", async () => {
    let fakeWs: FakeWebSocket | null = null;
    const stdoutData: string[] = [];
    const stdinStream = new EventEmitter() as any;
    stdinStream.isTTY = false;
    stdinStream.resume = vi.fn();
    stdinStream.pause = vi.fn();

    const stdoutStream = {
      isTTY: false,
      columns: 100,
      rows: 40,
      write: (data: string | Buffer) => {
        stdoutData.push(typeof data === "string" ? data : data.toString("utf-8"));
      },
    } as any;

    const termPromise = runCliTerminal({
      config: dummyConfig,
      connectPath: "/ws?device=pc1&type=shell&session=s1",
      stdout: stdoutStream,
      stdin: stdinStream,
      createWebSocket: (url) => {
        fakeWs = new FakeWebSocket(url);
        return fakeWs as any;
      },
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(fakeWs).not.toBeNull();
    expect(fakeWs!.url).toBe("ws://127.0.0.1:19001/ws?device=pc1&type=shell&session=s1");

    // Server sends hello
    fakeWs!.simulateServerMessage({ type: "hello", auth_methods: ["token"] });

    // Client responds with auth_request
    expect(fakeWs!.sent.some((s) => s.includes("auth_request"))).toBe(true);

    // Server sends auth_ok
    fakeWs!.simulateServerMessage({ type: "auth_ok", session_id: "s1" });

    // Client sends terminal_resize with columns 100, rows 40
    expect(fakeWs!.sent.some((s) => s.includes("terminal_resize"))).toBe(true);

    // Server sends terminal_output
    const base64Output = Buffer.from("Welcome to termlink CLI\r\n").toString("base64");
    fakeWs!.simulateServerMessage({ type: "terminal_output", data: base64Output });

    expect(stdoutData.join("")).toContain("Welcome to termlink CLI");

    // Client sends stdin input
    stdinStream.emit("data", Buffer.from("ls -la\n"));
    expect(fakeWs!.sent.some((s) => s.includes("terminal_input"))).toBe(true);

    // Server sends goodbye
    fakeWs!.simulateServerMessage({ type: "goodbye", reason: "Session ended" });

    const exitCode = await termPromise;
    expect(exitCode).toBe(0);
  });
});

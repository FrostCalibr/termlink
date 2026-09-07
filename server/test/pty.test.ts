import { describe, it, expect, afterEach } from "vitest";
import { TcpServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import {
  TcpClient,
  type TransportEvent,
} from "../../client/src/transport.js";
import type { ClientConfig } from "../../client/src/config.js";

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const servers: TcpServer[] = [];
const clients: TcpClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.destroy();
  for (const s of servers.splice(0)) await s.close().catch(() => undefined);
});

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function ptyConfig(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    HOST: "127.0.0.1",
    PORT: "0",
    MAX_FRAME_SIZE: "65536",
    MAX_CONNECTIONS: "10",
    IDLE_TIMEOUT_MS: "10000",
    MAX_AUTH_ATTEMPTS: "3",
    AUTH_BACKOFF_MS: "50",
    AUTH_TOKENS: "dev-token",
    PTY_ENABLED: "true",
    PTY_SHELL: "/bin/sh",
    PTY_COLS: "80",
    PTY_ROWS: "24",
    PTY_CWD: process.env.HOME ?? process.cwd(),
    ...overrides,
  };
}

async function startServer(env: Record<string, string>): Promise<TcpServer> {
  const server = new TcpServer({ config: loadConfig(env), logger: silentLogger });
  await server.listen();
  servers.push(server);
  return server;
}

interface Connected {
  client: TcpClient;
  events: TransportEvent[];
}

async function connectClient(server: TcpServer): Promise<Connected> {
  const events: TransportEvent[] = [];
  const cfg: ClientConfig = {
    host: "127.0.0.1",
    port: server.port,
    token: "dev-token",
    username: undefined,
    password: undefined,
    connectTimeoutMs: 5000,
    idleTimeoutMs: 30000,
    maxFrameSize: 65536,
    reconnect: false,
    reconnectDelayMs: 0,
    maxReconnectAttempts: 0,
  };
  const client = new TcpClient({ config: cfg, logger: silentLogger, onEvent: (e) => events.push(e) });
  await client.connect();
  await waitFor(() => events.some((e) => e.type === "ready"));
  clients.push(client);
  return { client, events };
}

/** Concatenate all terminal_output payloads, decoded byte-for-byte. */
function outputBytes(events: TransportEvent[]): number[] {
  const bytes: number[] = [];
  for (const e of events) {
    if (e.type === "terminal_output") {
      bytes.push(...Buffer.from(e.payload, "base64"));
    }
  }
  return bytes;
}

function containsSeq(haystack: number[], needle: number[]): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

const toBytes = (s: string): number[] => [...Buffer.from(s, "utf-8")];

async function sendCommand(client: TcpClient, command: string): Promise<void> {
  client.sendTerminalInput(Buffer.from(command).toString("base64"));
}

describe("PTY backend", () => {
  it("spawns an isolated shell per connection and streams interactive output", async () => {
    const server = await startServer(ptyConfig());
    const { client, events } = await connectClient(server);
    expect(server.ptyCount).toBe(1);

    await sendCommand(client, "printf 'PTYMARKER12345'\n");
    await waitFor(() => containsSeq(outputBytes(events), toBytes("PTYMARKER12345")));

    client.close();
    await waitFor(() => server.ptyCount === 0);
  });

  it("streams byte-exact multi-byte output (UTF-8 octets survive unaltered)", async () => {
    const server = await startServer(ptyConfig());
    const { client, events } = await connectClient(server);

    await sendCommand(client, "printf 'caf\\303\\251'\n");
    await waitFor(() => containsSeq(outputBytes(events), [0x63, 0x61, 0x66, 0xc3, 0xa9]));

    client.close();
    await waitFor(() => server.ptyCount === 0);
  });

  it("applies terminal_resize to the PTY winsize", async () => {
    const server = await startServer(ptyConfig());
    const { client, events } = await connectClient(server);

    client.sendTerminalResize(100, 50);
    await sendCommand(client, "stty size\n");

    // GNU stty size prints "<rows> <cols>": expect rows 50, cols 100.
    await waitFor(() => containsSeq(outputBytes(events), toBytes("50 100")));

    client.close();
    await waitFor(() => server.ptyCount === 0);
  });

  it("isolates concurrent PTY sessions", async () => {
    const server = await startServer(ptyConfig());
    const a = await connectClient(server);
    const b = await connectClient(server);
    expect(server.ptyCount).toBe(2);

    await sendCommand(a.client, "printf 'AAA-SECRET-1'\n");
    await sendCommand(b.client, "printf 'BBB-SECRET-2'\n");
    await waitFor(() => containsSeq(outputBytes(a.events), toBytes("AAA-SECRET-1")));
    await waitFor(() => containsSeq(outputBytes(b.events), toBytes("BBB-SECRET-2")));
    await new Promise((r) => setTimeout(r, 50));

    expect(containsSeq(outputBytes(a.events), toBytes("BBB-SECRET-2"))).toBe(false);
    expect(containsSeq(outputBytes(b.events), toBytes("AAA-SECRET-1"))).toBe(false);

    a.client.close();
    b.client.close();
    await waitFor(() => server.ptyCount === 0);
  });

  it("kills the PTY when the client disconnects", async () => {
    const server = await startServer(ptyConfig());
    const { client, events } = await connectClient(server);
    expect(server.ptyCount).toBe(1);

    client.destroy();
    await waitFor(() => events.some((e) => e.type === "disconnected"));
    await waitFor(() => server.ptyCount === 0);

    // A fresh connection must get a fresh, single PTY (no duplicates).
    const again = await connectClient(server);
    expect(server.ptyCount).toBe(1);
    await sendCommand(again.client, "printf 'SECOND-LIFE'\n");
    await waitFor(() => containsSeq(outputBytes(again.events), toBytes("SECOND-LIFE")));
    again.client.close();
    await waitFor(() => server.ptyCount === 0);
  });

  it("terminates the connection gracefully when the shell exits", async () => {
    const server = await startServer(ptyConfig());
    const { client, events } = await connectClient(server);

    await sendCommand(client, "exit\n");
    await waitFor(() => events.some((e) => e.type === "goodbye"));
    const goodbye = events.find((e) => e.type === "goodbye");
    expect((goodbye as { reason?: string } | undefined)?.reason).toContain("Terminal");

    client.close();
    await waitFor(() => server.ptyCount === 0);
  });

  it("terminates gracefully when the configured shell path is invalid", async () => {
    const server = await startServer(ptyConfig({ PTY_SHELL: "/nonexistent/shell" }));
    const { client, events } = await connectClient(server);

    await waitFor(() => events.some((e) => e.type === "goodbye"));
    const goodbye = events.find((e) => e.type === "goodbye");
    expect((goodbye as { reason?: string } | undefined)?.reason).toContain("Terminal");

    client.close();
    await waitFor(() => server.ptyCount === 0);
  });

  it("cleans up all PTYs on server shutdown", async () => {
    const server = await startServer(ptyConfig());
    servers.splice(servers.indexOf(server), 1); // close() is called here explicitly
    await connectClient(server);
    await connectClient(server);
    expect(server.ptyCount).toBe(2);

    await server.close();
    expect(server.ptyCount).toBe(0);
  });

  it("does not spawn PTYs when PTY_ENABLED is off", async () => {
    const server = await startServer(ptyConfig({ PTY_ENABLED: "false" }));
    const { client } = await connectClient(server);
    expect(server.ptyCount).toBe(0);
    client.close();
  });
});
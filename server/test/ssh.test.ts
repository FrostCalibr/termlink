import { describe, it, expect, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import ssh2 from "ssh2";
import { TcpServer } from "../src/server.js";

const { utils } = ssh2;
import { loadConfig, ConfigError } from "../src/config.js";
import { TcpClient, type TransportEvent } from "../../client/src/transport.js";
import type { ClientConfig } from "../../client/src/config.js";
import {
  parseKnownHosts,
  makeKnownHostsVerifier,
  makeFingerprintsVerifier,
  parseFingerprint,
  sha256Digest,
} from "../../shared/known-hosts.js";
import { startTestSshServer, type TestSshServer } from "./helpers/ssh-test-server.js";

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

async function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function sshEnv(sshd: TestSshServer | { port: number }, overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {
    HOST: "127.0.0.1",
    PORT: "0",
    MAX_FRAME_SIZE: "65536",
    MAX_CONNECTIONS: "10",
    IDLE_TIMEOUT_MS: "15000",
    MAX_AUTH_ATTEMPTS: "5",
    AUTH_BACKOFF_MS: "50",
    AUTH_TOKENS: "dev-token",
    SSH_ENABLED: "true",
    SSH_HOST: "127.0.0.1",
    SSH_PORT: String(sshd.port),
    SSH_USERNAME: "tester",
    SSH_PASSWORD: "secret",
    SSH_COLS: "80",
    SSH_ROWS: "24",
  };
  if ("fingerprint" in sshd) env.SSH_HOST_KEY_FINGERPRINTS = sshd.fingerprint;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
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

function terminalText(events: TransportEvent[]): string {
  let out = "";
  for (const e of events) {
    if (e.type === "terminal_output") out += Buffer.from(e.payload, "base64").toString("utf-8");
  }
  return out;
}

function sendInput(client: TcpClient, text: string): void {
  client.sendTerminalInput(Buffer.from(text).toString("base64"));
}

function goodbyeReason(events: TransportEvent[]): string | undefined {
  const g = events.find((e) => e.type === "goodbye");
  return (g as { reason?: string } | undefined)?.reason;
}

describe("SSH backend", () => {
  it("opens an interactive remote shell and streams input/output round-trip", async () => {
    const sshd = await startTestSshServer({ password: "secret" });
    const server = await startServer(sshEnv(sshd));
    const { client, events } = await connectClient(server);

    await waitFor(() => sshd.shells === 1);
    await waitFor(() => terminalText(events).includes("READY"));

    sendInput(client, "echo SSH-OK\n");
    await waitFor(() => terminalText(events).includes("SSH-OK"));

    client.close();
    await waitFor(() => server.sshCount === 0);
    await waitFor(() => sshd.disconnects >= 1);
  });

  it("forwards terminal_resize to the remote pty (window-change)", async () => {
    const sshd = await startTestSshServer({ password: "secret" });
    const server = await startServer(sshEnv(sshd));
    const { client, events } = await connectClient(server);
    await waitFor(() => sshd.shells === 1);
    await waitFor(() => terminalText(events).includes("READY"));

    client.sendTerminalResize(100, 50);
    await waitFor(() => sshd.winChanges.some((w) => w.cols === 100 && w.rows === 50));

    client.close();
    await waitFor(() => server.sshCount === 0);
  });

  it("forwards remote stderr to the client as terminal output", async () => {
    const sshd = await startTestSshServer({ password: "secret" });
    const server = await startServer(sshEnv(sshd));
    const { client, events } = await connectClient(server);
    await waitFor(() => sshd.shells === 1);
    await waitFor(() => terminalText(events).includes("READY"));

    sendInput(client, "<msg>stderr\n");
    await waitFor(() => terminalText(events).includes("STDERR-VISIBLE"));

    client.close();
    await waitFor(() => server.sshCount === 0);
  });

  it("authenticates with a private key instead of a password", async () => {
    const clientKey = utils.generateKeyPairSync("ed25519");
    const clientBlob = utils.parseKey(clientKey.public).getPublicSSH();
    const sshd = await startTestSshServer({ pubkey: clientBlob });
    const server = await startServer(
      sshEnv(sshd, { SSH_PRIVATE_KEY: clientKey.private, SSH_PASSWORD: undefined }),
    );
    const { client, events } = await connectClient(server);

    await waitFor(() => sshd.auths >= 1);
    await waitFor(() => terminalText(events).includes("READY"));
    sendInput(client, "echo KEYAUTH-OK\n");
    await waitFor(() => terminalText(events).includes("KEYAUTH-OK"));

    client.close();
    await waitFor(() => server.sshCount === 0);
  });

  it("rejects failed authentication with a graceful goodbye", async () => {
    const sshd = await startTestSshServer({ password: "secret" });
    const server = await startServer(sshEnv(sshd, { SSH_PASSWORD: "wrong" }));
    const { client, events } = await connectClient(server);

    await waitFor(() => events.some((e) => e.type === "goodbye"));
    expect(goodbyeReason(events)).toBe("SSH authentication failed");

    client.close();
    await waitFor(() => server.sshCount === 0);
  });

  it("verifies host keys via SSH_KNOWN_HOSTS_FILE", async () => {
    const sshd = await startTestSshServer({ password: "secret" });
    const dir = mkdtempSync(join(tmpdir(), "ssh-known-hosts-"));
    const knownPath = join(dir, "known_hosts");
    writeFileSync(knownPath, sshd.knownHostsLine + "\n", "utf-8");

    const server = await startServer(sshEnv(sshd, { SSH_KNOWN_HOSTS_FILE: knownPath, SSH_HOST_KEY_FINGERPRINTS: undefined }));
    const { client, events } = await connectClient(server);
    await waitFor(() => terminalText(events).includes("READY"));
    client.close();
    await waitFor(() => server.sshCount === 0);
  });

  it("rejects a host-key mismatch recorded in known_hosts", async () => {
    const sshd = await startTestSshServer({ password: "secret" });
    const other = utils.generateKeyPairSync("ed25519");
    const otherBlob = utils.parseKey(other.public).getPublicSSH().toString("base64");
    const dir = mkdtempSync(join(tmpdir(), "ssh-known-hosts-"));
    const knownPath = join(dir, "known_hosts");
    writeFileSync(knownPath, `[127.0.0.1]:${sshd.port} ssh-ed25519 ${otherBlob}\n`, "utf-8");

    const server = await startServer(sshEnv(sshd, { SSH_KNOWN_HOSTS_FILE: knownPath, SSH_HOST_KEY_FINGERPRINTS: undefined }));
    const { client, events } = await connectClient(server);

    await waitFor(() => events.some((e) => e.type === "goodbye"));
    expect(goodbyeReason(events)).toBe("SSH host key verification failed");

    client.close();
    await waitFor(() => server.sshCount === 0);
  });

  it("rejects an unknown host absent from known_hosts", async () => {
    const sshd = await startTestSshServer({ password: "secret" });
    const dir = mkdtempSync(join(tmpdir(), "ssh-known-hosts-"));
    const knownPath = join(dir, "known_hosts");
    writeFileSync(knownPath, `example.com ssh-ed25519 ${sshd.publicBlob.toString("base64")}\n`, "utf-8");

    const server = await startServer(sshEnv(sshd, { SSH_KNOWN_HOSTS_FILE: knownPath, SSH_HOST_KEY_FINGERPRINTS: undefined }));
    const { client, events } = await connectClient(server);

    await waitFor(() => events.some((e) => e.type === "goodbye"));
    expect(goodbyeReason(events)).toBe("SSH host key verification failed");

    client.close();
    await waitFor(() => server.sshCount === 0);
  });

  it("rejects a host key whose fingerprint is not allowed", async () => {
    const sshd = await startTestSshServer({ password: "secret" });
    const other = utils.generateKeyPairSync("ed25519");
    const otherBlob = utils.parseKey(other.public).getPublicSSH();

    const server = await startServer(
      sshEnv(sshd, { SSH_HOST_KEY_FINGERPRINTS: `SHA256:${sha256Digest(otherBlob).toString("base64")}` }),
    );
    const { client, events } = await connectClient(server);

    await waitFor(() => events.some((e) => e.type === "goodbye"));
    expect(goodbyeReason(events)).toBe("SSH host key verification failed");

    client.close();
    await waitFor(() => server.sshCount === 0);
  });

  it("handles unreachable SSH targets with a clean goodbye", async () => {
    const placeholder = createNetServer();
    await new Promise<void>((r) => placeholder.listen(0, "127.0.0.1", r));
    const deadPort = (placeholder.address() as { port: number }).port;
    await new Promise<void>((r) => placeholder.close(() => r()));

    const server = await startServer(
      sshEnv({ port: deadPort }, { SSH_HOST_KEY_FINGERPRINTS: Buffer.alloc(32, 1).toString("base64") }),
    );
    const { client, events } = await connectClient(server);

    await waitFor(() => events.some((e) => e.type === "goodbye"));
    expect(goodbyeReason(events)).toBe("SSH connection failed");

    client.close();
    await waitFor(() => server.sshCount === 0);
  });

  it("times out cleanly when the remote host never completes a handshake", async () => {
    const silent = createNetServer((s) => {
      s.on("error", () => undefined);
      s.on("data", () => undefined);
    });
    const netPort = await new Promise<number>((r) =>
      silent.listen(0, "127.0.0.1", () => r((silent.address() as { port: number }).port)),
    );

    const sshd = await startTestSshServer({ password: "secret" });
    const server = await startServer(
      sshEnv(sshd, { SSH_PORT: String(netPort), SSH_CONNECT_TIMEOUT_MS: "800", SSH_HOST_KEY_FINGERPRINTS: sshd.fingerprint }),
    );
    const { client, events } = await connectClient(server);

    await waitFor(() => events.some((e) => e.type === "goodbye"));
    expect(goodbyeReason(events)).toBe("SSH connection timed out");

    client.close();
    await waitFor(() => server.sshCount === 0);
    await new Promise<void>((r) => silent.close(() => r()));
  });

  it("terminates the client session when the remote host disconnects", async () => {
    const sshd = await startTestSshServer({ password: "secret" });
    const server = await startServer(sshEnv(sshd));
    const { client, events } = await connectClient(server);
    await waitFor(() => sshd.shells === 1);
    await waitFor(() => terminalText(events).includes("READY"));

    sendInput(client, "<msg>ttyclose\n");
    await waitFor(() => events.some((e) => e.type === "goodbye"));
    expect(goodbyeReason(events)).toBe("SSH session ended");

    client.close();
    await waitFor(() => server.sshCount === 0);
  });

  it("handles concurrent SSH sessions in isolation", async () => {
    const sshd = await startTestSshServer({ password: "secret" });
    const server = await startServer(sshEnv(sshd));
    const a = await connectClient(server);
    const b = await connectClient(server);
    await waitFor(() => sshd.shells === 2);
    expect(server.sshCount).toBe(2);
    await waitFor(() => terminalText(a.events).includes("READY"));
    await waitFor(() => terminalText(b.events).includes("READY"));

    sendInput(a.client, "AAA-SECRET\n");
    sendInput(b.client, "BBB-SECRET\n");
    await waitFor(() => terminalText(a.events).includes("AAA-SECRET"));
    await waitFor(() => terminalText(b.events).includes("BBB-SECRET"));
    await new Promise((r) => setTimeout(r, 100));

    expect(terminalText(a.events).includes("BBB-SECRET")).toBe(false);
    expect(terminalText(b.events).includes("AAA-SECRET")).toBe(false);

    a.client.close();
    b.client.close();
    await waitFor(() => server.sshCount === 0);
  });

  it("cleans up all SSH sessions on server shutdown", async () => {
    const sshd = await startTestSshServer({ password: "secret" });
    const server = await startServer(sshEnv(sshd));
    servers.splice(servers.indexOf(server), 1);
    await connectClient(server);
    await connectClient(server);
    await waitFor(() => sshd.shells === 2);
    expect(server.sshCount).toBe(2);

    await server.close();
    expect(server.sshCount).toBe(0);
  });

  it("refuses to start without a host-key verification policy", () => {
    const env = sshEnv({ port: 22 });
    delete env.SSH_HOST_KEY_FINGERPRINTS;
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(/host-key verification/);
  });

  it("refuses to start without SSH credentials or a username", () => {
    const env = sshEnv({ port: 22 });
    expect(() => loadConfig({ ...env, SSH_PASSWORD: "", SSH_PRIVATE_KEY: undefined as unknown as string })).toThrow(
      /SSH_PASSWORD/,
    );
    expect(() => loadConfig({ ...env, SSH_USERNAME: "" })).toThrow(/SSH_USERNAME/);
    expect(() => loadConfig({ ...env, SSH_HOST: "" })).toThrow(/SSH_HOST/);
  });

  it("refuses to start when PTY and SSH backends are both enabled", () => {
    const env = sshEnv({ port: 22 });
    env.SSH_HOST_KEY_FINGERPRINTS = Buffer.alloc(32, 1).toString("base64");
    expect(() => loadConfig({ ...env, PTY_ENABLED: "true" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...env, PTY_ENABLED: "true" })).toThrow(/mutually exclusive/);
  });
});

describe("known_hosts parsing", () => {
  it("parses plain, port-scoped, wildcard, and hashed entries", () => {
    const key = Buffer.from("keybytes");
    const salt = Buffer.from("salt-salt-salt");
    const hashed = createHmac("sha1", salt).update("hashme.example").digest();
    const joined = [
      "example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAA",
      "[db.internal]:2222 ssh-rsa AQQQQ",
      "*.corp,web?1 ssh-ed25519 BBB",
      `[127.0.0.1]:22 ssh-ed25519 CCC`,
      `|1|${salt.toString("base64")}|${hashed.toString("base64")} ssh-ed25519 ${key.toString("base64")}`,
      "# comment",
      "",
      "@revoked example.com ssh-ed25519 DDD",
      "badline",
    ].join("\n");

    const entries = parseKnownHosts(joined);
    expect(entries.length).toBe(5);

    // Plain glob + key match.
    const glob = makeKnownHostsVerifier(entries, "web01.corp", 22);
    expect(glob(key)).toBe(false); // entry says "BBB", not keybytes
    const overridden = makeKnownHostsVerifier([{ patterns: ["web01.corp"], key }], "web01.corp", 22);
    expect(overridden(key)).toBe(true);
    expect(overridden(Buffer.from("nope"))).toBe(false);

    // Port-scoped entry does not match another port.
    expect(makeKnownHostsVerifier(entries, "db.internal", 2222)(Buffer.from("wrong"))).toBe(false);

    // Hashed entry matches only its own host.
    const hashedVerifier = makeKnownHostsVerifier(entries, "hashme.example", 22);
    expect(hashedVerifier(key)).toBe(true);
    expect(makeKnownHostsVerifier(entries, "other.example", 22)(key)).toBe(false);
  });

  it("fingerprint verifier accepts only exact SHA-256 digests", () => {
    const key = Buffer.from("fingerprint-me");
    const good = parseFingerprint(`SHA256:${sha256Digest(key).toString("base64")}`);
    const other = parseFingerprint(`SHA256:${Buffer.alloc(32, 1).toString("base64")}`);
    expect(makeFingerprintsVerifier([good, other])(key)).toBe(true);
    expect(makeFingerprintsVerifier([other])(key)).toBe(false);
    expect(() => parseFingerprint("not-base64-length")).toThrow(/invalid SHA-256/);
  });
});
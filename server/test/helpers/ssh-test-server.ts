import ssh2, { type Client } from "ssh2";
import { sha256Digest } from "../../../shared/known-hosts.js";

const { Server, utils } = ssh2;

export interface TestSshServer {
  /** Bound port (0 pick). */
  port: number;
  /** Number of accepted shell channels opened (live). */
  shells: number;
  /** Recorded window-change events (terminal resize forwarded remotely). */
  winChanges: Array<{ cols: number; rows: number }>;
  /** Number of accepted auth calls (live). */
  auths: number;
  /** Number of client connection closes seen by the server (live). */
  disconnects: number;
  /** Host public key blob buffer, for host-key verification. */
  publicBlob: Buffer;
  /** Base64 (bare) SHA-256 fingerprint of the host key. */
  fingerprint: string;
  /** OpenSSH known_hosts line binding the host key to 127.0.0.1:<port>. */
  knownHostsLine: string;
  close: () => Promise<void>;
  /** Force the live client connection closed (remote disconnect). */
  forceClientEnd: () => void;
  /** Force the live shell channel closed. */
  forceChannelEnd: () => void;
}

interface StartOptions {
  /** Correct password for user "tester". */
  password?: string;
  /** Accepted client public-key blob (Buffer), enabling pubkey auth. */
  pubkey?: Buffer;
}

/**
 * Start an in-process ssh2 SSH server acting as the "remote host". It
 * authenticates "tester" via password and/or pubkey, accepts a pty+shell, and
 * behaves like an interactive remote shell for the tests:
 *
 *   - echo:   everything typed is echoed back untouched,
 *   - magic input handled by the shell:
 *       "<msg>stderr"  -> streams "STDERR-VISIBLE\n" on the stderr channel,
 *       "<msg>hangup"  -> ends the client connection (remote disconnect),
 *       "<msg>ttyclose"-> ends the shell channel.
 */
export function startTestSshServer(opts: StartOptions = {}): Promise<TestSshServer> {
  let hostKey = utils.generateKeyPairSync("ed25519");
  let hostKeyPublic = utils.parseKey(hostKey.public);
  while (hostKeyPublic instanceof Error || (Array.isArray(hostKeyPublic) && hostKeyPublic[0] instanceof Error)) {
    hostKey = utils.generateKeyPairSync("ed25519");
    hostKeyPublic = utils.parseKey(hostKey.public);
  }
  const parsedKey = Array.isArray(hostKeyPublic) ? hostKeyPublic[0] : hostKeyPublic;
  const publicBlob = parsedKey.getPublicSSH();

  const state = {
    shells: 0,
    winChanges: [] as Array<{ cols: number; rows: number }>,
    auths: 0,
    disconnects: 0,
    client: null as Client | null,
    stream: null as { end: () => void } | null,
  };

  const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
    client.on("error", () => undefined);
    client.on("authentication", (ctx) => {
      state.auths++;
      let ok = false;
      if (ctx.username === "tester" && ctx.method === "password" && opts.password) {
        ok = ctx.password === opts.password;
      } else if (ctx.username === "tester" && ctx.method === "publickey" && opts.pubkey) {
        ok = ctx.key !== undefined && ctx.key.data.equals(opts.pubkey);
      }
      ok ? ctx.accept() : ctx.reject(["password", "publickey"]);
    });
    client.on("ready", () => {
      state.client = client;
    });
    client.on("close", () => {
      state.disconnects++;
      if (state.client === client) state.client = null;
    });
    client.on("session", (accept) => {
      const session = accept();
      session.on("window-change", (_accept, _reject, info) => {
        state.winChanges.push({ cols: info.cols, rows: info.rows });
      });
      session.on("pty", (acceptPty) => acceptPty());
      session.on("shell", (acceptShell) => {
        state.shells++;
        const stream = acceptShell();
        state.stream = stream;
        stream.write("READY\n");
        stream.on("data", (d: Buffer) => {
          const text = d.toString("utf-8");
          if (text.includes("<msg>stderr")) {
            stream.stderr.write("STDERR-VISIBLE\n");
            return;
          }
          if (text.includes("<msg>ttyclose")) {
            stream.end();
            return;
          }
          if (text.includes("<msg>hangup")) {
            client.end();
            return;
          }
          stream.write(d);
        });
      });
    });
  });
  server.on("error", () => undefined);

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      resolve({
        port: address.port,
        get shells() {
          return state.shells;
        },
        winChanges: state.winChanges,
        get auths() {
          return state.auths;
        },
        get disconnects() {
          return state.disconnects;
        },
        publicBlob,
        fingerprint: sha256Digest(publicBlob).toString("base64"),
        knownHostsLine: `[127.0.0.1]:${address.port} ${hostKeyPublic.type} ${publicBlob.toString("base64")}`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
        forceClientEnd: () => state.client?.end(),
        forceChannelEnd: () => state.stream?.end(),
      });
    });
  });
}
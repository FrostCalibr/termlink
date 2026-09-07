import { describe, it, expect } from "vitest";
import { PtyManager } from "../src/pty-manager.js";
import type { DeviceClientMessage } from "../../shared/device/protocol.js";

const silent = {
  warn: () => undefined,
  info: () => undefined,
  error: () => undefined,
};

let send: (m: DeviceClientMessage) => void = () => undefined;
const sent: DeviceClientMessage[] = [];

function makePty(shell: string): PtyManager {
  sent.length = 0;
  send = (m) => sent.push(m);
  return new PtyManager(
    { shell, cols: 80, rows: 24, cwd: process.cwd() },
    (m) => send(m),
    silent,
  );
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("PtyManager", () => {
  it("spawns a real shell and tears it down", () => {
    const pty = makePty("/bin/sh");
    pty.start("s1", 80, 24);
    expect(pty.size).toBe(1);
    pty.close("s1");
    expect(pty.size).toBe(0);
  });

  it("reports a broken shell to the relay as failed/exited", async () => {
    const pty = makePty("/nonexistent/definitely-missing-shell");
    pty.start("s2", 80, 24);
    // node-pty spawns and the child dies immediately; the agent must tell the
    // relay the session could not run so the browser isn't left hanging.
    await waitFor(() =>
      sent.some((m) =>
        m.type === "device_session_failed" || m.type === "device_session_exited",
      ),
    );
    const failed = sent.find((m) => m.type === "device_session_failed");
    const exited = sent.find((m) => m.type === "device_session_exited");
    expect(failed?.sessionId ?? exited?.sessionId).toBe("s2");
  });

  it("tears down every session with closeAll", () => {
    const pty = makePty("/bin/sh");
    pty.start("a", 80, 24);
    pty.start("b", 80, 24);
    expect(pty.size).toBe(2);
    pty.closeAll();
    expect(pty.size).toBe(0);
  });
});
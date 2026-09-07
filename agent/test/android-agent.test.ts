import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AndroidAgent } from "../src/android/agent.js";
import { loadAndroidAgentConfig } from "../src/android/config.js";
import { silentLogger } from "../../relay/test/helpers.js";

describe("AndroidAgent lifecycle and credentials", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "android-agent-test-"));
  });

  afterAll(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("initializes AndroidAgent, persists credentials with 0600 permissions, and manages wake lock", async () => {
    const credPath = join(tmpDir, "android-test-device.secret");
    const config = loadAndroidAgentConfig({
      ANDROID_RELAY_URL: "ws://127.0.0.1:19999",
      ANDROID_DEVICE_ID: "phone-unit-test",
      ANDROID_CREDENTIALS_FILE: credPath,
      ANDROID_WAKE_LOCK: "false",
    });

    const agent = new AndroidAgent(config, silentLogger as any);
    expect(agent.credentials.secret).toBeTruthy();
    expect(agent.credentials.created).toBe(true);

    const stat = statSync(credPath);
    // On Unix systems, mode & 0o777 should be 0o600
    if (process.platform !== "win32") {
      expect(stat.mode & 0o777).toBe(0o600);
    }

    await agent.stop();
    expect(agent.pty.size).toBe(0);
  });
});

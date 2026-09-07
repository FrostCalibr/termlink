import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadCliConfig, saveCliConfig, clearCliConfig } from "../src/config.js";

describe("CLI Credentials Config Store", () => {
  let testConfigPath: string;

  beforeEach(() => {
    testConfigPath = join(
      tmpdir(),
      `test-termlink-cli-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    );
  });

  afterEach(() => {
    if (existsSync(testConfigPath)) {
      try {
        unlinkSync(testConfigPath);
      } catch {
        /* ignore */
      }
    }
  });

  it("returns null when no config file exists", () => {
    expect(loadCliConfig(testConfigPath)).toBeNull();
  });

  it("saves config with 0600 file permissions and reads it back", () => {
    const config = {
      relayUrl: "http://127.0.0.1:19001",
      sessionToken: "cli-test-bearer-token",
      username: "cli-user",
    };

    saveCliConfig(config, testConfigPath);

    expect(existsSync(testConfigPath)).toBe(true);

    // Verify 0600 mode on POSIX platforms
    if (process.platform !== "win32") {
      const stats = statSync(testConfigPath);
      const mode = stats.mode & 0o777;
      expect(mode).toBe(0o600);
    }

    const loaded = loadCliConfig(testConfigPath);
    expect(loaded).toEqual({
      relayUrl: "http://127.0.0.1:19001",
      sessionToken: "cli-test-bearer-token",
      username: "cli-user",
    });
  });

  it("clears stored credentials cleanly", () => {
    const config = {
      relayUrl: "http://127.0.0.1:19001",
      sessionToken: "tok",
      username: "user",
    };

    saveCliConfig(config, testConfigPath);
    expect(loadCliConfig(testConfigPath)).not.toBeNull();

    clearCliConfig(testConfigPath);
    expect(loadCliConfig(testConfigPath)).toBeNull();
  });
});

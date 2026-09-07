import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main } from "../src/index.js";
import { saveCliConfig, defaultCliConfigPath } from "../src/config.js";

describe("CLI Main Command Dispatcher", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let testConfigPath: string;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    testConfigPath = join(
      tmpdir(),
      `test-cli-main-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    );
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    if (existsSync(testConfigPath)) {
      try {
        unlinkSync(testConfigPath);
      } catch {
        /* ignore */
      }
    }
  });

  it("prints usage on --help or unknown commands", async () => {
    expect(await main(["--help"])).toBe(0);
    expect(logSpy).toHaveBeenCalled();
    const output = logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("termlink CLI Terminal Client");

    expect(await main(["unknown-cmd"])).toBe(1);
    expect(errSpy).toHaveBeenCalled();
  });

  it("prints version on --version", async () => {
    expect(await main(["--version"])).toBe(0);
    const output = logSpy.mock.calls.flat().join("\n");
    expect(output).toContain("termlink 0.1.0");
  });

  it("fails devices command when not logged in", async () => {
    // Ensure no config exists for this run
    vi.stubEnv("HOME", tmpdir());
    const code = await main(["devices"]);
    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalled();
    const errText = errSpy.mock.calls.flat().join("\n");
    expect(errText).toContain("Not logged in");
  });

  it("fails connect command when no target argument is given", async () => {
    const code = await main(["connect"]);
    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalled();
    const errText = errSpy.mock.calls.flat().join("\n");
    expect(errText).toContain("Usage: termlink connect");
  });

  it("fails ssh command when no target argument is given", async () => {
    const code = await main(["ssh"]);
    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalled();
    const errText = errSpy.mock.calls.flat().join("\n");
    expect(errText).toContain("Usage: termlink ssh");
  });
});

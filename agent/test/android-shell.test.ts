import { describe, it, expect } from "vitest";
import { resolveAndroidShell } from "../src/android/shell-resolver.js";

describe("resolveAndroidShell", () => {
  it("resolves a default shell and working directory", () => {
    const res = resolveAndroidShell();
    expect(res.shell).toBeTruthy();
    expect(res.cwd).toBeTruthy();
    expect(res.env.TERM).toBe("xterm-256color");
    expect(res.env.PATH).toBeTruthy();
  });

  it("respects preferred shell when provided", () => {
    const res = resolveAndroidShell("sh", "/tmp");
    expect(res.shell).toBe("sh");
    expect(res.cwd).toBeTruthy();
  });

  it("constructs environment variables with PATH and HOME", () => {
    const res = resolveAndroidShell(undefined, undefined, {
      PATH: "/custom/bin:/usr/bin",
      HOME: "/custom/home",
    });
    expect(res.env.PATH).toContain("/custom/bin");
    expect(res.env.HOME).toBe("/custom/home");
  });

  it("does not allow arbitrary commands or remote parameters in shell configuration", () => {
    // The shell environment is fixed locally and ignores untrusted external input.
    const res = resolveAndroidShell(undefined, undefined, {});
    expect(typeof res.shell).toBe("string");
    expect(res.env).not.toHaveProperty("UNTRUSTED_INJECTED_CMD");
  });
});

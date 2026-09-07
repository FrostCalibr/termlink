import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDeviceSecret, readDeviceSecret } from "../src/credentials.js";

describe("ensureDeviceSecret", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-creds-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates a secret file with 0600 permissions on first run", () => {
    const path = join(dir, "device.secret");
    const creds = ensureDeviceSecret(path);
    expect(creds.created).toBe(true);
    expect(creds.secret.length).toBeGreaterThanOrEqual(32);

    expect(existsSync(path)).toBe(true);
    expect(readDeviceSecret(path)).toBe(creds.secret);

    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("reuses an existing secret instead of overwriting it", () => {
    const path = join(dir, "device.secret");
    const first = ensureDeviceSecret(path);
    const second = ensureDeviceSecret(path);
    expect(second.created).toBe(false);
    expect(second.secret).toBe(first.secret);
    expect(readDeviceSecret(path)).toBe(first.secret);
  });

  it("restores a truncated/empty file with a fresh secret", () => {
    const path = join(dir, "device.secret");
    const first = ensureDeviceSecret(path);
    const raw = readFileSync(path, "utf-8");
    const second = ensureDeviceSecret(path);
    expect(second.secret).toBe(first.secret);

    // Simulate manual truncation: empty file → a fresh secret is generated.
    rmSync(path, { force: true });
    const third = ensureDeviceSecret(path);
    expect(third.created).toBe(true);
    expect(third.secret).not.toBe(first.secret);
    expect(raw).toBe(first.secret);
  });

  it("creates missing parent directories", () => {
    const path = join(dir, "nested", "deeper", "device.secret");
    const creds = ensureDeviceSecret(path);
    expect(creds.created).toBe(true);
    expect(readDeviceSecret(path)).toBe(creds.secret);
  });
});
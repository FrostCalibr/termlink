import { describe, it, expect } from "vitest";
import { loadConfig, ConfigError } from "../src/config.js";

const validEnv = {
  HOST: "127.0.0.1",
  PORT: "9000",
  MAX_FRAME_SIZE: "1024",
  MAX_CONNECTIONS: "50",
  IDLE_TIMEOUT_MS: "30000",
  MAX_AUTH_ATTEMPTS: "5",
  AUTH_BACKOFF_MS: "1000",
  AUTH_TOKENS: "tok1 tok2",
  PASSWORD_USERS: "u1:p1,u2:p2",
};

describe("loadConfig", () => {
  it("parses a valid configuration", () => {
    const cfg = loadConfig(validEnv);
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.port).toBe(9000);
    expect(cfg.maxFrameSize).toBe(1024);
    expect(cfg.maxConnections).toBe(50);
    expect(cfg.idleTimeoutMs).toBe(30000);
    expect(cfg.maxAuthAttempts).toBe(5);
    expect(cfg.authBackoffMs).toBe(1000);
    expect(cfg.tokens).toEqual(["tok1", "tok2"]);
    expect(cfg.passwordUsers.get("u1")).toBe("p1");
    expect(cfg.passwordUsers.get("u2")).toBe("p2");
  });

  it("applies defaults when fields are absent", () => {
    const cfg = loadConfig({ AUTH_TOKENS: "tok" });
    expect(cfg.host).toBe("0.0.0.0");
    expect(cfg.port).toBe(9000);
    expect(cfg.maxFrameSize).toBe(1024 * 1024);
    expect(cfg.maxConnections).toBe(100);
    expect(cfg.idleTimeoutMs).toBe(30000);
    expect(cfg.protocolVersion).toBe(1);
  });

  it("fails when no credentials are configured", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
  });

  it("fails on a non-integer port", () => {
    expect(() => loadConfig({ ...validEnv, PORT: "abc" })).toThrow(ConfigError);
  });

  it("fails on an out-of-range port", () => {
    expect(() => loadConfig({ ...validEnv, PORT: "70000" })).toThrow(
      ConfigError,
    );
  });

  it("fails on an invalid protocol version", () => {
    expect(() => loadConfig({ ...validEnv, PROTOCOL_VERSION: "99" })).toThrow(
      ConfigError,
    );
  });

  it("fails when maxFrameSize is too large", () => {
    expect(() => loadConfig({ ...validEnv, MAX_FRAME_SIZE: userFriendlySize() })).toThrow(
      ConfigError,
    );
  });

  it("fails on an empty password user entry", () => {
    expect(() => loadConfig({ ...validEnv, PASSWORD_USERS: "u1:" })).toThrow(
      ConfigError,
    );
  });

  it("fails on a password entry without a separator", () => {
    expect(() => loadConfig({ ...validEnv, PASSWORD_USERS: "plaintext" })).toThrow(
      ConfigError,
    );
  });

  it("fails on duplicate usernames", () => {
    expect(() =>
      loadConfig({ ...validEnv, PASSWORD_USERS: "u1:p1,u1:p2" }),
    ).toThrow(ConfigError);
  });
});

function userFriendlySize(): string {
  return String(64 * 1024 * 1024 + 1);
}
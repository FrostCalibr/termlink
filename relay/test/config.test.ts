import { describe, it, expect } from "vitest";
import { loadRelayConfig, ConfigError } from "../src/config.js";

const validEnv = {
  RELAY_HOST: "127.0.0.1",
  RELAY_PORT: "9100",
  MAX_FRAME_SIZE: "1024",
  MAX_CONNECTIONS: "50",
  IDLE_TIMEOUT_MS: "30000",
  MAX_AUTH_ATTEMPTS: "5",
  AUTH_BACKOFF_MS: "1000",
  AUTH_TOKENS: "relaytok",
  TARGETS: "pty=127.0.0.1:2222,web=192.168.1.5:3000",
};

describe("loadRelayConfig", () => {
  it("parses a valid configuration", () => {
    const cfg = loadRelayConfig(validEnv);
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.port).toBe(9100);
    expect(cfg.maxFrameSize).toBe(1024);
    expect(cfg.tokens).toEqual(["relaytok"]);
    expect(cfg.targets).toEqual([
      { id: "pty", host: "127.0.0.1", port: 2222 },
      { id: "web", host: "192.168.1.5", port: 3000 },
    ]);
  });

  it("applies defaults when fields are absent", () => {
    const cfg = loadRelayConfig({ AUTH_TOKENS: "tok", TARGETS: "t=1:2" });
    expect(cfg.host).toBe("0.0.0.0");
    expect(cfg.port).toBe(9000);
    expect(cfg.maxConnections).toBe(100);
    expect(cfg.idleTimeoutMs).toBe(30000);
    expect(cfg.targets).toEqual([{ id: "t", host: "1", port: 2 }]);
  });

  it("fails when no client credentials are configured", () => {
    expect(() => loadRelayConfig({ TARGETS: "t=1:2" })).toThrow(ConfigError);
  });

  it("fails when no targets are configured", () => {
    expect(() => loadRelayConfig({ AUTH_TOKENS: "tok" })).toThrow(/targets/i);
  });

  it("fails on a non-integer relay port", () => {
    expect(() => loadRelayConfig({ ...validEnv, RELAY_PORT: "abc" })).toThrow(
      ConfigError,
    );
  });

  it("fails on an out-of-range relay port", () => {
    expect(() => loadRelayConfig({ ...validEnv, RELAY_PORT: "70000" })).toThrow(
      ConfigError,
    );
  });

  it("fails on a malformed target (no =)", () => {
    expect(() =>
      loadRelayConfig({ ...validEnv, TARGETS: "justahost" }),
    ).toThrow(/form targetId=host:port/);
  });

  it("fails on a target without a port", () => {
    expect(() =>
      loadRelayConfig({ ...validEnv, TARGETS: "pty=127.0.0.1" }),
    ).toThrow(/no port/);
  });

  it("fails on a target with an invalid port", () => {
    expect(() =>
      loadRelayConfig({ ...validEnv, TARGETS: "pty=127.0.0.1:notaport" }),
    ).toThrow(/invalid port/);
  });

  it("fails on duplicate target ids", () => {
    expect(() =>
      loadRelayConfig({ ...validEnv, TARGETS: "pty=1:2,pty=3:4" }),
    ).toThrow(/duplicate target id/);
  });

  it("parses a token credential for a target", () => {
    const cfg = loadRelayConfig({
      ...validEnv,
      TARGETS: "pty=backendtok@127.0.0.1:2222",
    });
    expect(cfg.targets).toEqual([
      { id: "pty", host: "127.0.0.1", port: 2222, token: "backendtok" },
    ]);
  });

  it("parses username:password credentials for a target", () => {
    const cfg = loadRelayConfig({
      ...validEnv,
      TARGETS: "pty=admin:changeme@127.0.0.1:2222",
    });
    expect(cfg.targets).toEqual([
      {
        id: "pty",
        host: "127.0.0.1",
        port: 2222,
        username: "admin",
        password: "changeme",
      },
    ]);
  });

  it("keeps target credentials out of the target id", () => {
    const cfg = loadRelayConfig({
      ...validEnv,
      TARGETS: "pty=backendtok@127.0.0.1:2222,web=192.168.1.5:3000",
    });
    expect(cfg.targets[0].id).toBe("pty");
    expect(cfg.targets[0].token).toBe("backendtok");
    expect(cfg.targets[1].token).toBeUndefined();
  });

  it("fails on empty target credentials", () => {
    expect(() =>
      loadRelayConfig({ ...validEnv, TARGETS: "pty=@127.0.0.1:2222" }),
    ).toThrow(/empty credentials/);
  });

  it("fails on target credentials without a port", () => {
    expect(() =>
      loadRelayConfig({ ...validEnv, TARGETS: "pty=backendtok@127.0.0.1" }),
    ).toThrow(/no port/);
  });

  it("fails on target credentials with an empty username", () => {
    expect(() =>
      loadRelayConfig({ ...validEnv, TARGETS: "pty=:pass@127.0.0.1:2222" }),
    ).toThrow(/empty username or password/);
  });

  it("parses optional GUI metadata (name + type) for a target", () => {
    const cfg = loadRelayConfig({
      ...validEnv,
      TARGETS: "mypc|My PC|shell=backendtok@127.0.0.1:2222",
    });
    expect(cfg.targets).toEqual([
      {
        id: "mypc",
        name: "My PC",
        type: "shell",
        host: "127.0.0.1",
        port: 2222,
        token: "backendtok",
      },
    ]);
  });

  it("parses an SSH target type without credentials", () => {
    const cfg = loadRelayConfig({
      ...validEnv,
      TARGETS: "bastion|Bastion|ssh=64.233.160.0:2222",
    });
    expect(cfg.targets).toEqual([
      { id: "bastion", name: "Bastion", type: "ssh", host: "64.233.160.0", port: 2222 },
    ]);
  });

  it("defaults type to shell and name to the id when metadata is absent", () => {
    const cfg = loadRelayConfig({
      ...validEnv,
      TARGETS: "legacy=127.0.0.1:2222",
    });
    expect(cfg.targets).toEqual([{ id: "legacy", host: "127.0.0.1", port: 2222 }]);
  });

  it("fails on an unknown target type", () => {
    expect(() =>
      loadRelayConfig({ ...validEnv, TARGETS: "x|X|pty=1:2" }),
    ).toThrow(/unknown type "pty"/);
  });

  it("fails on an empty display name", () => {
    expect(() =>
      loadRelayConfig({ ...validEnv, TARGETS: "x||shell=1:2" }),
    ).toThrow(/empty display name/);
  });
});
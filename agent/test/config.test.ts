import { describe, it, expect } from "vitest";
import { loadAgentConfig, AgentConfigError } from "../src/config.js";

const valid = {
  RELAY_URL: "wss://relay.example.com",
  AGENT_DEVICE_ID: "laptop-1",
};

describe("loadAgentConfig", () => {
  it("parses a valid configuration with defaults", () => {
    const cfg = loadAgentConfig(valid);
    expect(cfg.relayUrl).toBe("wss://relay.example.com");
    expect(cfg.deviceId).toBe("laptop-1");
    expect(cfg.credentialsFile).toBe("agent-device.secret");
    expect(cfg.shell).toBeTruthy();
    expect(cfg.cwd).toBeTruthy();
    expect(cfg.reconnectMinMs).toBe(500);
    expect(cfg.reconnectMaxMs).toBe(30_000);
    expect(cfg.pingIntervalMs).toBe(20_000);
  });

  it("strips a trailing slash from the relay url", () => {
    const cfg = loadAgentConfig({
      ...valid,
      RELAY_URL: "wss://relay.example.com/",
    });
    expect(cfg.relayUrl).toBe("wss://relay.example.com");
  });

  it("accepts plain ws:// for local development", () => {
    const cfg = loadAgentConfig({ ...valid, RELAY_URL: "ws://127.0.0.1:19001" });
    expect(cfg.relayUrl).toBe("ws://127.0.0.1:19001");
  });

  it("requires a relay URL", () => {
    expect(() => loadAgentConfig({ AGENT_DEVICE_ID: "x" })).toThrow(
      AgentConfigError,
    );
  });

  it("requires a ws(s) relay URL", () => {
    expect(() =>
      loadAgentConfig({ ...valid, RELAY_URL: "https://relay.example.com" }),
    ).toThrow(/ws:\/\//);
  });

  it("rejects a malformed relay URL", () => {
    expect(() => loadAgentConfig({ ...valid, RELAY_URL: "not a url" })).toThrow(
      AgentConfigError,
    );
  });

  it("requires a valid device id", () => {
    expect(() => loadAgentConfig({ ...valid, AGENT_DEVICE_ID: "invalid id!" })).toThrow(
      AgentConfigError,
    );
    expect(() => loadAgentConfig({ RELAY_URL: valid.RELAY_URL })).toThrow(
      /AGENT_DEVICE_ID/,
    );
  });

  it("honors enrollment token and credentials file overrides", () => {
    const cfg = loadAgentConfig({
      ...valid,
      AGENT_ENROLLMENT_TOKEN: "tok",
      AGENT_CREDENTIALS_FILE: "/tmp/secret",
    });
    expect(cfg.enrollmentToken).toBe("tok");
    expect(cfg.credentialsFile).toBe("/tmp/secret");
  });

  it("rejects non-positive numeric settings", () => {
    expect(() =>
      loadAgentConfig({ ...valid, AGENT_PING_INTERVAL_MS: "0" }),
    ).toThrow(AgentConfigError);
    expect(() =>
      loadAgentConfig({ ...valid, AGENT_RECONNECT_MAX_MS: "abc" }),
    ).toThrow(AgentConfigError);
  });
});
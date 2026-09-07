import { describe, it, expect } from "vitest";
import { loadAndroidAgentConfig } from "../src/android/config.js";
import { AgentConfigError } from "../src/config.js";

const valid = {
  ANDROID_RELAY_URL: "wss://relay.example.com",
  ANDROID_DEVICE_ID: "phone-1",
};

describe("loadAndroidAgentConfig", () => {
  it("parses valid configuration with defaults", () => {
    const cfg = loadAndroidAgentConfig(valid);
    expect(cfg.relayUrl).toBe("wss://relay.example.com");
    expect(cfg.deviceId).toBe("phone-1");
    expect(cfg.credentialsFile).toBe("android-device.secret");
    expect(cfg.shellEnv.shell).toBeTruthy();
    expect(cfg.shellEnv.cwd).toBeTruthy();
    expect(cfg.wakeLock).toBe(true);
    expect(cfg.reconnectMinMs).toBe(500);
    expect(cfg.reconnectMaxMs).toBe(30_000);
    expect(cfg.pingIntervalMs).toBe(20_000);
  });

  it("strips trailing slash from relay URL", () => {
    const cfg = loadAndroidAgentConfig({
      ...valid,
      ANDROID_RELAY_URL: "wss://relay.example.com/",
    });
    expect(cfg.relayUrl).toBe("wss://relay.example.com");
  });

  it("accepts fallback RELAY_URL and AGENT_DEVICE_ID env vars", () => {
    const cfg = loadAndroidAgentConfig({
      RELAY_URL: "ws://127.0.0.1:19001",
      AGENT_DEVICE_ID: "android-pad",
    });
    expect(cfg.relayUrl).toBe("ws://127.0.0.1:19001");
    expect(cfg.deviceId).toBe("android-pad");
  });

  it("requires a relay URL", () => {
    expect(() => loadAndroidAgentConfig({ ANDROID_DEVICE_ID: "phone" })).toThrow(
      AgentConfigError,
    );
  });

  it("requires a ws:// or wss:// relay URL", () => {
    expect(() =>
      loadAndroidAgentConfig({ ...valid, ANDROID_RELAY_URL: "http://relay.example.com" }),
    ).toThrow(/ws:\/\//);
  });

  it("validates device ID pattern", () => {
    expect(() =>
      loadAndroidAgentConfig({ ...valid, ANDROID_DEVICE_ID: "bad id!" }),
    ).toThrow(AgentConfigError);
  });

  it("supports wakeLock toggle setting", () => {
    const cfg = loadAndroidAgentConfig({ ...valid, ANDROID_WAKE_LOCK: "false" });
    expect(cfg.wakeLock).toBe(false);
  });

  it("supports credentials file and enrollment token overrides", () => {
    const cfg = loadAndroidAgentConfig({
      ...valid,
      ANDROID_CREDENTIALS_FILE: "/data/local/tmp/android.secret",
      ANDROID_ENROLLMENT_TOKEN: "android-enroll-token",
    });
    expect(cfg.credentialsFile).toBe("/data/local/tmp/android.secret");
    expect(cfg.enrollmentToken).toBe("android-enroll-token");
  });
});

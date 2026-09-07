import { describe, it, expect } from "vitest";
import {
  loadRelayConfig,
  ConfigError,
  type RelayConfig,
} from "../src/config.js";
import {
  parseAgents,
  assertNoIdCollisions,
  type AgentDeviceConfig,
} from "../src/device-config.js";

const validEnv: Record<string, string> = {
  RELAY_HOST: "127.0.0.1",
  AUTH_TOKENS: "tok",
  WS_ENABLED: "true",
  WS_PORT: "0",
};

describe("parseAgents", () => {
  it("returns an empty list for an unset DEVICES value", () => {
    expect(parseAgents(undefined)).toEqual([]);
  });

  it("parses id, display name and the default shell type", () => {
    const agents = parseAgents("laptop|Alice's laptop|shell");
    expect(agents).toEqual<AgentDeviceConfig[]>([
      { id: "laptop", name: "Alice's laptop", type: "shell" },
    ]);
  });

  it("defaults type to shell when omitted", () => {
    expect(parseAgents("laptop|Alice's laptop")).toEqual<AgentDeviceConfig[]>([
      { id: "laptop", name: "Alice's laptop", type: "shell" },
    ]);
  });

  it("supports an optional per-device enrollment token", () => {
    const agents = parseAgents("laptop|Laptop|shell|sometoken");
    expect(agents).toEqual<AgentDeviceConfig[]>([
      {
        id: "laptop",
        name: "Laptop",
        type: "shell",
        enrollmentToken: "sometoken",
      },
    ]);
  });

  it("defaults the display name to the id", () => {
    expect(parseAgents("node-1")).toMatchObject<AgentDeviceConfig[]>([
      { id: "node-1", name: "node-1", type: "shell" },
    ]);
  });

  it("rejects unknown device types (agents are shell-only for now)", () => {
    expect(() => parseAgents("laptop|Laptop|ssh")).toThrow(ConfigError);
  });

  it("rejects duplicate device ids", () => {
    expect(() => parseAgents("laptop|A, laptop|B")).toThrow(ConfigError);
  });

  it("rejects empty ids, names and enrollment tokens", () => {
    expect(() => parseAgents("|Name")).toThrow(ConfigError);
    expect(() => parseAgents("laptop|")).toThrow(ConfigError);
    expect(() => parseAgents("laptop|Name|shell|")).toThrow(ConfigError);
  });

  it("rejects more than four '|' segments", () => {
    expect(() => parseAgents("laptop|Name|shell|tok|extra")).toThrow(ConfigError);
  });
});

describe("assertNoIdCollisions", () => {
  it("rejects a device id that collides with a target id", () => {
    const agents: AgentDeviceConfig[] = [
      { id: "box", name: "Box", type: "shell" },
    ];
    expect(() => assertNoIdCollisions(agents, ["box"])).toThrow(/collid/i);
  });

  it("accepts disjoint id sets", () => {
    const agents: AgentDeviceConfig[] = [
      { id: "laptop", name: "Laptop", type: "shell" },
    ];
    expect(() => assertNoIdCollisions(agents, ["server"])).not.toThrow();
  });
});

describe("loadRelayConfig with DEVICES", () => {
  const base = (overrides: Record<string, string>): RelayConfig =>
    loadRelayConfig({ ...validEnv, ...overrides });

  it("accepts a relay that has devices and no static targets", () => {
    const cfg = base({ DEVICES: "laptop|Laptop|shell" });
    expect(cfg.agents).toHaveLength(1);
    expect(cfg.targets).toHaveLength(0);
    expect(cfg.websocket).toBeDefined();
  });

  it("errors when neither TARGETS nor DEVICES are configured", () => {
    expect(() => base({ DEVICES: "" })).toThrow(/targets or devices/i);
  });

  it("rejects a device id colliding with a static target", () => {
    expect(() =>
      base({ TARGETS: "box=127.0.0.1:22", DEVICES: "box|Box" }),
    ).toThrow(/collid/i);
  });

  it("keeps multiple static targets and devices together", () => {
    const cfg = base({
      TARGETS: "srv=127.0.0.1:22",
      DEVICES: "laptop|Laptop, laptop2|Desktop",
    });
    expect(cfg.targets.map((t) => t.id)).toEqual(["srv"]);
    expect(cfg.agents.map((a) => a.id)).toEqual(["laptop", "laptop2"]);
  });
});
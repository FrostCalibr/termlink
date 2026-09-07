import { ConfigError, TARGET_TYPE_ANDROID, TARGET_TYPE_SHELL } from "./config.js";

/**
 * Phase 9 & 10 "device agent" configuration.
 *
 * Devices are PCs and phones that hold a persistent *outbound*
 * connection to the relay. They are pre-authorized by id in the relay config;
 * a device that has never connected yet is "enrolled" the first time it joins
 * with a device-generated secret (optionally guarded by a provisioned
 * enrollment token). The relay never dials a device — no inbound port is
 * required on the target device.
 */

export interface AgentDeviceConfig {
  /** Unique id; the browser selects the device with this id, never a secret. */
  id: string;
  /** Human-friendly name shown in the web GUI (defaults to the id). */
  name: string;
  /**
   * The terminal backend this device provides (`shell` or `android`).
   */
  type: "shell" | "android";
  /**
   * Optional one-time enrollment token. When set, a joining agent must present
   * this exact token to enroll. When absent, enrollment is open for this
   * device id until it is claimed (startup warning is logged).
   */
  enrollmentToken?: string;
}

export function isAgentDeviceType(value: string): value is "shell" | "android" {
  return value === TARGET_TYPE_SHELL || value === TARGET_TYPE_ANDROID;
}

/**
 * Parse the DEVICES env var: a comma-separated list of
 * `id|Display Name|type[|Enrollment Token]` entries.
 * - `id` (required), `Display Name` (optional), `type` (optional, `shell` or `android`).
 * - A 4th `|` segment is the optional enrollment token.
 */
export function parseAgents(value: string | undefined): AgentDeviceConfig[] {
  if (!value) return [];
  const agents: AgentDeviceConfig[] = [];
  const seen = new Set<string>();
  for (const raw of value.split(",")) {
    const entry = raw.trim();
    if (entry.length === 0) continue;
    const parts = entry.split("|").map((p) => p.trim());
    if (parts.length < 1 || parts.length > 4) {
      throw new ConfigError(
        `DEVICES entry "${entry}" must be id|Display Name|type[|enrollmentToken]`,
      );
    }
    const id = parts[0];
    if (id.length === 0) {
      throw new ConfigError(`DEVICES entry has an empty device id`);
    }
    if (seen.has(id)) {
      throw new ConfigError(`DEVICES contains duplicate device id "${id}"`);
    }
    seen.add(id);

    let name = id;
    if (parts.length > 1) {
      name = parts[1];
      if (name.length === 0) {
        throw new ConfigError(`DEVICES entry "${entry}" has an empty display name`);
      }
    }

    let type: "shell" | "android" = TARGET_TYPE_SHELL as "shell";
    if (parts.length > 2) {
      const rawType = parts[2];
      if (rawType !== "shell" && rawType !== "android") {
        throw new ConfigError(
          `DEVICES entry "${entry}" has unsupported type "${rawType}" (agent devices support shell and android)`,
        );
      }
      type = rawType as "shell" | "android";
    }

    let enrollmentToken: string | undefined;
    if (parts.length > 3) {
      enrollmentToken = parts[3];
      if (enrollmentToken.length === 0) {
        throw new ConfigError(
          `DEVICES entry "${entry}" has an empty enrollment token`,
        );
      }
    }

    const agent: AgentDeviceConfig = { id, name, type };
    if (enrollmentToken !== undefined) agent.enrollmentToken = enrollmentToken;
    agents.push(agent);
  }
  return agents;
}

/** Validate that agent device ids do not collide with static target ids. */
export function assertNoIdCollisions(
  agents: AgentDeviceConfig[],
  targetIds: string[],
): void {
  for (const agent of agents) {
    if (targetIds.includes(agent.id)) {
      throw new ConfigError(
        `DEVICES id "${agent.id}" collides with a TARGETS id; device ids must be unique across both`,
      );
    }
  }
}
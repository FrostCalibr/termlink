import { hashSecret, verifySecret } from "../../server/src/auth.js";
import type { AgentDeviceConfig } from "./device-config.js";

/** Browser-safe projection of a device agent's status. */
export interface AgentDeviceInfo {
  id: string;
  name: string;
  type: "shell" | "android";
  online: boolean;
  /** Agents report reachability directly; there is no TCP latency probe. */
  latencyMs: null;
  lastSeen: number;
  enrolled: boolean;
}

interface DeviceRuntimeState {
  /** scrypt hash of the device's enrolled secret (never the raw secret). */
  secretHash?: string;
  registeredAt?: number;
  online: boolean;
  /** id of the live AgentLink, when online. */
  connectionId?: string;
  lastSeen: number;
  /** Warn once at startup when a device allows open (tokenless) enrollment. */
  openEnrollmentWarned: boolean;
}

/**
 * Registry of Phase 9 device agents.
 *
 * The relay is authoritative. It only ever stores the scrypt hash of a
 * device's own generated secret; the raw secret never reaches the relay code
 * path that talks to browsers. `online`/`lastSeen` are driven by the agent's
 * persistent outbound connection and its heartbeats.
 *
 * Enrollment rules:
 *  - a device id must be pre-authorized in the relay config (DEVICES);
 *  - the first agent to connect with that id may enroll (guarded by an
 *    optional per-device enrollment token);
 *  - an enrolled device refuses re-enrollment — only secret auth is accepted
 *    afterwards.
 */
export class DeviceStore {
  private state = new Map<string, DeviceRuntimeState>();

  constructor(private configs: AgentDeviceConfig[]) {
    const now = Date.now();
    for (const config of configs) {
      this.state.set(config.id, {
        online: false,
        lastSeen: now,
        openEnrollmentWarned: false,
        ...(config.enrollmentToken === undefined
          ? { openEnrollment: true }
          : {}),
      });
    }
  }

  /** Config record for a pre-authorized device id, or null. */
  config(id: string): AgentDeviceConfig | undefined {
    return this.configs.find((c) => c.id === id);
  }

  /** Whether the id is a pre-authorized agent device. */
  has(id: string): boolean {
    return this.state.has(id);
  }

  /** Whether the device has completed enrollment. */
  isRegistered(id: string): boolean {
    return this.state.get(id)?.secretHash !== undefined;
  }

  /** Whether the device's agent is currently connected. */
  online(id: string): boolean {
    return this.state.get(id)?.online ?? false;
  }

  /** Last-seen timestamp (heartbeat) for a device. */
  lastSeen(id: string): number {
    return this.state.get(id)?.lastSeen ?? 0;
  }

  /** The enrollment token required to claim a device, if configured. */
  enrollmentToken(id: string): string | undefined {
    return this.config(id)?.enrollmentToken;
  }

  /** All pre-authorized devices, projected for the browser API. */
  list(): AgentDeviceInfo[] {
    const now = Date.now();
    return this.configs.map((config) => {
      const s = this.state.get(config.id)!;
      return {
        id: config.id,
        name: config.name,
        type: config.type,
        online: s.online,
        latencyMs: null,
        lastSeen: s.lastSeen,
        enrolled: s.secretHash !== undefined,
      };
    });
  }

  /** Warn-once flag for tokenless enrollment (used by the logger). */
  markOpenEnrollmentWarned(id: string): boolean {
    const s = this.state.get(id);
    if (!s || s.openEnrollmentWarned) return false;
    s.openEnrollmentWarned = true;
    return true;
  }

  /**
   * Enroll a device. Returns an error string on refusal (already registered,
   * unknown id, wrong token) or null on success. The secret is stored only as
   * an scrypt hash.
   */
  async register(
    id: string,
    secret: string,
    providedEnrollmentToken: string | undefined,
  ): Promise<string | null> {
    const s = this.state.get(id);
    if (!s) return "Unknown device id";
    if (s.secretHash !== undefined) return "Device already registered";
    const expected = this.enrollmentToken(id);
    if (expected !== undefined && providedEnrollmentToken !== expected) {
      return "Invalid enrollment token";
    }
    s.secretHash = await hashSecret(secret);
    s.registeredAt = Date.now();
    return null;
  }

  /** Verify a device secret (scrypt, constant-time). */
  async verify(id: string, secret: string): Promise<boolean> {
    const s = this.state.get(id);
    if (!s?.secretHash) return false;
    return verifySecret(secret, s.secretHash);
  }

  /** Mark a device online (an agent link authenticated). */
  setOnline(id: string, connectionId: string): void {
    const s = this.state.get(id);
    if (!s) return;
    s.online = true;
    s.connectionId = connectionId;
    s.lastSeen = Date.now();
  }

  /** Mark a device offline when its link closes. */
  setOffline(connectionId: string): void {
    for (const s of this.state.values()) {
      if (s.connectionId === connectionId) {
        s.online = false;
        s.connectionId = undefined;
        s.lastSeen = Date.now();
        return;
      }
    }
  }

  /** Record activity (heartbeat / traffic) for a connected device. */
  touch(id: string): void {
    const s = this.state.get(id);
    if (s && s.online) s.lastSeen = Date.now();
  }
}
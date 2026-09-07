import { connect } from "node:net";
import type { Target, TargetType } from "./config.js";

export interface DeviceProbeResult {
  ok: boolean;
  latencyMs: number | null;
}

export type ProbeFn = (host: string, port: number) => Promise<DeviceProbeResult>;

/**
 * Lightweight reachability probe for a configured target. Opens a plain TCP
 * connection and closes it immediately — no protocol messages, no
 * authentication, and no terminal sessions are ever spawned. This gives the
 * GUI an honest online/offline signal without exposing backend addresses.
 */
export function probeTarget(host: string, port: number): Promise<DeviceProbeResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = connect({ host, port });
    let settled = false;
    const finish = (ok: boolean, latencyMs: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ ok, latencyMs });
    };
    const timer = setTimeout(() => finish(false, null), 800);
    socket.once("connect", () => finish(true, Date.now() - start));
    // Keep the error listener alive for the socket's lifetime so a late
    // reset/refused event can never surface as an unhandled 'error'.
    socket.on("error", () => finish(false, null));
  });
}

/** The subset of target metadata that is safe to expose to a browser. */
export interface DeviceInfo {
  id: string;
  name: string;
  type: TargetType;
  online: boolean;
  latencyMs: number | null;
}

/**
 * Flatten configured targets into browser-facing devices. Each target becomes
 * one device; `name` defaults to the target id and `type` defaults to `shell`.
 */
export function listDevices(targets: Target[]): DeviceInfo[] {
  return targets.map((t) => ({
    id: t.id,
    name: t.name ?? t.id,
    type: t.type ?? "shell",
    online: false,
    latencyMs: null,
  }));
}

/**
 * Probe a set of devices concurrently and return reachability. Probes are
 * bounded (800ms each) and failures are reported as offline — a device that
 * is down must never make the API wait or fail.
 */
export async function withReachability(
  devices: DeviceInfo[],
  probe: ProbeFn = probeTarget,
  targets: Target[],
): Promise<DeviceInfo[]> {
  const results = await Promise.all(
    devices.map(async (device) => {
      const target = targets.find((t) => t.id === device.id);
      if (!target) return device;
      try {
        const r = await probe(target.host, target.port);
        return { ...device, online: r.ok, latencyMs: r.latencyMs };
      } catch {
        return { ...device, online: false, latencyMs: null };
      }
    }),
  );
  return results;
}
import { describe, it, expect, beforeEach } from "vitest";
import { DeviceStore } from "../src/device-store.js";
import type { AgentDeviceConfig } from "../src/device-config.js";

const configs: AgentDeviceConfig[] = [
  { id: "laptop", name: "Laptop", type: "shell" },
  { id: "locked", name: "Locked", type: "shell", enrollmentToken: "tok-123" },
];

describe("DeviceStore", () => {
  let store: DeviceStore;
  beforeEach(() => {
    store = new DeviceStore(configs);
  });

  it("lists pre-authorized devices as unenrolled and offline", () => {
    expect(store.list()).toEqual([
      expect.objectContaining({
        id: "laptop",
        name: "Laptop",
        type: "shell",
        online: false,
        enrolled: false,
        latencyMs: null,
      }),
      expect.objectContaining({ id: "locked", enrolled: false }),
    ]);
  });

  it("rejects registration of an unknown device id", async () => {
    await expect(store.register("nope", "secret", undefined)).resolves.toBe(
      "Unknown device id",
    );
  });

  it("enrolls with a secret hash and refuses re-registration", async () => {
    const error = await store.register("laptop", "super-secret", undefined);
    expect(error).toBeNull();
    expect(store.isRegistered("laptop")).toBe(true);

    const again = await store.register("laptop", "another-secret", undefined);
    expect(again).toBe("Device already registered");
  });

  it("never stores the raw secret", async () => {
    await store.register("laptop", "super-secret", undefined);
    const raw = JSON.stringify(store);
    expect(raw).not.toContain("super-secret");
  });

  it("requires the enrollment token when configured", async () => {
    await expect(store.register("locked", "secret", undefined)).resolves.toBe(
      "Invalid enrollment token",
    );
    await expect(store.register("locked", "secret", "wrong-999")).resolves.toBe(
      "Invalid enrollment token",
    );
    await expect(store.register("locked", "secret", "tok-123")).resolves.toBeNull();
  });

  it("verifies the correct secret and rejects wrong ones", async () => {
    await store.register("laptop", "right", undefined);
    await expect(store.verify("laptop", "right")).resolves.toBe(true);
    await expect(store.verify("laptop", "wrong")).resolves.toBe(false);
    await expect(store.verify("never-registered", "right")).resolves.toBe(false);
  });

  it("tracks online/offline and lastSeen by connection id", async () => {
    await store.register("laptop", "right", undefined);
    expect(store.online("laptop")).toBe(false);

    store.setOnline("laptop", "conn-1");
    expect(store.online("laptop")).toBe(true);
    expect(store.list()[0]).toMatchObject({ online: true, enrolled: true });

    const before = store.lastSeen("laptop");
    await sleep(2);
    store.touch("laptop");
    expect(store.lastSeen("laptop")).toBeGreaterThanOrEqual(before);

    store.setOffline("conn-1");
    expect(store.online("laptop")).toBe(false);
    // Removing an unrelated connection id is a no-op.
    store.setOffline("conn-other");
    expect(store.online("laptop")).toBe(false);
  });

  it("marks the open-enrollment warning at most once", () => {
    expect(store.enrollmentToken("laptop")).toBeUndefined();
    expect(store.markOpenEnrollmentWarned("laptop")).toBe(true);
    expect(store.markOpenEnrollmentWarned("laptop")).toBe(false);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
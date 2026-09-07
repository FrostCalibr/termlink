import { describe, it, expect } from "vitest";
import { AndroidWakeLockManager } from "../src/android/wake-lock.js";

describe("AndroidWakeLockManager", () => {
  it("acquires and releases wake lock via custom exec function", async () => {
    const calls: string[] = [];
    const execFn = async (cmd: string, args: string[]) => {
      calls.push(`${cmd} ${args.join(" ")}`.trim());
      return { stdout: "", stderr: "" };
    };

    const manager = new AndroidWakeLockManager({ enabled: true, execFn });
    expect(manager.isAcquired).toBe(false);

    const acquired = await manager.acquire();
    expect(acquired).toBe(true);
    expect(manager.isAcquired).toBe(true);
    expect(calls).toEqual(["termux-wake-lock"]);

    const released = await manager.release();
    expect(released).toBe(true);
    expect(manager.isAcquired).toBe(false);
    expect(calls).toEqual(["termux-wake-lock", "termux-wake-unlock"]);
  });

  it("handles missing termux-wake-lock command gracefully without throwing", async () => {
    const execFn = async () => {
      throw new Error("ENOENT termux-wake-lock command not found");
    };

    const manager = new AndroidWakeLockManager({ enabled: true, execFn });
    const acquired = await manager.acquire();
    expect(acquired).toBe(false);
    expect(manager.isAcquired).toBe(false);
  });

  it("does nothing when wake lock is disabled in config", async () => {
    const calls: string[] = [];
    const execFn = async (cmd: string) => {
      calls.push(cmd);
      return { stdout: "", stderr: "" };
    };

    const manager = new AndroidWakeLockManager({ enabled: false, execFn });
    const acquired = await manager.acquire();
    expect(acquired).toBe(false);
    expect(calls.length).toBe(0);

    const released = await manager.release();
    expect(released).toBe(false);
  });
});

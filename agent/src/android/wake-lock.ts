import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WakeLockLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface WakeLockOptions {
  enabled: boolean;
  logger?: WakeLockLogger;
  /** Injectable exec function for testing. */
  execFn?: (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
}

/**
 * Manages Android CPU wake lock for background process stability in environments
 * such as Termux. When enabled, acquires a CPU wake-lock via `termux-wake-lock` to
 * prevent Android Doze/sleep modes from killing the persistent WebSocket connection,
 * and releases it via `termux-wake-unlock` on shutdown.
 */
export class AndroidWakeLockManager {
  private acquired = false;
  private enabled: boolean;
  private logger?: WakeLockLogger;
  private execFn: (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

  constructor(options: WakeLockOptions) {
    this.enabled = options.enabled;
    this.logger = options.logger;
    this.execFn =
      options.execFn ??
      (async (cmd: string, args: string[]) => {
        const { stdout, stderr } = await execFileAsync(cmd, args, { timeout: 3000 });
        return { stdout: String(stdout), stderr: String(stderr) };
      });
  }

  get isAcquired(): boolean {
    return this.acquired;
  }

  /** Acquire CPU wake lock if enabled. */
  async acquire(): Promise<boolean> {
    if (!this.enabled || this.acquired) return this.acquired;
    try {
      await this.execFn("termux-wake-lock", []);
      this.acquired = true;
      this.logger?.info("android_wake_lock_acquired", { detail: "termux-wake-lock active" });
      return true;
    } catch (err) {
      this.logger?.warn("android_wake_lock_unavailable", {
        reason: err instanceof Error ? err.message : String(err),
        detail: "termux-wake-lock command not available or failed; running without CPU wake lock",
      });
      this.acquired = false;
      return false;
    }
  }

  /** Release CPU wake lock. */
  async release(): Promise<boolean> {
    if (!this.acquired) return false;
    try {
      await this.execFn("termux-wake-unlock", []);
      this.acquired = false;
      this.logger?.info("android_wake_lock_released", { detail: "termux-wake-unlock completed" });
      return true;
    } catch (err) {
      this.logger?.warn("android_wake_lock_release_failed", {
        reason: err instanceof Error ? err.message : String(err),
      });
      this.acquired = false;
      return false;
    }
  }
}

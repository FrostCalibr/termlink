/**
 * Fixed-window rate limiter for authentication attempts, shared across all
 * connections of a server so brute-force pressure is bounded both globally
 * and per client IP — not just per connection.
 *
 * Limits of 0 disable the corresponding check.
 */
export class AuthRateLimiter {
  private readonly windowMs: number;
  private readonly globalLimit: number;
  private readonly perIpLimit: number;
  private globalStart = 0;
  private globalCount = 0;
  private ipCounts = new Map<string, { start: number; count: number }>();

  constructor(opts: { windowMs: number; globalLimit: number; perIpLimit: number }) {
    this.windowMs = opts.windowMs;
    this.globalLimit = opts.globalLimit;
    this.perIpLimit = opts.perIpLimit;
  }

  /**
   * Atomically attempt to acquire a slot for one authentication attempt.
   * Returns false when the attempt is outside the permitted rate.
   */
  tryAcquire(ip: string | undefined): boolean {
    if (this.windowMs < 1) return true;
    const now = Date.now();

    if (this.globalLimit > 0) {
      if (now - this.globalStart >= this.windowMs) {
        this.globalStart = now;
        this.globalCount = 0;
      }
      if (this.globalCount >= this.globalLimit) return false;
    }

    if (ip && this.perIpLimit > 0) {
      let rec = this.ipCounts.get(ip);
      if (!rec || now - rec.start >= this.windowMs) {
        rec = { start: now, count: 0 };
        this.ipCounts.set(ip, rec);
      }
      if (rec.count >= this.perIpLimit) return false;
      rec.count++;
    }

    this.globalCount++;
    this.cleanup(now);
    return true;
  }

  /** Drop bookkeeping for IPs whose window has fully elapsed (bounded memory). */
  private cleanup(now: number): void {
    if (this.ipCounts.size < 1024) return;
    for (const [ip, rec] of this.ipCounts) {
      if (now - rec.start >= this.windowMs) this.ipCounts.delete(ip);
    }
  }
}
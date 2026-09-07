import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

const SECRET_BYTES = 32;

/**
 * Device identity. The agent generates a fresh 32-byte secret at enrollment
 * time and persists it with restrictive permissions (0600). The secret is
 * sent to the relay exactly once (registration) and then on every reconnect
 * (auth); the relay stores only an scrypt hash of it.
 */
export interface DeviceCredentials {
  secret: string;
  /** Whether the secret file was created on this run (first-time enrollment). */
  created: boolean;
}

/** Read an existing device secret from disk, or null when absent/empty. */
export function readDeviceSecret(filePath: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
  const secret = raw.trim();
  return secret.length > 0 ? secret : null;
}

function generateSecret(): string {
  return randomBytes(SECRET_BYTES).toString("hex");
}

function writeAll(fd: number, text: string): void {
  const buf = Buffer.from(text, "utf-8");
  let off = 0;
  while (off < buf.length) {
    const written = writeSync(fd, buf, off, buf.length - off, null);
    off += written;
  }
}

function persist(fd: number, secret: string): void {
  writeAll(fd, secret);
}

/**
 * Ensure a device secret exists on disk. Creates the file (0600) unless one
 * already exists; never overwrites an existing secret.
 */
export function ensureDeviceSecret(filePath: string): DeviceCredentials {
  const existing = readDeviceSecret(filePath);
  if (existing) return { secret: existing, created: false };

  const secret = generateSecret();
  const dir = dirname(filePath);
  if (dir !== "." && dir.length > 0) {
    mkdirSync(dir, { recursive: true });
  }
  // Create exclusively so a concurrent agent cannot overwrite each other.
  const fd = openSync(filePath, "wx", 0o600);
  try {
    persist(fd, secret);
  } finally {
    closeSync(fd);
  }
  return { secret, created: true };
}
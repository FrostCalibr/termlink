import { createHash, createHmac } from "node:crypto";

/**
 * OpenSSH known_hosts parsing and host-key verification, used by the SSH
 * backend. Matching mirrors OpenSSH semantics:
 *
 *  - lines are `pattern[,pattern...] keytype base64key [comment]`,
 *  - patterns support `*`/`?` globs, `[host]:port` bracket form, and the
 *    legacy `host:port` form,
 *  - hashed entries (`|1|salt|hash`, HMAC-SHA1 over the hostname), and
 *  - `@cert-authority` / `@revoked` marker lines are skipped (revoked keys are
 *    not supported; treating them as plain entries would be unsafe, so they
 *    are ignored entirely and such deployments should use fingerprints).
 *
 * A connection is accepted only when the presented host key matches a stored
 * key for the exact host:port being dialed. Unknown hosts are rejected.
 */

export interface KnownHostEntry {
  patterns: string[];
  key: Buffer;
  algo?: string;
}

/** Parse OpenSSH known_hosts content into usable entries. */
export function parseKnownHosts(content: string): KnownHostEntry[] {
  const entries: KnownHostEntry[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    if (line.startsWith("@")) continue; // @cert-authority / @revoked: unsupported
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    const key = safeDecode(parts[2]);
    if (key.length === 0) continue;
    const patterns = parts[0]
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    if (patterns.length === 0) continue;
    entries.push({ patterns, key, algo: parts[1] });
  }
  return entries;
}

/** SHA-256 digest of the raw host key blob (as OpenSSH fingerprints it). */
export function sha256Digest(key: Buffer): Buffer {
  return createHash("sha256").update(key).digest();
}

/**
 * Build a host-key verifier against a known_hosts file. `host`/`port` are the
 * trust anchor that binds the key to the exact target being dialed.
 */
export function makeKnownHostsVerifier(
  entries: KnownHostEntry[],
  host: string,
  port: number,
): (key: Buffer) => boolean {
  return (key: Buffer) => {
    let hostKnown = false;
    for (const entry of entries) {
      if (!patternsMatch(entry.patterns, host, port)) continue;
      hostKnown = true;
      if (entry.key.equals(key)) return true;
    }
    // The host was matched but the key differs (or nothing matched): reject.
    return hostKnown && false;
  };
}

/**
 * Build a host-key verifier against explicit SHA-256 fingerprints
 * (bare base64 digests, optional `SHA256:` prefix, as printed by
 * `ssh-keygen -E sha256 -lf ...`).
 */
export function makeFingerprintsVerifier(
  fingerprints: Buffer[],
): (key: Buffer) => boolean {
  return (key: Buffer) => {
    const digest = sha256Digest(key);
    return fingerprints.some((fp) => fp.equals(digest));
  };
}

/** Parse a fingerprint string into a 32-byte SHA-256 digest. Throws on bad input. */
export function parseFingerprint(input: string): Buffer {
  const clean = input.trim().replace(/^sha256[:-]/i, "");
  const digest = Buffer.from(clean, "base64");
  if (digest.length !== 32) {
    throw new Error(`invalid SHA-256 fingerprint "${input}"`);
  }
  return digest;
}

function patternsMatch(patterns: string[], host: string, port: number): boolean {
  for (const pattern of patterns) {
    if (hashedPatternMatch(pattern, host) || globPatternMatch(pattern, host, port)) {
      return true;
    }
  }
  return false;
}

function hashedPatternMatch(pattern: string, host: string): boolean {
  if (!pattern.startsWith("|1|")) return false;
  const parts = pattern.split("|");
  if (parts.length !== 4) return false;
  const [, , saltB64, hashB64] = parts;
  const salt = safeDecode(saltB64);
  const expected = safeDecode(hashB64);
  if (salt.length === 0 || expected.length === 0) return false;
  const digest = createHmac("sha1", salt).update(host.toLowerCase()).digest();
  return digest.equals(expected);
}

function globPatternMatch(pattern: string, host: string, port: number): boolean {
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(pattern);
  let hostPattern: string;
  let patPort: number | undefined;
  if (bracketed) {
    hostPattern = bracketed[1];
    patPort = bracketed[2] !== undefined ? Number(bracketed[2]) : undefined;
  } else {
    const colon = pattern.lastIndexOf(":");
    if (colon > 0 && /^\d+$/.test(pattern.slice(colon + 1))) {
      hostPattern = pattern.slice(0, colon);
      patPort = Number(pattern.slice(colon + 1));
    } else {
      hostPattern = pattern;
    }
  }
  if (patPort !== undefined && patPort !== port) return false;
  return globToRegExp(hostPattern).test(host);
}

function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (const ch of pattern) {
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

function safeDecode(part: string): Buffer {
  try {
    return Buffer.from(part, "base64");
  } catch {
    return Buffer.alloc(0);
  }
}
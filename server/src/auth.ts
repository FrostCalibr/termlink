import {
  createHash,
  randomBytes,
  scrypt as scryptCb,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);

interface ScryptHash {
  salt: Buffer;
  hash: Buffer;
  keylen: number;
}

const KEYLEN = 64;
const SCRYPT_FORMAT = "scrypt";

/**
 * Derive a hash from a secret using scrypt.
 * Format: scrypt$<keylen>$<salt_hex>$<hash_hex>
 */
export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = (await scrypt(secret, salt, KEYLEN)) as Buffer;
  return `${SCRYPT_FORMAT}$${KEYLEN}$${salt.toString("hex")}$${hash.toString(
    "hex",
  )}`;
}

function parseHash(stored: string): ScryptHash {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== SCRYPT_FORMAT) {
    throw new Error("Malformed stored hash");
  }
  const keylen = Number(parts[1]);
  const salt = Buffer.from(parts[2], "hex");
  const hash = Buffer.from(parts[3], "hex");
  if (Number.isNaN(keylen) || salt.length === 0 || hash.length === 0) {
    throw new Error("Malformed stored hash");
  }
  return { salt, hash, keylen };
}

/**
 * Constant-time comparison of a secret against a stored hash.
 * Returns true if they match, false otherwise.
 */
export async function verifySecret(
  secret: string,
  stored: string,
): Promise<boolean> {
  let parsed: ScryptHash;
  try {
    parsed = parseHash(stored);
  } catch {
    return false;
  }
  const candidate = (await scrypt(secret, parsed.salt, parsed.keylen)) as Buffer;
  return (
    candidate.length === parsed.hash.length &&
    timingSafeEqual(candidate, parsed.hash)
  );
}

// ── Token / credential store ────────────────────────────────────────────────

/**
 * Authenticator backed by configured credentials.
 * Tokens and passwords are never stored in plaintext internally.
 */
export class CredentialStore {
  private tokenHashes: string[] = [];
  private passwordUsers = new Map<string, string>();

  constructor(tokens: string[], passwordUsers: Map<string, string>) {
    this.tokenHashes = tokens.map((t) => hashSecretSync(t));
    for (const [username, password] of passwordUsers) {
      this.passwordUsers.set(username, hashSecretSync(password));
    }
  }

  /** Verify a token. Returns true on match. */
  async verifyToken(token: string): Promise<boolean> {
    for (const hash of this.tokenHashes) {
      if (await verifySecret(token, hash)) return true;
    }
    return false;
  }

  /** Verify username/password. Returns true on match. */
  async verifyPassword(
    username: string,
    password: string,
  ): Promise<boolean> {
    const stored = this.passwordUsers.get(username);
    if (!stored) return false;
    return verifySecret(password, stored);
  }

  /** Number of configured tokens. */
  get tokenCount(): number {
    return this.tokenHashes.length;
  }

  /** Whether password auth is available. */
  get hasPasswords(): boolean {
    return this.passwordUsers.size > 0;
  }
}

// Synchronous hashing for construction (scrypt is also available sync).
function hashSecretSync(secret: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(secret, salt, KEYLEN);
  return `${SCRYPT_FORMAT}$${KEYLEN}$${salt.toString("hex")}$${hash.toString(
    "hex",
  )}`;
}

// ── Generic utils used elsewhere ────────────────────────────────────────────
/** Generate a cryptographically secure session ID. */
export function generateSessionId(): string {
  return randomBytes(16).toString("hex");
}

/** Generate a cryptographically secure connection ID. */
export function generateConnectionId(): string {
  return randomBytes(8).toString("hex");
}

// Re-export createHash for potential future use
export { createHash, randomBytes };

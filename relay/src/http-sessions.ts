import { randomBytes } from "node:crypto";

export const SESSION_COOKIE_NAME = "termlink_sid";
const SESSION_TOKEN_BYTES = 32;
const MAX_SESSIONS = 10_000;

export interface HttpSessionRecord {
  /** Opaque session token; the bearer credential for /api/* + WS auth. */
  token: string;
  /** Relay identity: the password username, or "token" for shared-token auth. */
  username: string;
  /** How the user authenticated: `token` or `password`. */
  method: "token" | "password";
  createdAt: number;
  lastSeen: number;
}

/**
 * In-memory browser HTTP sessions for the relay's web API.
 *
 * A session is created on `POST /api/auth/login` after the presented
 * credentials pass the relay's own {@link CredentialStore}, and is referenced
 * anywhere by its opaque token (cookie or `Authorization: Bearer`). It is the
 * GUI's only credential: WebSocket connections authenticate with the same
 * token, so the browser never needs to hold or re-present the configured relay
 * token/password after login.
 *
 * Restarting the relay invalidates all sessions (documented limitation).
 */
export class HttpSessionStore {
  private sessions = new Map<string, HttpSessionRecord>();

  /** Create a session after a successful login. Returns the session. */
  create(username: string, method: "token" | "password"): HttpSessionRecord {
    this.evictIfOversized();
    const token = randomBytes(SESSION_TOKEN_BYTES).toString("hex");
    const now = Date.now();
    const session: HttpSessionRecord = {
      token,
      username,
      method,
      createdAt: now,
      lastSeen: now,
    };
    this.sessions.set(token, session);
    return session;
  }

  /**
   * Resolve a session token. Touches `lastSeen` (slides expiry) and returns
   * the record, or null for an unknown/expired token.
   */
  verify(token: string): HttpSessionRecord | null {
    const session = this.sessions.get(token);
    if (!session) return null;
    session.lastSeen = Date.now();
    return session;
  }

  /** Delete a session (logout). Returns true when it existed. */
  delete(token: string): boolean {
    return this.sessions.delete(token);
  }

  /** Number of live sessions. */
  get size(): number {
    return this.sessions.size;
  }

  private evictIfOversized(): void {
    if (this.sessions.size < MAX_SESSIONS) return;
    // Evict the least recently used sessions to keep the store bounded.
    const byLastSeen = [...this.sessions.values()].sort(
      (a, b) => a.lastSeen - b.lastSeen,
    );
    const toRemove = Math.floor(MAX_SESSIONS / 10);
    for (let i = 0; i < toRemove; i++) {
      this.sessions.delete(byLastSeen[i].token);
    }
  }
}
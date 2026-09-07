import { generateSessionId } from "./auth.js";

export interface Session {
  id: string;
  connectionId: string;
  createdAt: number;
}

/**
 * Tracks authenticated sessions.
 * Each connection gets at most one session.
 * Cleanup must be reliable and idempotent.
 */
export class SessionRegistry {
  private sessions = new Map<string, Session>();
  private connectionToSession = new Map<string, string>();

  /** Create a session for the given connection. Returns null if one exists. */
  create(connectionId: string): Session {
    const existing = this.connectionToSession.get(connectionId);
    if (existing) {
      return this.sessions.get(existing)!;
    }
    const session: Session = {
      id: generateSessionId(),
      connectionId,
      createdAt: Date.now(),
    };
    this.sessions.set(session.id, session);
    this.connectionToSession.set(connectionId, session.id);
    return session;
  }

  /** Remove a session by session ID. Idempotent. */
  removeBySessionId(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    this.connectionToSession.delete(session.connectionId);
  }

  /** Remove any session associated with a connection. Idempotent. */
  removeByConnectionId(connectionId: string): void {
    const sessionId = this.connectionToSession.get(connectionId);
    if (!sessionId) return;
    this.sessions.delete(sessionId);
    this.connectionToSession.delete(connectionId);
  }

  /** Look up a session by ID. */
  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  /** Look up the session currently attached to a connection, if any. */
  getByConnectionId(connectionId: string): Session | undefined {
    const sessionId = this.connectionToSession.get(connectionId);
    return sessionId ? this.sessions.get(sessionId) : undefined;
  }

  /**
   * Remove and return every session older than `maxAgeMs` (0 = disabled).
   * Callers must terminate the affected connections.
   */
  expireDue(maxAgeMs: number): Session[] {
    if (maxAgeMs <= 0) return [];
    const now = Date.now();
    const expired: Session[] = [];
    for (const [id, session] of this.sessions) {
      if (now - session.createdAt >= maxAgeMs) {
        this.sessions.delete(id);
        this.connectionToSession.delete(session.connectionId);
        expired.push(session);
      }
    }
    return expired;
  }

  /** Number of active sessions. */
  get size(): number {
    return this.sessions.size;
  }

  /** All active sessions. */
  all(): Session[] {
    return [...this.sessions.values()];
  }

  /** Clear all sessions and connection mappings. */
  clear(): void {
    this.sessions.clear();
    this.connectionToSession.clear();
  }
}

import { randomBytes } from "node:crypto";
import type { TargetType } from "./config.js";
import type { HttpSessionRecord } from "./http-sessions.js";

export type GuiSessionState =
  | "creating"
  | "connecting"
  | "connected"
  | "disconnected"
  | "closed";

export interface GuiSessionRecord {
  id: string;
  username: string;
  deviceId: string;
  type: TargetType;
  state: GuiSessionState;
  createdAt: number;
  connectedAt?: number;
  lastActive: number;
  /** The relay connection that currently backs this session, when attached. */
  connectionId?: string;
  closedReason?: string;
}

/** State transitions allowed out of each state. */
const TRANSITIONS: Record<GuiSessionState, GuiSessionState[]> = {
  creating: ["connecting", "closed"],
  connecting: ["connected", "disconnected", "closed"],
  connected: ["disconnected", "closed"],
  disconnected: ["connecting", "closed"],
  closed: [],
};

/**
 * Tracks GUI terminal sessions created through the web API. A session record
 * exists independently of the underlying WebSocket connection (which can be
 * dropped and re-attached on reconnect) and is bound to the HTTP user who
 * created it.
 *
 * Lifecycle:
 *   creating → connecting → connected → disconnected → (re)connecting → …
 *   any state → closed            (explicit DELETE or timeout)
 */
export class GuiSessionRegistry {
  private sessions = new Map<string, GuiSessionRecord>();
  private connectionToSession = new Map<string, string>();

  /** Create a session for a device/type. Returns the new record. */
  create(username: string, deviceId: string, type: TargetType): GuiSessionRecord {
    const now = Date.now();
    const record: GuiSessionRecord = {
      id: randomBytes(16).toString("hex"),
      username,
      deviceId,
      type,
      state: "creating",
      createdAt: now,
      lastActive: now,
    };
    this.sessions.set(record.id, record);
    return record;
  }

  get(id: string): GuiSessionRecord | undefined {
    return this.sessions.get(id);
  }

  getByConnectionId(connectionId: string): GuiSessionRecord | undefined {
    const id = this.connectionToSession.get(connectionId);
    return id ? this.sessions.get(id) : undefined;
  }

  /** All sessions belonging to an HTTP user, newest first. */
  listFor(user: HttpSessionRecord): GuiSessionRecord[] {
    return [...this.sessions.values()]
      .filter((s) => s.username === user.username)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  private transition(id: string, to: GuiSessionState, reason?: string): boolean {
    const record = this.sessions.get(id);
    if (!record) return false;
    if (!TRANSITIONS[record.state].includes(to)) return false;
    record.state = to;
    record.lastActive = Date.now();
    if (reason !== undefined) record.closedReason = reason;
    return true;
  }

  /** Allow a state change by connectionId; used on half close teardown. */
  private transitionByConnection(
    connectionId: string,
    to: GuiSessionState,
    reason?: string,
  ): boolean {
    const id = this.connectionToSession.get(connectionId);
    if (!id || !this.transition(id, to, reason)) return false;
    this.connectionToSession.delete(connectionId);
    return true;
  }

  /**
   * Associate a connection with the session (WS upgrade). Leaves `creating`,
   * and lets a dropped-but-reconnecting session re-enter `connecting`.
   */
  attach(id: string, connectionId: string): boolean {
    const record = this.sessions.get(id);
    if (!record || !TRANSITIONS[record.state].includes("connecting")) return false;
    record.state = "connecting";
    record.connectionId = connectionId;
    record.lastActive = Date.now();
    this.connectionToSession.set(connectionId, id);
    return true;
  }

  /** Mark the session's connection authenticated (WS auth succeeded). */
  markConnected(id: string, connectionId: string): boolean {
    const record = this.sessions.get(id);
    if (!record || !TRANSITIONS[record.state].includes("connected")) return false;
    record.state = "connected";
    record.connectionId = connectionId;
    record.connectedAt = Date.now();
    record.lastActive = Date.now();
    return true;
  }

  /** Detach on WS close. `closed` sessions are never downgraded. */
  markDisconnected(connectionId: string, reason?: string): void {
    this.transitionByConnection(connectionId, "disconnected", reason);
  }

  /** Explicitly close a session (DELETE). Terminates any live connection. */
  close(id: string, reason: string): boolean {
    const record = this.sessions.get(id);
    if (!record) return false;
    this.transition(id, "closed", reason);
    return true;
  }

  /**
   * Expire stale sessions: `creating` sessions that never attached, and
   * `disconnected` sessions beyond the reconnect grace window. `closed`
   * sessions older than `purgeAgeMs` are removed entirely.
   */
  sweep(createWindowMs: number, reconnectGraceMs: number, purgeAgeMs: number): void {
    const now = Date.now();
    for (const record of [...this.sessions.values()]) {
      if (record.state === "creating" && now - record.createdAt >= createWindowMs) {
        this.transition(record.id, "closed", "Session never connected");
      } else if (
        record.state === "disconnected" &&
        now - record.lastActive >= reconnectGraceMs
      ) {
        this.transition(record.id, "closed", "Reconnect window expired");
      } else if (record.state === "closed" && now - record.lastActive >= purgeAgeMs) {
        if (record.connectionId) {
          this.connectionToSession.delete(record.connectionId);
        }
        this.sessions.delete(record.id);
      }
    }
  }

  /** Number of tracked sessions. */
  get size(): number {
    return this.sessions.size;
  }

  /** Number of sessions with a live relay connection. */
  get connectionCount(): number {
    return this.connectionToSession.size;
  }
}
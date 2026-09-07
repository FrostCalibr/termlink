/**
 * DOM-free application controller.
 *
 * Owns authentication state, the device list, and the set of terminal tabs.
 * It talks to the relay only through {@link ApiClient} and to terminals only
 * through a {@link TransportFactory}, so every state transition is unit-testable
 * in Node without a browser.
 */

import { Store } from "./state.js";
import type { ApiClient, ApiError, ApiDevice, ApiUser, DeviceType, GuiSession } from "./api.js";
import { TerminalSession, type TransportFactory } from "./terminal-session.js";

export type AuthPhase = "booting" | "anonymous" | "authenticated";

export interface AppState {
  auth: AuthPhase;
  user: ApiUser | null;
  autoError: string | null;
  devices: ApiDevice[];
  devicesLoading: boolean;
  sessions: TerminalSession[];
  activeSessionId: string | null;
}

const initial: AppState = {
  auth: "booting",
  user: null,
  autoError: null,
  devices: [],
  devicesLoading: false,
  sessions: [],
  activeSessionId: null,
};

export interface AppControllerOptions {
  api: ApiClient;
  transportFactory: TransportFactory;
  /** Poll the device list every this many ms (0 disables). */
  devicePollMs?: number;
}

const DEFAULT_DEVICE_POLL_MS = 15_000;

export class AppController {
  store = new Store<AppState>({ ...initial });
  private api: ApiClient;
  private transportFactory: TransportFactory;
  private devicePollMs: number;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: AppControllerOptions) {
    this.api = options.api;
    this.transportFactory = options.transportFactory;
    this.devicePollMs = options.devicePollMs ?? DEFAULT_DEVICE_POLL_MS;
  }

  /** Determine auth state from the stored web session, then load the app. */
  async bootstrap(): Promise<void> {
    try {
      const user = await this.api.checkSession();
      if (user) {
        this.store.update((s) => ({ ...s, auth: "authenticated", user }));
        await this.loadDevicesAndSessions();
      } else {
        this.store.update((s) => ({ ...s, auth: "anonymous" }));
      }
    } catch (err) {
      this.store.update((s) => ({
        ...s,
        auth: "anonymous",
        autoError: errorMessage(err),
      }));
    }
  }

  async loginToken(token: string): Promise<boolean> {
    return this.login(() => this.api.loginWithToken(token));
  }

  async loginPassword(username: string, password: string): Promise<boolean> {
    return this.login(() => this.api.loginWithPassword(username, password));
  }

  private async login(fn: () => Promise<ApiUser>): Promise<boolean> {
    try {
      const user = await fn();
      this.store.update((s) => ({ ...s, auth: "authenticated", user, autoError: null }));
      await this.loadDevicesAndSessions();
      return true;
    } catch (err) {
      this.store.update((s) => ({ ...s, autoError: errorMessage(err) }));
      return false;
    }
  }

  async logout(): Promise<void> {
    try {
      await this.api.logout();
    } catch {
      /* best effort */
    }
    this.stopPolling();
    for (const session of [...this.store.get().sessions]) {
      session.close();
    }
    this.store.update((s) => ({
      ...s,
      auth: "anonymous",
      user: null,
      devices: [],
      sessions: [],
      activeSessionId: null,
    }));
  }

  async refreshDevices(): Promise<void> {
    try {
      const devices = await this.api.devices();
      this.store.update((s) => ({ ...s, devices }));
    } catch (err) {
      this.store.update((s) => ({ ...s, autoError: errorMessage(err) }));
    }
  }

  /**
   * Start a new session on the given device. The terminal is created and
   * connected immediately; on failure a stale record is cleaned up.
   */
  async createSession(deviceId: string): Promise<void> {
    const device = this.store.get().devices.find((d) => d.id === deviceId);
    if (!device) {
      this.store.update((s) => ({ ...s, autoError: `Unknown device "${deviceId}"` }));
      return;
    }
    const session = this.makeSession(device, { id: tempId() });
    this.addSessionToList(session);
    try {
      await session.create();
    } catch (err) {
      this.store.update((s) => ({
        ...s,
        sessions: s.sessions.filter((t) => t !== session),
        activeSessionId: s.activeSessionId === session.id ? null : s.activeSessionId,
        autoError: errorMessage(err),
      }));
      return;
    }
    this.store.update((s) => ({
      ...s,
      activeSessionId: s.activeSessionId ?? session.id,
    }));
    void device;
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.store.get().sessions.find((s) => s.id === sessionId);
    if (!session) return;
    try {
      await this.api.deleteSession(sessionId);
    } catch {
      /* session may already be gone */
    }
    session.close();
    this.store.update((s) => ({
      ...s,
      sessions: s.sessions.filter((t) => t !== session),
      activeSessionId: s.activeSessionId === sessionId ? nextActive(s, sessionId) : s.activeSessionId,
    }));
  }

  async reconnectSession(sessionId: string): Promise<void> {
    const session = this.store.get().sessions.find((s) => s.id === sessionId);
    session?.reconnect();
  }

  setActive(sessionId: string | null): void {
    if (sessionId) {
      const session = this.store.get().sessions.find((s) => s.id === sessionId);
      if (session && session.available && session.state === "disconnected") {
        session.open();
      }
    }
    this.store.update((s) => ({ ...s, activeSessionId: sessionId }));
  }

  clearAutoError(): void {
    this.store.update((s) => ({ ...s, autoError: null }));
  }

  private makeSession(device: ApiDevice, init: Pick<GuiSession, "id">): TerminalSession {
    return new TerminalSession(
      {
        api: this.api,
        transportFactory: this.transportFactory,
      },
      {
        id: init.id,
        deviceId: device.id,
        deviceName: device.name,
        type: device.type,
      },
    );
  }

  private addSessionToList(session: TerminalSession): void {
    this.store.update((s) => ({ ...s, sessions: [...s.sessions, session] }));
  }

  private async loadDevicesAndSessions(): Promise<void> {
    this.store.update((s) => ({ ...s, devicesLoading: true }));
    await Promise.all([this.refreshDevices(), this.hydrateSessions()]);
    this.store.update((s) => ({ ...s, devicesLoading: false }));
    this.startPolling();
  }

  private async hydrateSessions(): Promise<void> {
    try {
      const records = await this.api.sessions();
      const sessions = records.map((record) => {
        const session = this.makeSession(
          { id: record.deviceId, name: record.deviceName, type: record.type, online: false, latencyMs: null },
          record,
        );
        session.state = record.state === "closed" ? "closed" : "disconnected";
        // Resume sessions that are still open on the relay (the previous tab
        // or page may have simply disconnected).
        if (record.state !== "closed") session.open();
        return session;
      });
      this.store.update((s) => ({
        ...s,
        sessions,
        activeSessionId: s.activeSessionId ?? (sessions.length > 0 ? sessions[0].id : null),
      }));
    } catch (err) {
      this.store.update((s) => ({ ...s, autoError: errorMessage(err) }));
    }
  }

  private startPolling(): void {
    this.stopPolling();
    if (this.devicePollMs <= 0) return;
    this.pollTimer = setInterval(() => {
      void this.refreshDevices();
    }, this.devicePollMs);
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}

function nextActive(state: AppState, closedId: string): string | null {
  const remaining = state.sessions.filter((s) => s.id !== closedId);
  if (remaining.length === 0) return null;
  return remaining[0].id;
}

let tempIdCounter = 0;
function tempId(): string {
  tempIdCounter += 1;
  return `tmp-${tempIdCounter}-${Date.now().toString(36)}`;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
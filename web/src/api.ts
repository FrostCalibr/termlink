/**
 * Browser-facing client for the relay web API.
 *
 * The GUI never learns backend addresses or credentials: it only asks for
 * `createSession(deviceId, type)` and lets the relay resolve the backend from
 * its own static configuration. Authentication tokens are opaque and come
 * from `POST /api/auth/login`; the HttpOnly cookie is set by the server and
 * the token is also stored in `sessionStorage` so reconnects can re-authenticate.
 */

export interface ApiUser {
  name: string;
  method: string;
}

export type DeviceType = "shell" | "ssh" | "android";

export interface ApiDevice {
  id: string;
  name: string;
  type: DeviceType;
  online: boolean;
  latencyMs: number | null;
}

export type SessionState =
  | "creating"
  | "connecting"
  | "connected"
  | "disconnected"
  | "closed";

export interface GuiSession {
  id: string;
  deviceId: string;
  deviceName: string;
  type: DeviceType;
  state: SessionState;
  createdAt: number;
  connectedAt: number | null;
  lastActive: number;
  closedReason: string | null;
}

export interface CreateSessionResult {
  session: GuiSession;
  connect: { path: string };
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const TOKEN_KEY = "termlink.sessionToken";

export interface ApiClientOptions {
  /** Base URL for API calls (defaults to same-origin). */
  base?: string;
  fetchImpl?: typeof fetch;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
}

export class ApiClient {
  private base: string;
  private fetchImpl: typeof fetch;
  private storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  private sessionToken: string | null;

  constructor(options: ApiClientOptions = {}) {
    this.base = (options.base ?? "").replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.storage = options.storage ?? safeSessionStorage();
    this.sessionToken = this.storage.getItem(TOKEN_KEY);
  }

  /** The bearer token returned by the last successful login, if any. */
  get token(): string | null {
    return this.sessionToken;
  }

  async loginWithToken(token: string): Promise<ApiUser> {
    return this.login({ token });
  }

  async loginWithPassword(username: string, password: string): Promise<ApiUser> {
    return this.login({ username, password });
  }

  private async login(
    body: { token: string } | { username: string; password: string },
  ): Promise<ApiUser> {
    const res = await this.request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { user: ApiUser; session: { token: string } };
    this.sessionToken = json.session.token;
    this.storage.setItem(TOKEN_KEY, json.session.token);
    return json.user;
  }

  /** Returns the current user, or null when not authenticated. */
  async checkSession(): Promise<ApiUser | null> {
    try {
      const res = await this.request("/api/auth/session");
      const json = (await res.json()) as { user: ApiUser };
      return json.user;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return null;
      throw err;
    }
  }

  async logout(): Promise<void> {
    try {
      await this.request("/api/auth/logout", { method: "POST" });
    } finally {
      this.sessionToken = null;
      this.storage.removeItem(TOKEN_KEY);
    }
  }

  async devices(): Promise<ApiDevice[]> {
    const res = await this.request("/api/devices");
    const json = (await res.json()) as { devices: ApiDevice[] };
    return json.devices;
  }

  async sessions(): Promise<GuiSession[]> {
    const res = await this.request("/api/sessions");
    const json = (await res.json()) as { sessions: GuiSession[] };
    return json.sessions;
  }

  async createSession(deviceId: string, type: DeviceType): Promise<CreateSessionResult> {
    const res = await this.request(`/api/devices/${encodeURIComponent(deviceId)}/sessions`, {
      method: "POST",
      body: JSON.stringify({ type }),
    });
    return res.json() as Promise<CreateSessionResult>;
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.request(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    });
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...((init.headers as Record<string, string>) ?? {}),
    };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    if (this.sessionToken) headers["Authorization"] = `Bearer ${this.sessionToken}`;

    const res = await this.fetchImpl(this.base + path, {
      ...init,
      headers,
      credentials: "same-origin",
    });
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const err = (await res.json()) as { error?: string };
        if (err.error) message = err.error;
      } catch {
        /* non-JSON error body */
      }
      throw new ApiError(res.status, message);
    }
    return res;
  }
}

function safeSessionStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  try {
    const s = globalThis.sessionStorage;
    if (s) return s;
  } catch {
    /* storage unavailable (e.g. some tests) */
  }
  const mem = new Map<string, string>();
  return {
    getItem: (k) => mem.get(k) ?? null,
    setItem: (k, v) => {
      mem.set(k, v);
    },
    removeItem: (k) => {
      mem.delete(k);
    },
  };
}
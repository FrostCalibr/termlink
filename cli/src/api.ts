import type { CliConfig } from "./config.js";

export interface ApiDevice {
  id: string;
  name: string;
  type: "shell" | "ssh" | "android";
  online: boolean;
  latencyMs: number | null;
}

export interface ApiSession {
  id: string;
  deviceId: string;
  deviceName: string;
  type: "shell" | "ssh" | "android";
  state: "creating" | "connecting" | "connected" | "disconnected" | "closed";
  createdAt: number;
  lastActive: number;
  closedReason: string | null;
}

export interface CreateSessionResponse {
  session: ApiSession;
  connect: { path: string };
}

export class CliApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "CliApiError";
  }
}

export interface CliApiOptions {
  fetchImpl?: typeof fetch;
}

export class CliApiClient {
  private fetchImpl: typeof fetch;

  constructor(options: CliApiOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async loginToken(relayUrl: string, token: string): Promise<CliConfig> {
    const url = `${relayUrl.replace(/\/+$/, "")}/api/auth/login`;
    const res = await this.request(url, {
      method: "POST",
      body: JSON.stringify({ token }),
    });
    const json = (await res.json()) as {
      user: { name: string; method: string };
      session: { token: string };
    };
    return {
      relayUrl: relayUrl.replace(/\/+$/, ""),
      sessionToken: json.session.token,
      username: json.user.name,
    };
  }

  async loginPassword(
    relayUrl: string,
    username: string,
    password: string,
  ): Promise<CliConfig> {
    const url = `${relayUrl.replace(/\/+$/, "")}/api/auth/login`;
    const res = await this.request(url, {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    const json = (await res.json()) as {
      user: { name: string; method: string };
      session: { token: string };
    };
    return {
      relayUrl: relayUrl.replace(/\/+$/, ""),
      sessionToken: json.session.token,
      username: json.user.name,
    };
  }

  async listDevices(config: CliConfig): Promise<ApiDevice[]> {
    const url = `${config.relayUrl}/api/devices`;
    const res = await this.request(url, {
      headers: { Authorization: `Bearer ${config.sessionToken}` },
    });
    const json = (await res.json()) as { devices: ApiDevice[] };
    return json.devices;
  }

  async listSessions(config: CliConfig): Promise<ApiSession[]> {
    const url = `${config.relayUrl}/api/sessions`;
    const res = await this.request(url, {
      headers: { Authorization: `Bearer ${config.sessionToken}` },
    });
    const json = (await res.json()) as { sessions: ApiSession[] };
    return json.sessions;
  }

  async createSession(
    config: CliConfig,
    deviceId: string,
    type: "shell" | "ssh" | "android" = "shell",
  ): Promise<CreateSessionResponse> {
    const url = `${config.relayUrl}/api/devices/${encodeURIComponent(deviceId)}/sessions`;
    const res = await this.request(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.sessionToken}` },
      body: JSON.stringify({ type }),
    });
    return (await res.json()) as CreateSessionResponse;
  }

  async deleteSession(config: CliConfig, sessionId: string): Promise<void> {
    const url = `${config.relayUrl}/api/sessions/${encodeURIComponent(sessionId)}`;
    await this.request(url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${config.sessionToken}` },
    });
  }

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...((init.headers as Record<string, string>) ?? {}),
    };
    if (init.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const res = await this.fetchImpl(url, { ...init, headers });
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const err = (await res.json()) as { error?: string };
        if (err.error) message = err.error;
      } catch {
        /* non-JSON response */
      }
      throw new CliApiError(res.status, message);
    }
    return res;
  }
}

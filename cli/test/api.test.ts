import { describe, it, expect, vi } from "vitest";
import { CliApiClient, CliApiError } from "../src/api.js";
import type { CliConfig } from "../src/config.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("CliApiClient", () => {
  const dummyConfig: CliConfig = {
    relayUrl: "http://127.0.0.1:19001",
    sessionToken: "cli-token",
    username: "alice",
  };

  it("authenticates via loginToken and returns CliConfig", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return jsonResponse({
        user: { name: "token-user", method: "token" },
        session: { token: "new-session-token" },
      });
    }) as typeof fetch;

    const api = new CliApiClient({ fetchImpl });
    const config = await api.loginToken("http://127.0.0.1:19001", "my-token");

    expect(config).toEqual({
      relayUrl: "http://127.0.0.1:19001",
      sessionToken: "new-session-token",
      username: "token-user",
    });
    expect(calls[0].url).toBe("http://127.0.0.1:19001/api/auth/login");
    expect(calls[0].body).toEqual({ token: "my-token" });
  });

  it("authenticates via loginPassword", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return jsonResponse({
        user: { name: "admin", method: "password" },
        session: { token: "pass-token" },
      });
    }) as typeof fetch;

    const api = new CliApiClient({ fetchImpl });
    const config = await api.loginPassword("http://127.0.0.1:19001", "admin", "secret");

    expect(config.username).toBe("admin");
    expect(config.sessionToken).toBe("pass-token");
    expect(calls[0].body).toEqual({ username: "admin", password: "secret" });
  });

  it("fetches device list with Bearer token", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        headers: (init?.headers as Record<string, string>) ?? {},
      });
      return jsonResponse({
        devices: [{ id: "pc1", name: "PC 1", type: "shell", online: true, latencyMs: 5 }],
      });
    }) as typeof fetch;

    const api = new CliApiClient({ fetchImpl });
    const devices = await api.listDevices(dummyConfig);

    expect(devices).toHaveLength(1);
    expect(devices[0].id).toBe("pc1");
    expect(calls[0].url).toBe("http://127.0.0.1:19001/api/devices");
    expect(calls[0].headers.Authorization).toBe("Bearer cli-token");
  });

  it("creates a session on a target device", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return jsonResponse({
        session: { id: "s1", deviceId: "pc1", type: "shell", state: "creating" },
        connect: { path: "/ws?device=pc1&type=shell&session=s1" },
      });
    }) as typeof fetch;

    const api = new CliApiClient({ fetchImpl });
    const result = await api.createSession(dummyConfig, "pc1", "shell");

    expect(result.session.id).toBe("s1");
    expect(result.connect.path).toBe("/ws?device=pc1&type=shell&session=s1");
    expect(calls[0].url).toBe("http://127.0.0.1:19001/api/devices/pc1/sessions");
    expect(calls[0].method).toBe("POST");
  });

  it("throws CliApiError with status on API failure", async () => {
    const fetchImpl = (async () => jsonResponse({ error: "Device offline" }, 409)) as typeof fetch;
    const api = new CliApiClient({ fetchImpl });

    await expect(api.createSession(dummyConfig, "offline-pc", "shell")).rejects.toMatchObject({
      status: 409,
      message: "Device offline",
    });
  });
});

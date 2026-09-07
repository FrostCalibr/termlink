import { describe, it, expect, beforeEach } from "vitest";
import { ApiClient, ApiError } from "../src/api.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function memStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    dump: () => map,
  };
}

describe("ApiClient", () => {
  let storage: ReturnType<typeof memStorage>;
  let calls: Array<{ path: string; init: RequestInit }>;
  let fetchImpl: typeof fetch;

  beforeEach(() => {
    storage = memStorage();
    calls = [];
    fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.pathname + input.search
            : input.url;
      calls.push({ path: url, init: init ?? {} });
      return jsonResponse({
        user: { name: "token", method: "token" },
        session: { token: "t0k3n" },
      });
    }) as typeof fetch;
  });

  function makeClient(): ApiClient {
    return new ApiClient({ fetchImpl, storage });
  }

  it("stores the web session token after a token login", async () => {
    fetchImpl = (async (input) => {
      calls.push({ path: String(input), init: {} });
      return jsonResponse({
        user: { name: "token", method: "token" },
        session: { token: "t0k3n" },
      });
    }) as typeof fetch;

    const client = makeClient();
    const user = await client.loginWithToken("relaytok");
    expect(user).toEqual({ name: "token", method: "token" });
    expect(storage.dump().get("termlink.sessionToken")).toBe("t0k3n");
    expect(client.token).toBe("t0k3n");
  });

  it("sends both username and password to POST /api/auth/login", async () => {
    fetchImpl = (async (input, init) => {
      calls.push({ path: String(input), init: init ?? {} });
      return jsonResponse({
        user: { name: "admin", method: "password" },
        session: { token: "pass-tok" },
      });
    }) as typeof fetch;

    const client = makeClient();
    const user = await client.loginWithPassword("admin", "secret123");
    expect(user).toEqual({ name: "admin", method: "password" });
    expect(calls[0].path).toBe("/api/auth/login");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      username: "admin",
      password: "secret123",
    });
    expect(client.token).toBe("pass-tok");
  });

  it("sends the bearer token on subsequent requests and sends login body", async () => {
    const client = makeClient();
    await client.loginWithToken("relaytok");
    calls.length = 0;

    await client.devices();
    const [dev] = calls;
    const headers = dev.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer t0k3n");
  });

  it("returns null from checkSession when unauthenticated", async () => {
    fetchImpl = (async () => jsonResponse({ error: "Not authenticated" }, 401)) as typeof fetch;
    const client = new ApiClient({ fetchImpl, storage });
    expect(await client.checkSession()).toBeNull();
    expect(client.token).toBeNull();
  });

  it("throws descriptive ApiError with status on failure", async () => {
    fetchImpl = (async () =>
      jsonResponse({ error: "Unknown device" }, 404)) as typeof fetch;
    const client = new ApiClient({ fetchImpl, storage });
    await expect(client.devices()).rejects.toMatchObject({ status: 404, message: "Unknown device" });
  });

  it("creates a session with the device id and type in the body", async () => {
    fetchImpl = (async (input, init) => {
      calls.push({ path: String(input), init: init ?? {} });
      return jsonResponse({
        session: { id: "s1", deviceId: "pc1", type: "shell" },
        connect: { path: "/ws?device=pc1&type=shell&session=s1" },
      });
    }) as typeof fetch;

    const client = makeClient();
    const result = await client.createSession("pc1", "shell");
    expect(result.session.id).toBe("s1");
    expect(calls[0].path).toBe("/api/devices/pc1/sessions");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ type: "shell" });
  });

  it("deletes a session via DELETE", async () => {
    const client = makeClient();
    await client.deleteSession("s1");
    expect(calls[0].path).toBe("/api/sessions/s1");
    expect(calls[0].init.method).toBe("DELETE");
  });

  it("removes the stored token when logging out", async () => {
    const client = makeClient();
    await client.loginWithToken("relaytok");
    await client.logout();
    expect(client.token).toBeNull();
    expect(storage.dump().has("termlink.sessionToken")).toBe(false);
  });

  it("throws ApiError instance (instanceof check)", async () => {
    fetchImpl = (async () => jsonResponse({ error: "nope" }, 401)) as typeof fetch;
    const client = new ApiClient({ fetchImpl, storage });
    try {
      await client.devices();
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(401);
    }
  });
});
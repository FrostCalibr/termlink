import { describe, it, expect, afterEach } from "vitest";
import { api, login, makeRelay, resetTracked } from "./helpers.js";

afterEach(async () => {
  await resetTracked();
});

describe("relay web API", () => {
  it("logs in with a token and persists the session", async () => {
    const { port } = await makeRelay();

    const bad = await api(port, "/api/auth/login", {
      method: "POST",
      body: { token: "wrong" },
    });
    expect(bad.status).toBe(401);

    const ok = await api(port, "/api/auth/login", {
      method: "POST",
      body: { token: "relaytok" },
    });
    expect(ok.status).toBe(200);
    const user = (ok.json as { user: { name: string } }).user;
    expect(user.name).toBe("token");
    const sid = (ok.json as { session: { token: string } }).session.token;

    const me = await api(port, "/api/auth/session", { token: sid });
    expect(me.status).toBe(200);
    expect((me.json as { user: { name: string } }).user.name).toBe("token");

    const anon = await api(port, "/api/auth/session");
    expect(anon.status).toBe(401);
  });

  it("logs in with username/password and exposes the identity", async () => {
    const { port } = await makeRelay();
    const ok = await api(port, "/api/auth/login", {
      method: "POST",
      body: { username: "alice", password: "secret" },
    });
    expect(ok.status).toBe(200);
    const sid = (ok.json as { session: { token: string } }).session.token;
    const me = await api(port, "/api/auth/session", { token: sid });
    expect((me.json as { user: { name: string } }).user).toEqual({
      name: "alice",
      method: "password",
    });
  });

  it("rejects malformed login requests", async () => {
    const { port } = await makeRelay();
    expect(await api(port, "/api/auth/login", { method: "POST", body: {} })).toMatchObject({
      status: 400,
    });
    expect(
      await api(port, "/api/auth/login", {
        method: "POST",
        body: { username: "alice" },
      }),
    ).toMatchObject({ status: 400 });
    expect(
      await api(port, "/api/auth/login", { method: "POST", body: "{not json" }),
    ).toMatchObject({ status: 400 });
  });

  it("logs out and invalidates the session token", async () => {
    const { port } = await makeRelay();
    const sid = await login(port, { token: "relaytok" });

    expect((await api(port, "/api/auth/logout", { method: "POST", token: sid })).status).toBe(200);
    expect((await api(port, "/api/auth/session", { token: sid })).status).toBe(401);
  });

  it("lists devices with metadata, never exposing backend addresses", async () => {
    const { port } = await makeRelay();
    const sid = await login(port, { token: "relaytok" });

    const res = await api(port, "/api/devices", { token: sid });
    expect(res.status).toBe(200);
    const devices = (res.json as { devices: Array<Record<string, unknown>> }).devices;
    expect(devices).toHaveLength(2);
    expect(devices[0]).toMatchObject({ id: "alpha", name: "Alpha", type: "shell" });
    expect(devices[1]).toMatchObject({ id: "beta", name: "Beta host", type: "ssh" });
    // Backend address must not leak to the browser.
    const serialized = JSON.stringify(devices);
    expect(serialized).not.toMatch(/127\.0\.0\.1/);
    expect(serialized).not.toContain("backendtok");

    // Unauthenticated requests are rejected.
    expect((await api(port, "/api/devices")).status).toBe(401);
  });

  it("reports a configured-but-unreachable device as offline", async () => {
    const { port } = await makeRelay({
      targets: ["alpha|Alpha|shell=backendtok@127.0.0.1:1"],
    });
    const sid = await login(port, { token: "relaytok" });

    const res = await api(port, "/api/devices", { token: sid });
    const devices = (res.json as { devices: Array<Record<string, unknown>> }).devices;
    expect(devices[0]).toMatchObject({ id: "alpha", online: false });
  });

  it("creates, lists, and deletes GUI sessions", async () => {
    const { port } = await makeRelay();
    const sid = await login(port, { username: "alice", password: "secret" });

    const created = await api(port, "/api/devices/alpha/sessions", {
      method: "POST",
      token: sid,
      body: { type: "shell" },
    });
    expect(created.status).toBe(201);
    const session = (created.json as { session: Record<string, unknown> }).session;
    expect(session).toMatchObject({
      deviceId: "alpha",
      deviceName: "Alpha",
      type: "shell",
      state: "creating",
    });
    const connect = (created.json as { connect: { path: string } }).connect;
    expect(connect.path).toBe(`/ws?device=alpha&type=shell&session=${session.id}`);

    const list = await api(port, "/api/sessions", { token: sid });
    expect((list.json as { sessions: unknown[] }).sessions).toHaveLength(1);

    const del = await api(port, `/api/sessions/${session.id}`, {
      method: "DELETE",
      token: sid,
    });
    expect(del.status).toBe(200);

    const after = await api(port, "/api/sessions", { token: sid });
    const sessions = (after.json as { sessions: Array<{ state: string }> }).sessions;
    expect(sessions[0].state).toBe("closed");
  });

  it("rejects unknown devices and unsupported session types", async () => {
    const { port } = await makeRelay();
    const sid = await login(port, { token: "relaytok" });

    expect(
      await api(port, "/api/devices/nope/sessions", {
        method: "POST",
        token: sid,
        body: { type: "shell" },
      }),
    ).toMatchObject({ status: 404 });
    expect(
      await api(port, "/api/devices/alpha/sessions", {
        method: "POST",
        token: sid,
        body: { type: "ssh" },
      }),
    ).toMatchObject({ status: 400 });
  });

  it("scopes sessions to the creating user", async () => {
    const { port } = await makeRelay();
    const alice = await login(port, { username: "alice", password: "secret" });
    const bob = await login(port, { username: "bob", password: "pw" });

    const created = await api(port, "/api/devices/alpha/sessions", {
      method: "POST",
      token: alice,
      body: { type: "shell" },
    });
    const session = (created.json as { session: Record<string, unknown> }).session;

    // Bob cannot see or delete Alice's session.
    const list = await api(port, "/api/sessions", { token: bob });
    expect((list.json as { sessions: unknown[] }).sessions).toHaveLength(0);
    expect(
      (
        await api(port, `/api/sessions/${session.id}`, {
          method: "DELETE",
          token: bob,
        })
      ).status,
    ).toBe(404);
  });
});
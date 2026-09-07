import { describe, it, expect } from "vitest";
import { ClientProtocol, buildAuthRequest } from "../src/protocol.js";

function makeProtocol() {
  const events: string[] = [];
  const protocol = new ClientProtocol({
    onHello: (methods) => events.push(`hello:${methods.join(",")}`),
    onAuthOk: (id) => events.push(`auth_ok:${id}`),
    onAuthFail: (r) => events.push(`auth_fail:${r}`),
    onData: (p) => events.push(`data:${p}`),
    onBinary: (p) => events.push(`binary:${p}`),
    onGoodbye: (r) => events.push(`goodbye:${r ?? "none"}`),
    onPong: () => events.push("pong"),
  });
  return { protocol, events };
}

describe("ClientProtocol state machine", () => {
  it("transitions to waiting_hello on connected", () => {
    const { protocol } = makeProtocol();
    protocol.connected();
    expect(protocol.stateValue).toBe("waiting_hello");
  });

  it("handles hello and advertises auth methods", () => {
    const { protocol, events } = makeProtocol();
    protocol.connected();
    protocol.handle({ type: "hello", version: 1, auth_methods: ["token"] });
    expect(events).toContain("hello:token");
    expect(protocol.stateValue).toBe("authenticating");
  });

  it("rejects data while waiting for hello", () => {
    const { protocol } = makeProtocol();
    protocol.connected();
    expect(() => protocol.handle({ type: "data", data: "x" })).toThrow(/waiting_hello/);
  });

  it("handles auth_ok and becomes ready", () => {
    const { protocol, events } = makeProtocol();
    protocol.connected();
    protocol.handle({ type: "hello", version: 1, auth_methods: ["token"] });
    protocol.handle({ type: "auth_ok", session_id: "s1" });
    expect(events).toContain("auth_ok:s1");
    expect(protocol.isReady).toBe(true);
  });

  it("handles auth_fail without becoming ready", () => {
    const { protocol, events } = makeProtocol();
    protocol.connected();
    protocol.handle({ type: "hello", version: 1, auth_methods: ["token"] });
    protocol.handle({ type: "auth_fail", reason: "bad token" });
    expect(events).toContain("auth_fail:bad token");
    expect(protocol.isReady).toBe(false);
  });

  it("rejects auth_ok before a hello", () => {
    const { protocol } = makeProtocol();
    protocol.connected();
    expect(() => protocol.handle({ type: "auth_ok", session_id: "s1" })).toThrow(
      /waiting_hello/,
    );
  });

  it("handles data only while ready", () => {
    const { protocol, events } = makeProtocol();
    protocol.connected();
    protocol.handle({ type: "hello", version: 1, auth_methods: ["token"] });
    protocol.handle({ type: "auth_ok", session_id: "s1" });
    protocol.handle({ type: "data", data: "hello" });
    expect(events).toContain("data:hello");
  });

  it("handles binary only while ready", () => {
    const { protocol, events } = makeProtocol();
    protocol.connected();
    protocol.handle({ type: "hello", version: 1, auth_methods: ["token"] });
    protocol.handle({ type: "auth_ok", session_id: "s1" });
    protocol.handle({ type: "binary", data: "AQID" });
    expect(events).toContain("binary:AQID");
  });

  it("handles pong only while ready", () => {
    const { protocol, events } = makeProtocol();
    protocol.connected();
    protocol.handle({ type: "hello", version: 1, auth_methods: ["token"] });
    protocol.handle({ type: "auth_ok", session_id: "s1" });
    protocol.handle({ type: "pong" });
    expect(events).toContain("pong");
  });

  it("moves to closing on goodbye", () => {
    const { protocol, events } = makeProtocol();
    protocol.connected();
    protocol.handle({ type: "hello", version: 1, auth_methods: ["token"] });
    protocol.handle({ type: "auth_ok", session_id: "s1" });
    protocol.handle({ type: "goodbye", reason: "bye" });
    expect(events).toContain("goodbye:bye");
    expect(protocol.stateValue).toBe("closing");
  });

  it("accepts goodbye during authenticating", () => {
    const { protocol, events } = makeProtocol();
    protocol.connected();
    protocol.handle({ type: "hello", version: 1, auth_methods: ["token"] });
    protocol.handle({ type: "goodbye" });
    expect(events).toContain("goodbye:none");
  });

  it("rejects data after closing", () => {
    const { protocol } = makeProtocol();
    protocol.connected();
    protocol.handle({ type: "hello", version: 1, auth_methods: ["token"] });
    protocol.handle({ type: "auth_ok", session_id: "s1" });
    protocol.handle({ type: "goodbye" });
    expect(() => protocol.handle({ type: "data", data: "late" })).toThrow(
      /closing/,
    );
  });

  it("returns to disconnected", () => {
    const { protocol } = makeProtocol();
    protocol.connected();
    protocol.disconnected();
    expect(protocol.stateValue).toBe("disconnected");
  });
});

describe("buildAuthRequest", () => {
  it("prefers token auth when advertised", () => {
    const msg = buildAuthRequest(["token", "password"], { token: "tok" });
    expect(msg).toEqual({ type: "auth_request", method: "token", token: "tok" });
  });

  it("falls back to password auth", () => {
    const msg = buildAuthRequest(["password"], {
      username: "u",
      password: "p",
    });
    expect(msg).toEqual({
      type: "auth_request",
      method: "password",
      username: "u",
      password: "p",
    });
  });

  it("throws when no credentials match the advertised methods", () => {
    expect(() => buildAuthRequest(["token"], {})).toThrow(/No usable credentials/);
    expect(() =>
      buildAuthRequest(["password"], { token: "tok" }),
    ).toThrow(/No usable credentials/);
  });
});
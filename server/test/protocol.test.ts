import { describe, it, expect, vi, beforeEach } from "vitest";
import { Protocol } from "../src/protocol.js";
import type { ServerMessage, ClientMessage } from "../../shared/protocol/types.js";

function makeProtocol() {
  const sent: ServerMessage[] = [];
  const received: string[] = [];
  const authRequests: ClientMessage[] = [];
  const protocol = new Protocol({
    send: (msg) => sent.push(msg),
    onAuthRequest: (msg) => authRequests.push(msg),
    onData: (payload) => received.push(payload),
    onBinary: (payload) => received.push(`binary:${payload}`),
  });
  return { protocol, sent, received, authRequests };
}

describe("Protocol state machine", () => {
  it("sends hello on start", () => {
    const { protocol, sent } = makeProtocol();
    protocol.hello(["token", "password"]);
    expect(sent[0]).toEqual({
      type: "hello",
      version: 1,
      auth_methods: ["token", "password"],
    });
    expect(protocol.stateValue).toBe("authenticating");
  });

  it("rejects hello when not in connecting state", () => {
    const { protocol } = makeProtocol();
    protocol.hello(["token"]);
    expect(() => protocol.hello(["token"])).toThrow();
  });

  it("accepts an auth_request during authenticating", () => {
    const { protocol, authRequests } = makeProtocol();
    protocol.hello(["token"]);
    protocol.handle({ type: "auth_request", method: "token", token: "abc" });
    expect(authRequests).toHaveLength(1);
    expect(protocol.stateValue).toBe("authenticating");
  });

  it("rejects data before authentication", () => {
    const { protocol } = makeProtocol();
    protocol.hello(["token"]);
    expect(() => protocol.handle({ type: "data", data: "x" })).toThrow(
      /not valid in state "authenticating"/,
    );
  });

  it("rejects binary before authentication", () => {
    const { protocol } = makeProtocol();
    protocol.hello(["token"]);
    expect(() => protocol.handle({ type: "binary", data: "x" })).toThrow(
      /not valid in state "authenticating"/,
    );
  });

  it("rejects ping before authentication", () => {
    const { protocol } = makeProtocol();
    protocol.hello(["token"]);
    expect(() => protocol.handle({ type: "ping" })).toThrow();
  });

  it("transitions to ready on authOk", () => {
    const { protocol, sent } = makeProtocol();
    protocol.hello(["token"]);
    protocol.authOk("sess-1");
    expect(protocol.isReady).toBe(true);
    expect(sent[1]).toEqual({ type: "auth_ok", session_id: "sess-1" });
  });

  it("authFail does not make the connection ready", () => {
    const { protocol, sent } = makeProtocol();
    protocol.hello(["token"]);
    protocol.authFail("bad");
    expect(protocol.isReady).toBe(false);
    expect(sent[1]).toEqual({ type: "auth_fail", reason: "bad" });
  });

  it("accepts data after authentication", () => {
    const { protocol, received } = makeProtocol();
    protocol.hello(["token"]);
    protocol.authOk("sess-1");
    protocol.handle({ type: "data", data: "echo" });
    expect(received).toEqual(["echo"]);
  });

  it("accepts binary after authentication", () => {
    const { protocol, received } = makeProtocol();
    protocol.hello(["token"]);
    protocol.authOk("sess-1");
    protocol.handle({ type: "binary", data: "AQID" });
    expect(received).toEqual(["binary:AQID"]);
  });

  it("answers ping with pong after authentication", () => {
    const { protocol, sent } = makeProtocol();
    protocol.hello(["token"]);
    protocol.authOk("sess-1");
    protocol.handle({ type: "ping" });
    expect(sent.some((m) => m.type === "pong")).toBe(true);
  });

  it("moves to closing on goodbye", () => {
    const { protocol, sent } = makeProtocol();
    protocol.hello(["token"]);
    protocol.authOk("sess-1");
    protocol.handle({ type: "goodbye", reason: "bye" });
    expect(protocol.stateValue).toBe("closing");
    const goodbye = sent.find((m) => m.type === "goodbye");
    expect(goodbye).toEqual({ type: "goodbye", reason: "bye" });
  });

  it("rejects data after goodbye", () => {
    const { protocol } = makeProtocol();
    protocol.hello(["token"]);
    protocol.authOk("sess-1");
    protocol.handle({ type: "goodbye" });
    expect(() => protocol.handle({ type: "data", data: "late" })).toThrow(
      /not valid in state "closing"/,
    );
  });

  it("peerClosed transitions to closing from ready", () => {
    const { protocol } = makeProtocol();
    protocol.hello(["token"]);
    protocol.authOk("sess-1");
    protocol.peerClosed();
    expect(protocol.stateValue).toBe("closing");
  });

  it("throws on an auth_ok when not authenticating", () => {
    const { protocol } = makeProtocol();
    protocol.hello(["token"]);
    protocol.authOk("sess-1");
    expect(() => protocol.authOk("sess-2")).toThrow(/not valid in state "ready"/);
  });
});
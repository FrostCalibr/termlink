import { describe, it, expect } from "vitest";
import {
  CredentialStore,
  hashSecret,
  verifySecret,
  generateSessionId,
} from "../src/auth.js";

describe("hashSecret / verifySecret", () => {
  it("hashes and verifies a secret", async () => {
    const stored = await hashSecret("sup3rs3cret");
    expect(stored).not.toContain("sup3rs3cret");
    expect(await verifySecret("sup3rs3cret", stored)).toBe(true);
    expect(await verifySecret("wrong", stored)).toBe(false);
  });

  it("uses a random salt (two hashes differ)", async () => {
    const a = await hashSecret("same");
    const b = await hashSecret("same");
    expect(a).not.toBe(b);
  });

  it("rejects a malformed stored hash", async () => {
    expect(await verifySecret("x", "not-a-hash")).toBe(false);
    expect(await verifySecret("x", "md5$16$aa$bb")).toBe(false);
  });

  it("does not store the plaintext", async () => {
    const stored = await hashSecret("hunter2");
    expect(stored).not.toMatch(/hunter2/);
  });
});

describe("CredentialStore", () => {
  it("verifies configured tokens", async () => {
    const store = new CredentialStore(
      ["token-a", "token-b"],
      new Map([["alice", "pw1"]]),
    );
    expect(await store.verifyToken("token-a")).toBe(true);
    expect(await store.verifyToken("token-b")).toBe(true);
    expect(await store.verifyToken("nope")).toBe(false);
  });

  it("verifies configured passwords", async () => {
    const store = new CredentialStore([], new Map([["alice", "pw1"]]));
    expect(await store.verifyPassword("alice", "pw1")).toBe(true);
    expect(await store.verifyPassword("alice", "wrong")).toBe(false);
    expect(await store.verifyPassword("bob", "pw1")).toBe(false);
  });

  it("reports available methods", () => {
    const tokenOnly = new CredentialStore(["t"], new Map());
    expect(tokenOnly.tokenCount).toBe(1);
    expect(tokenOnly.hasPasswords).toBe(false);

    const both = new CredentialStore(["t"], new Map([["u", "p"]]));
    expect(both.hasPasswords).toBe(true);
  });
});

describe("session ID generation", () => {
  it("generates unique session IDs", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      seen.add(generateSessionId());
    }
    expect(seen.size).toBe(1000);
  });
});
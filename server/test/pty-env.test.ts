import { describe, it, expect } from "vitest";
import { buildPtyEnv, isSensitiveEnvKey } from "../src/pty.js";

describe("PTY Environment Handling", () => {
  it("inherits normal desktop and session environment variables when present", () => {
    const fakeProcessEnv = {
      PATH: "/usr/bin:/bin",
      HOME: "/home/tester",
      USER: "tester",
      XDG_SESSION_TYPE: "wayland",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      DISPLAY: ":0",
      WAYLAND_DISPLAY: "wayland-0",
      XDG_RUNTIME_DIR: "/run/user/1000",
      DESKTOP_SESSION: "ubuntu",
      COLORTERM: "truecolor",
      SSH_AUTH_SOCK: "/run/user/1000/keyring/ssh",
    };

    const env = buildPtyEnv("/bin/bash", "/home/tester", fakeProcessEnv);

    expect(env.XDG_SESSION_TYPE).toBe("wayland");
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBe("unix:path=/run/user/1000/bus");
    expect(env.DISPLAY).toBe(":0");
    expect(env.WAYLAND_DISPLAY).toBe("wayland-0");
    expect(env.XDG_RUNTIME_DIR).toBe("/run/user/1000");
    expect(env.DESKTOP_SESSION).toBe("ubuntu");
    expect(env.COLORTERM).toBe("truecolor");
    expect(env.SSH_AUTH_SOCK).toBe("/run/user/1000/keyring/ssh");
  });

  it("explicitly strips agent credentials, device secrets, and auth configuration", () => {
    const fakeProcessEnv = {
      PATH: "/usr/bin:/bin",
      HOME: "/home/tester",
      AUTH_TOKENS: "secret-token-123",
      AUTH_TOKENS_FILE: "/etc/auth_tokens",
      PASSWORD_USERS: "admin:changeme",
      RELAY_URL: "wss://relay.example.com",
      AGENT_DEVICE_ID: "pc-agent-01",
      AGENT_CREDENTIALS_FILE: "/etc/agent-device.secret",
      CREDENTIALS_FILE: "/etc/device.secret",
      AGENT_ENROLLMENT_TOKEN: "enrollment-secret",
      SSH_PASSWORD: "ssh-password",
      SSH_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----",
      TLS_KEY: "-----BEGIN PRIVATE KEY-----",
      MY_CUSTOM_SECRET: "topsecret",
      MY_API_TOKEN: "api-token-value",
    };

    const env = buildPtyEnv("/bin/bash", "/home/tester", fakeProcessEnv);

    expect(env.AUTH_TOKENS).toBeUndefined();
    expect(env.AUTH_TOKENS_FILE).toBeUndefined();
    expect(env.PASSWORD_USERS).toBeUndefined();
    expect(env.RELAY_URL).toBeUndefined();
    expect(env.AGENT_DEVICE_ID).toBeUndefined();
    expect(env.AGENT_CREDENTIALS_FILE).toBeUndefined();
    expect(env.CREDENTIALS_FILE).toBeUndefined();
    expect(env.AGENT_ENROLLMENT_TOKEN).toBeUndefined();
    expect(env.SSH_PASSWORD).toBeUndefined();
    expect(env.SSH_PRIVATE_KEY).toBeUndefined();
    expect(env.TLS_KEY).toBeUndefined();
    expect(env.MY_CUSTOM_SECRET).toBeUndefined();
    expect(env.MY_API_TOKEN).toBeUndefined();
  });

  it("correctly identifies sensitive environment keys with isSensitiveEnvKey", () => {
    expect(isSensitiveEnvKey("AUTH_TOKENS")).toBe(true);
    expect(isSensitiveEnvKey("AGENT_DEVICE_ID")).toBe(true);
    expect(isSensitiveEnvKey("AGENT_CREDENTIALS_FILE")).toBe(true);
    expect(isSensitiveEnvKey("SSH_PRIVATE_KEY")).toBe(true);
    expect(isSensitiveEnvKey("MY_SECRET")).toBe(true);
    expect(isSensitiveEnvKey("APP_BEARER_TOKEN")).toBe(true);

    expect(isSensitiveEnvKey("DISPLAY")).toBe(false);
    expect(isSensitiveEnvKey("WAYLAND_DISPLAY")).toBe(false);
    expect(isSensitiveEnvKey("XDG_SESSION_TYPE")).toBe(false);
    expect(isSensitiveEnvKey("DBUS_SESSION_BUS_ADDRESS")).toBe(false);
    expect(isSensitiveEnvKey("PATH")).toBe(false);
    expect(isSensitiveEnvKey("LANG")).toBe(false);
  });

  it("maintains controlled terminal-specific variables (TERM, SHELL, HOME, PWD)", () => {
    const fakeProcessEnv = {
      PATH: "/bin",
      HOME: "/home/tester",
      TERM: "dumb",
      SHELL: "/bin/sh",
    };

    const env = buildPtyEnv("/bin/zsh", "/home/tester/project", fakeProcessEnv);

    expect(env.TERM).toBe("xterm-256color");
    expect(env.SHELL).toBe("/bin/zsh");
    expect(env.HOME).toBe("/home/tester");
    expect(env.PWD).toBe("/home/tester/project");
  });
});

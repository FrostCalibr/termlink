import { describe, it, expect, beforeEach } from "vitest";
import type { ApiClient, ApiDevice, DeviceType, GuiSession } from "../src/api.js";
import { AppController } from "../src/app-controller.js";
import type { TerminalSession, TransportFactory } from "../src/terminal-session.js";
import type { WebTransportEvent } from "../src/transport.js";

const DEVICES: ApiDevice[] = [
  { id: "pc1", name: "PC 1", type: "shell", online: true, latencyMs: null },
];

class FakeTransport {
  sent: string[] = [];
  constructor(
    public path: string,
    public token: string,
    public onEvent: (e: WebTransportEvent) => void,
  ) {}
  simulate(e: WebTransportEvent): void {
    this.onEvent(e);
  }
  sendTerminalInput(): boolean {
    this.sent.push("input");
    return true;
  }
  sendTerminalResize(): boolean {
    this.sent.push("resize");
    return true;
  }
  sendPing(): boolean {
    return true;
  }
  close(): void {
    this.sent.push("close");
  }
  destroy(): void {
    this.sent.push("destroy");
  }
  get isReady(): boolean {
    return false;
  }
  get state(): string {
    return "scripted";
  }
}

interface Script {
  checkSession?: (() => Promise<unknown>) | null;
  sessions?: GuiSession[];
  failCreate?: (deviceId: string) => boolean;
  calls: string[];
}

function stubApi(script: Script): ApiClient {
  const api = {
    token: "web-token",
    checkSession: script.checkSession ?? (async () => ({ name: "alice", method: "password" })),
    loginWithToken: async (t: string) => {
      script.calls.push(`loginToken:${t}`);
      return { name: "alice", method: "password" };
    },
    loginWithPassword: async () => {
      script.calls.push("loginPassword");
      return { name: "alice", method: "password" };
    },
    logout: async () => {
      script.calls.push("logout");
    },
    devices: async () => {
      script.calls.push("devices");
      return DEVICES;
    },
    sessions: async () => {
      script.calls.push("sessions");
      return script.sessions ?? [];
    },
    createSession: async (deviceId: string, type: DeviceType) => {
      script.calls.push(`create:${deviceId}:${type}`);
      if (script.failCreate?.(deviceId)) throw new Error("backend unreachable");
      const session: GuiSession = {
        id: "sess-1",
        deviceId,
        deviceName: DEVICES.find((d) => d.id === deviceId)?.name ?? deviceId,
        type,
        state: "creating",
        createdAt: Date.now(),
        connectedAt: null,
        lastActive: Date.now(),
        closedReason: null,
      };
      return { session, connect: { path: `/ws?device=${deviceId}&type=${type}&session=sess-1` } };
    },
    deleteSession: async (id: string) => {
      script.calls.push(`delete:${id}`);
    },
  };
  return api as unknown as ApiClient;
}

interface Harness {
  controller: AppController;
  api: ApiClient;
  script: Script;
  transports: FakeTransport[];
  states: Array<{ auth: string; sessions: number; active: string | null }>;
}

function makeHarness(opts: { script?: Partial<Script> } = {}): Harness {
  const script: Script = {
    calls: [],
    ...opts.script,
  };
  const api = stubApi(script);
  const transports: FakeTransport[] = [];
  const factory: TransportFactory = ({ path, token, onEvent }) => {
    const t = new FakeTransport(path, token, onEvent);
    transports.push(t);
    return t;
  };
  const controller = new AppController({
    api,
    transportFactory: factory,
    devicePollMs: 0,
  });
  const states: Harness["states"] = [];
  controller.store.subscribe((s) =>
    states.push({ auth: s.auth, sessions: s.sessions.length, active: s.activeSessionId }),
  );
  return { controller, api, script, transports, states };
}

function active(harness: Harness): TerminalSession {
  const state = harness.controller.store.get();
  const found = state.sessions.find((s) => s.id === state.activeSessionId);
  if (!found) throw new Error("no active session");
  return found;
}

describe("AppController", () => {
  beforeEach(() => {});

  it("boots to the login screen when unauthenticated", async () => {
    const h = makeHarness({ script: { checkSession: async () => null } });
    await h.controller.bootstrap();
    expect(h.controller.store.get().auth).toBe("anonymous");
  });

  it("boots authenticated and hydrates open sessions into resumable terminals", async () => {
    const h = makeHarness({
      script: {
        sessions: [
          {
            id: "resume-1",
            deviceId: "pc1",
            deviceName: "PC 1",
            type: "shell" as const,
            state: "connected",
            createdAt: Date.now(),
            connectedAt: Date.now(),
            lastActive: Date.now(),
            closedReason: null,
          },
        ],
      },
    });
    await h.controller.bootstrap();
    const state = h.controller.store.get();
    expect(state.auth).toBe("authenticated");
    expect(state.user).toEqual({ name: "alice", method: "password" });
    expect(state.devices).toEqual(DEVICES);
    expect(state.sessions).toHaveLength(1);
    // Open sessions were resumed (a transport was created for them).
    expect(h.transports.length).toBe(1);
    expect(h.transports[0].path).toContain("session=resume-1");
  });

  it("logs in with a token, loads devices, and exposes an active session", async () => {
    const h = makeHarness();
    expect(await h.controller.loginToken("relaytok")).toBe(true);
    const state = h.controller.store.get();
    expect(state.auth).toBe("authenticated");
    expect(h.script.calls).toContain("devices");
  });

  it("logs in with username and password, loads devices, and sets authenticated state", async () => {
    const h = makeHarness();
    expect(await h.controller.loginPassword("admin", "secret123")).toBe(true);
    const state = h.controller.store.get();
    expect(state.auth).toBe("authenticated");
    expect(h.script.calls).toContain("loginPassword");
    expect(h.script.calls).toContain("devices");
  });

  it("surfaces a password login failure while remaining in anonymous auth state", async () => {
    const api = stubApi({ calls: [], checkSession: async () => null });
    (api as unknown as { loginWithPassword: () => Promise<unknown> }).loginWithPassword = async () => {
      throw new Error("Invalid username or password");
    };
    const transports: FakeTransport[] = [];
    const controller = new AppController({
      api,
      transportFactory: makeFactory(transports),
      devicePollMs: 0,
    });
    await controller.bootstrap();
    expect(await controller.loginPassword("admin", "wrong")).toBe(false);
    const state = controller.store.get();
    expect(state.auth).toBe("anonymous");
    expect(state.autoError).toContain("Invalid username or password");
  });

  it("surfaces a login failure without leaving the app booted", async () => {
    const api = stubApi({ calls: [], checkSession: async () => null });
    (api as unknown as { loginWithToken: (t: string) => Promise<unknown> }).loginWithToken = async () => {
      throw new Error("Invalid token");
    };
    const transports: FakeTransport[] = [];
    const controller = new AppController({
      api,
      transportFactory: makeFactory(transports),
      devicePollMs: 0,
    });
    await controller.bootstrap();
    expect(await controller.loginToken("bad")).toBe(false);
    const state = controller.store.get();
    expect(state.auth).toBe("anonymous");
    expect(state.autoError).toContain("Invalid token");
  });

  it("creates a session against the requested device and activates it", async () => {
    const h = makeHarness();
    await h.controller.bootstrap();
    await h.controller.createSession("pc1");
    const state = h.controller.store.get();
    expect(state.sessions).toHaveLength(1);
    expect(state.activeSessionId).toBe("sess-1");
    expect(h.script.calls).toContain("create:pc1:shell");
    expect(h.transports).toHaveLength(1);
    expect(h.transports[0].token).toBe("web-token");
  });

  it("keeps a failed session out of the list and reports the backend error", async () => {
    const h = makeHarness({ script: { failCreate: () => true } });
    await h.controller.bootstrap();
    await h.controller.createSession("pc1");
    const state = h.controller.store.get();
    expect(state.sessions).toHaveLength(0);
    expect(state.autoError).toContain("backend unreachable");
  });

  it("closes a session via the API and switches to another tab", async () => {
    const h = makeHarness({
      script: {
        sessions: [
          {
            id: "a",
            deviceId: "pc1",
            deviceName: "PC 1",
            type: "shell" as const,
            state: "disconnected",
            createdAt: Date.now(),
            connectedAt: null,
            lastActive: Date.now(),
            closedReason: null,
          },
          {
            id: "b",
            deviceId: "pc1",
            deviceName: "PC 1",
            type: "shell" as const,
            state: "disconnected",
            createdAt: Date.now(),
            connectedAt: null,
            lastActive: Date.now(),
            closedReason: null,
          },
        ],
      },
    });
    await h.controller.bootstrap();
    h.controller.setActive("a");
    await h.controller.closeSession("a");
    const state = h.controller.store.get();
    expect(state.sessions.map((s) => s.id)).toEqual(["b"]);
    expect(state.activeSessionId).toBe("b");
    expect(h.script.calls).toContain("delete:a");
    expect(h.transports).toHaveLength(2); // both hydrated, then a was closed
  });

  it("logout signs out everywhere and clears session state", async () => {
    const h = makeHarness();
    await h.controller.bootstrap();
    await h.controller.createSession("pc1");
    await h.controller.logout();
    const state = h.controller.store.get();
    expect(state.auth).toBe("anonymous");
    expect(state.sessions).toHaveLength(0);
    expect(state.devices).toHaveLength(0);
    expect(h.script.calls).toContain("logout");
  });

  it("auto-selects activeSessionId on hydration and attaches transport when selecting a disconnected session", async () => {
    const h = makeHarness({
      script: {
        sessions: [
          {
            id: "disc-1",
            deviceId: "pc1",
            deviceName: "PC 1",
            type: "shell" as const,
            state: "disconnected",
            createdAt: Date.now(),
            connectedAt: null,
            lastActive: Date.now(),
            closedReason: null,
          },
        ],
      },
    });
    await h.controller.bootstrap();
    const state = h.controller.store.get();
    expect(state.activeSessionId).toBe("disc-1");

    // Clear transport list and simulate session being disconnected
    h.transports.length = 0;
    const session = state.sessions[0];
    session.state = "disconnected";

    // Selecting a disconnected session opens its transport
    h.controller.setActive("disc-1");
    expect(h.transports.length).toBe(1);
    expect(h.transports[0].path).toContain("session=disc-1");
  });

  it("reconnect re-attaches a new transport to the same session id", async () => {
    const h = makeHarness({
      script: {
        sessions: [
          {
            id: "resume-1",
            deviceId: "pc1",
            deviceName: "PC 1",
            type: "shell" as const,
            state: "connected",
            createdAt: Date.now(),
            connectedAt: Date.now(),
            lastActive: Date.now(),
            closedReason: null,
          },
        ],
      },
    });
    await h.controller.bootstrap();
    expect(h.transports.length).toBe(1);
    h.transports[0].simulate({ type: "ready", sessionId: "resume-1" });
    h.transports[0].simulate({ type: "closed", reason: "drop" });
    await h.controller.reconnectSession("resume-1");
    expect(h.transports.length).toBe(2);
    expect(h.transports[1].path).toContain("session=resume-1");
  });
});

function makeFactory(transports: FakeTransport[]): TransportFactory {
  return ({ path, token, onEvent }) => {
    const t = new FakeTransport(path, token, onEvent);
    transports.push(t);
    return t;
  };
}
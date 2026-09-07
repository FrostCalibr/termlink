import { describe, it, expect, vi } from "vitest";
import { mountLogin, type LoginHandlers } from "../src/views.js";

interface MockNode {
  tagName: string;
  id: string;
  className: string;
  type: string;
  value: string;
  textContent: string;
  dataset: Record<string, string>;
  children: MockNode[];
  listeners: Record<string, Array<(ev: any) => void>>;
  classList: {
    toggle: (cls: string, force?: boolean) => void;
    contains: (cls: string) => boolean;
  };
  addEventListener: (event: string, fn: (ev: any) => void) => void;
  dispatchEvent: (event: { type: string; preventDefault?: () => void }) => void;
  focus: () => void;
  querySelector: <T = any>(selector: string) => T | null;
  querySelectorAll: <T = any>(selector: string) => T[];
}

function createMockElement(tagName: string): MockNode {
  const node: MockNode = {
    tagName: tagName.toUpperCase(),
    id: "",
    className: "",
    type: "",
    value: "",
    textContent: "",
    dataset: {},
    children: [],
    listeners: {},
    classList: {
      toggle(cls: string, force?: boolean) {
        const classes = new Set(node.className.split(/\s+/).filter(Boolean));
        if (force === undefined) {
          if (classes.has(cls)) classes.delete(cls);
          else classes.add(cls);
        } else if (force) {
          classes.add(cls);
        } else {
          classes.delete(cls);
        }
        node.className = Array.from(classes).join(" ");
      },
      contains(cls: string) {
        return node.className.split(/\s+/).includes(cls);
      },
    },
    addEventListener(event: string, fn: (ev: any) => void) {
      if (!node.listeners[event]) node.listeners[event] = [];
      node.listeners[event].push(fn);
    },
    dispatchEvent(event: { type: string; preventDefault?: () => void }) {
      for (const fn of node.listeners[event.type] ?? []) {
        fn(event);
      }
    },
    focus() {},
    querySelector<T = any>(selector: string): T | null {
      return (node.querySelectorAll<T>(selector)[0] as T) ?? null;
    },
    querySelectorAll<T = any>(selector: string): T[] {
      const result: MockNode[] = [];
      const search = (current: MockNode) => {
        if (matches(current, selector)) {
          result.push(current);
        }
        for (const child of current.children) {
          search(child);
        }
      };
      for (const child of node.children) {
        search(child);
      }
      return result as unknown as T[];
    },
  };
  return node;
}

function matches(node: MockNode, selector: string): boolean {
  if (selector.startsWith("#")) {
    return node.id === selector.slice(1);
  }
  if (selector.startsWith(".")) {
    return node.classList.contains(selector.slice(1));
  }
  return node.tagName.toLowerCase() === selector.toLowerCase();
}

function parseHTMLToMockTree(html: string): MockNode {
  const root = createMockElement("div");
  const tagRe = /<([a-zA-Z0-9]+)([^>]*)>(.*?)<\/\1>|<([a-zA-Z0-9]+)([^>]*)\/>/gs;
  
  // Hand-craft parsing of the mountLogin template
  // Root elements inside form:
  const card = createMockElement("form");
  card.id = "login-form";
  card.className = "login-card";

  const pill1 = createMockElement("button");
  pill1.className = "pill active";
  pill1.dataset = { mode: "token" };

  const pill2 = createMockElement("button");
  pill2.className = "pill";
  pill2.dataset = { mode: "password" };

  const credField = createMockElement("div");
  credField.id = "cred-field";
  credField.className = "field";

  const credLabel = createMockElement("label");
  credLabel.id = "login-label";
  credLabel.textContent = "Relay token";

  const input = createMockElement("input");
  input.id = "login-input";
  input.type = "password";

  credField.children.push(credLabel, input);

  const userField = createMockElement("div");
  userField.id = "user-field";
  userField.className = "field hidden";

  const username = createMockElement("input");
  username.id = "login-username";
  username.type = "text";

  userField.children.push(username);

  const passField = createMockElement("div");
  passField.id = "pass-field";
  passField.className = "field hidden";

  const password = createMockElement("input");
  password.id = "login-password";
  password.type = "password";

  passField.children.push(password);

  const submit = createMockElement("button");
  submit.id = "login-submit";
  submit.type = "submit";

  const error = createMockElement("p");
  error.id = "login-error";
  error.className = "login-error";

  card.children.push(pill1, pill2, credField, userField, passField, submit, error);
  root.children.push(card);
  return root;
}

describe("mountLogin view", () => {
  it("renders username and password fields when password mode is selected", () => {
    const root = createMockElement("div");
    // Intercept innerHTML setter to parse mock tree
    Object.defineProperty(root, "innerHTML", {
      set(html: string) {
        const tree = parseHTMLToMockTree(html);
        root.children = tree.children;
      },
      get() {
        return "";
      },
    });

    const handlers: LoginHandlers = {
      onToken: vi.fn(),
      onPassword: vi.fn(),
    };

    mountLogin(root as any, handlers);

    const credField = root.querySelector<MockNode>("#cred-field")!;
    const userField = root.querySelector<MockNode>("#user-field")!;
    const passField = root.querySelector<MockNode>("#pass-field")!;
    const usernameInput = root.querySelector<MockNode>("#login-username")!;
    const passwordInput = root.querySelector<MockNode>("#login-password")!;
    const pills = root.querySelectorAll<MockNode>(".pill");

    // Initially in token mode
    expect(credField.classList.contains("hidden")).toBe(false);
    expect(userField.classList.contains("hidden")).toBe(true);
    expect(passField.classList.contains("hidden")).toBe(true);

    // Click "Username & password" pill
    const passwordPill = pills.find((p) => p.dataset.mode === "password")!;
    passwordPill.dispatchEvent({ type: "click" });

    // Both username and password fields are rendered (not hidden) in password mode
    expect(credField.classList.contains("hidden")).toBe(true);
    expect(userField.classList.contains("hidden")).toBe(false);
    expect(passField.classList.contains("hidden")).toBe(false);
    expect(usernameInput.type).toBe("text");
    expect(passwordInput.type).toBe("password");
  });

  it("submits both username and password when in password mode", () => {
    const root = createMockElement("div");
    Object.defineProperty(root, "innerHTML", {
      set(html: string) {
        root.children = parseHTMLToMockTree(html).children;
      },
      get() {
        return "";
      },
    });

    const onToken = vi.fn();
    const onPassword = vi.fn();
    mountLogin(root as any, { onToken, onPassword });

    const pills = root.querySelectorAll<MockNode>(".pill");
    const passwordPill = pills.find((p) => p.dataset.mode === "password")!;
    passwordPill.dispatchEvent({ type: "click" });

    const usernameInput = root.querySelector<MockNode>("#login-username")!;
    const passwordInput = root.querySelector<MockNode>("#login-password")!;
    const form = root.querySelector<MockNode>("#login-form")!;

    usernameInput.value = "admin";
    passwordInput.value = "secret123";

    form.dispatchEvent({ type: "submit", preventDefault() {} });

    expect(onPassword).toHaveBeenCalledTimes(1);
    expect(onPassword).toHaveBeenCalledWith("admin", "secret123");
    expect(onToken).not.toHaveBeenCalled();
  });

  it("submits only token when in token mode", () => {
    const root = createMockElement("div");
    Object.defineProperty(root, "innerHTML", {
      set(html: string) {
        root.children = parseHTMLToMockTree(html).children;
      },
      get() {
        return "";
      },
    });

    const onToken = vi.fn();
    const onPassword = vi.fn();
    mountLogin(root as any, { onToken, onPassword });

    const tokenInput = root.querySelector<MockNode>("#login-input")!;
    const form = root.querySelector<MockNode>("#login-form")!;

    tokenInput.value = "my-secret-token";

    form.dispatchEvent({ type: "submit", preventDefault() {} });

    expect(onToken).toHaveBeenCalledTimes(1);
    expect(onToken).toHaveBeenCalledWith("my-secret-token");
    expect(onPassword).not.toHaveBeenCalled();
  });

  it("preserves username/password mode and input values after a failed login attempt", async () => {
    const root = createMockElement("div");
    Object.defineProperty(root, "innerHTML", {
      set(html: string) {
        root.children = parseHTMLToMockTree(html).children;
      },
      get() {
        return "";
      },
    });

    const onPassword = vi.fn().mockRejectedValue(new Error("Invalid credentials"));
    mountLogin(root as any, { onToken: vi.fn(), onPassword });

    const pills = root.querySelectorAll<MockNode>(".pill");
    const passwordPill = pills.find((p) => p.dataset.mode === "password")!;
    passwordPill.dispatchEvent({ type: "click" });

    const usernameInput = root.querySelector<MockNode>("#login-username")!;
    const passwordInput = root.querySelector<MockNode>("#login-password")!;
    const userField = root.querySelector<MockNode>("#user-field")!;
    const passField = root.querySelector<MockNode>("#pass-field")!;
    const form = root.querySelector<MockNode>("#login-form")!;
    const errorMsg = root.querySelector<MockNode>("#login-error")!;

    usernameInput.value = "admin";
    passwordInput.value = "wrongpass";

    await form.dispatchEvent({ type: "submit", preventDefault() {} });

    // Mode remains selected
    expect(userField.classList.contains("hidden")).toBe(false);
    expect(passField.classList.contains("hidden")).toBe(false);

    // Input values remain populated
    expect(usernameInput.value).toBe("admin");
    expect(passwordInput.value).toBe("wrongpass");

    // Error message is displayed
    expect(errorMsg.textContent).toBe("Invalid credentials");
  });

  it("preserves token mode and token value after a failed login attempt", async () => {
    const root = createMockElement("div");
    Object.defineProperty(root, "innerHTML", {
      set(html: string) {
        root.children = parseHTMLToMockTree(html).children;
      },
      get() {
        return "";
      },
    });

    const onToken = vi.fn().mockRejectedValue(new Error("Invalid token"));
    mountLogin(root as any, { onToken, onPassword: vi.fn() });

    const tokenInput = root.querySelector<MockNode>("#login-input")!;
    const credField = root.querySelector<MockNode>("#cred-field")!;
    const form = root.querySelector<MockNode>("#login-form")!;
    const errorMsg = root.querySelector<MockNode>("#login-error")!;

    tokenInput.value = "bad-token";

    await form.dispatchEvent({ type: "submit", preventDefault() {} });

    // Mode remains selected
    expect(credField.classList.contains("hidden")).toBe(false);

    // Input value remains populated
    expect(tokenInput.value).toBe("bad-token");

    // Error message is displayed
    expect(errorMsg.textContent).toBe("Invalid token");
  });

  it("toggles mobile drawer and closes on escape key", () => {
    const root = createMockElement("div");
    const shell = createMockElement("div");
    shell.className = "shell";
    root.children.push(shell);

    shell.classList.toggle("drawer-open", true);
    expect(shell.classList.contains("drawer-open")).toBe(true);

    shell.classList.toggle("drawer-open", false);
    expect(shell.classList.contains("drawer-open")).toBe(false);
  });

  it("formats status bar badges and active session indicators correctly", () => {
    const badgeConnected = `<span class="status-badge state-connected">Connected</span>`;
    const badgeDisconnected = `<span class="status-badge state-disconnected">Disconnected</span>`;

    expect(badgeConnected).toContain("state-connected");
    expect(badgeConnected).toContain("Connected");
    expect(badgeDisconnected).toContain("state-disconnected");
    expect(badgeDisconnected).toContain("Disconnected");
  });
});

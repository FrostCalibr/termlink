/**
 * DOM views for the Phase 8 GUI: login screen and the application shell.
 *
 * Views stay thin: all state lives in {@link AppController} / {@link TerminalSession}
 * models and is rendered here. There is no routing library; the login screen
 * and shell are toggled by the controller's `auth` phase.
 */

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { AppController, AppState } from "./app-controller.js";
import type { ApiDevice as AppDevice } from "./api.js";
import { ThemeManager } from "./theme.js";
import type { TerminalSession } from "./terminal-session.js";

// ── Login view ───────────────────────────────────────────────────────────────

export interface LoginHandlers {
  onToken: (token: string) => Promise<boolean | void> | void;
  onPassword: (username: string, password: string) => Promise<boolean | void> | void;
}

export function mountLogin(
  root: HTMLElement,
  handlers: LoginHandlers,
  controller?: AppController,
): void {
  root.innerHTML = `
    <div class="login-screen">
      <form class="login-card" id="login-form">
        <h1>Remote Console</h1>
        <p class="login-subtitle">termlink terminal web client</p>
        <div class="login-pills" id="login-pills" role="tablist">
          <button type="button" class="pill active" data-mode="token">Token</button>
          <button type="button" class="pill" data-mode="password">Username &amp; password</button>
        </div>
        <div class="field" id="cred-field">
          <label for="login-input" id="login-label">Relay token</label>
          <input id="login-input" type="password" autocomplete="off" spellcheck="false" />
        </div>
        <div class="field hidden" id="user-field">
          <label for="login-username">Username</label>
          <input id="login-username" type="text" autocomplete="username" spellcheck="false" />
        </div>
        <div class="field hidden" id="pass-field">
          <label for="login-password">Password</label>
          <input id="login-password" type="password" autocomplete="current-password" spellcheck="false" />
        </div>
        <button type="submit" class="btn-primary" id="login-submit">Sign in</button>
        <p class="login-error" id="login-error" role="alert"></p>
      </form>
    </div>
  `;

  const form = root.querySelector<HTMLFormElement>("#login-form")!;
  const input = root.querySelector<HTMLInputElement>("#login-input")!;
  const username = root.querySelector<HTMLInputElement>("#login-username")!;
  const password = root.querySelector<HTMLInputElement>("#login-password")!;
  const credField = root.querySelector<HTMLElement>("#cred-field")!;
  const userField = root.querySelector<HTMLElement>("#user-field")!;
  const passField = root.querySelector<HTMLElement>("#pass-field")!;
  const label = root.querySelector<HTMLLabelElement>("#login-label")!;
  const error = root.querySelector<HTMLElement>("#login-error")!;
  const pills = root.querySelectorAll<HTMLButtonElement>(".pill");

  let mode: "token" | "password" = "token";

  if (controller) {
    if (controller.store.get().autoError) {
      showError(error, controller.store.get().autoError!);
    }
    controller.store.subscribe((state) => {
      if (state.autoError && state.auth === "anonymous") {
        showError(error, state.autoError);
      }
    });
  }

  for (const pill of pills) {
    pill.addEventListener("click", () => {
      mode = pill.dataset.mode as "token" | "password";
      for (const p of pills) p.classList.toggle("active", p === pill);
      credField.classList.toggle("hidden", mode === "password");
      userField.classList.toggle("hidden", mode !== "password");
      passField.classList.toggle("hidden", mode !== "password");
      label.textContent = "Relay token";
      input.value = "";
      username.value = "";
      password.value = "";
      error.textContent = "";
      controller?.clearAutoError();
      if (mode === "token") {
        input.focus();
      } else {
        username.focus();
      }
    });
  }

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    error.textContent = "";
    controller?.clearAutoError();
    if (mode === "token") {
      const token = input.value.trim();
      if (!token) return showError(error, "Enter a token");
      try {
        await handlers.onToken(token);
        const err = controller?.store.get().autoError;
        if (err) showError(error, err);
      } catch (err) {
        showError(error, err instanceof Error ? err.message : String(err));
      }
    } else {
      const user = username.value.trim();
      const pass = password.value;
      if (!user || !pass) return showError(error, "Enter username and password");
      try {
        await handlers.onPassword(user, pass);
        const err = controller?.store.get().autoError;
        if (err) showError(error, err);
      } catch (err) {
        showError(error, err instanceof Error ? err.message : String(err));
      }
    }
  });

  input.focus();
}

function showError(el: HTMLElement, message: string): void {
  el.textContent = message;
}

// ── Application shell view ───────────────────────────────────────────────────

interface TerminalWidget {
  element: HTMLElement;
  term: Terminal;
  fit: FitAddon;
  bound: boolean;
}

export interface ShellViewOptions {
  controller: AppController;
  theme: ThemeManager;
  onThemeCycle: () => void;
  onOpenNewSession: () => void;
}

export class ShellView {
  private root: HTMLElement;
  private controller: AppController;
  private theme: ThemeManager;
  private onThemeCycle: () => void;
  private onOpenNewSession: () => void;
  private terminals = new Map<string, TerminalWidget>();
  private unsubscribe: Array<() => void> = [];
  private resizeObserver: ResizeObserver | null = null;

  private onWindowResize = (): void => {
    this.fitAll();
  };

  private onWindowKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape") {
      this.closeModals();
      this.closeDrawer();
    }
  };

  constructor(root: HTMLElement, options: ShellViewOptions) {
    this.root = root;
    this.controller = options.controller;
    this.theme = options.theme;
    this.onThemeCycle = options.onThemeCycle;
    this.onOpenNewSession = options.onOpenNewSession;
    this.render();
    this.bind();
    this.setupResizeObserver();
  }

  destroy(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    window.removeEventListener("resize", this.onWindowResize);
    window.removeEventListener("orientationchange", this.onWindowResize);
    window.removeEventListener("keydown", this.onWindowKeyDown);
    for (const un of this.unsubscribe.splice(0)) un();
    for (const w of this.terminals.values()) {
      w.term.dispose();
      w.element.remove();
    }
    this.terminals.clear();
    this.root.innerHTML = "";
  }

  private render(): void {
    this.root.innerHTML = `
      <div class="shell">
        <aside class="sidebar" id="sidebar">
          <div class="sidebar-header">
            <span class="brand">PTY<span class="brand-accent">llm</span></span>
            <div class="sidebar-actions">
              <button class="icon-btn" id="theme-btn" title="Toggle theme" aria-label="Toggle theme">◐</button>
              <button class="icon-btn drawer-close" id="drawer-close" title="Close menu" aria-label="Close menu">×</button>
            </div>
          </div>
          <section class="pane devices-pane">
            <div class="pane-title">Devices</div>
            <button class="new-session-btn" id="new-session-btn" type="button">＋ New session</button>
            <ul class="device-list" id="device-list"></ul>
          </section>
          <section class="pane sessions-pane">
            <div class="pane-title">Sessions</div>
            <ul class="session-list" id="session-list"></ul>
          </section>
          <div class="sidebar-footer">
            <span class="user-chip" id="user-chip"></span>
            <button class="ghost-btn" id="logout-btn" type="button">Sign out</button>
          </div>
        </aside>
        <div class="drawer-scrim" id="drawer-scrim"></div>
        <main class="workspace">
          <div class="app-alert hidden" id="app-alert" role="alert">
            <span id="app-alert-text"></span>
            <button class="alert-dismiss" id="app-alert-dismiss" aria-label="Dismiss">×</button>
          </div>
          <nav class="tab-bar" id="tab-bar" aria-label="Terminal tabs"></nav>
          <section class="terminal-work" id="terminal-work"></section>
          <footer class="status-bar">
            <span class="status-item" id="status-session"></span>
            <span class="status-item" id="status-latency"></span>
            <span class="status-item status-spacer"></span>
            <span class="status-item" id="status-auth"></span>
          </footer>
        </main>
        <div class="modal-scrim hidden" id="new-session-modal">
          <div class="modal">
            <h2>Open a new session</h2>
            <p class="modal-hint">Pick a device to connect to. The relay resolves the backend.</p>
            <ul class="modal-device-list" id="modal-device-list"></ul>
            <button class="ghost-btn" id="modal-cancel" type="button">Cancel</button>
          </div>
        </div>
        <div class="modal-scrim hidden" id="settings-modal">
          <div class="modal">
            <h2>Settings</h2>
            <label for="theme-select">Appearance</label>
            <select id="theme-select" class="select">
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
            <p class="modal-hint">Terminal appearance follows the app theme.</p>
            <button class="primary-close" id="settings-close" type="button">Close</button>
          </div>
        </div>
      </div>
    `;
  }

  private bind(): void {
    const root = this.root;
    root.querySelector("#drawer-scrim")!.addEventListener("click", () => this.closeDrawer());
    root.querySelector("#drawer-close")!.addEventListener("click", () => this.closeDrawer());
    root.querySelector("#new-session-btn")!.addEventListener("click", () => this.openNewSessionModal());
    root.querySelector("#modal-cancel")!.addEventListener("click", () => this.closeModals());
    root.querySelector("#settings-close")!.addEventListener("click", () => this.closeModals());
    root.querySelector("#app-alert-dismiss")!.addEventListener("click", () =>
      this.controller.clearAutoError(),
    );
    root.querySelector("#theme-btn")!.addEventListener("click", () => this.onThemeCycle());
    root.querySelector("#theme-select")!.addEventListener("change", (ev) => {
      const select = ev.target as HTMLSelectElement;
      this.theme.setPreference(select.value as "system" | "light" | "dark");
    });
    root.querySelector("#logout-btn")!.addEventListener("click", () => {
      void this.controller.logout();
    });
    root.querySelector("#tab-bar")!.addEventListener("click", (ev) => {
      const toggleBtn = (ev.target as HTMLElement).closest("#drawer-toggle");
      if (toggleBtn) {
        this.openDrawer();
        return;
      }
      const closeBtn = (ev.target as HTMLElement).closest(".tab-close");
      const tab = (ev.target as HTMLElement).closest<HTMLElement>("[data-session-id]");
      if (!tab) return;
      const id = tab.dataset.sessionId!;
      if (closeBtn) {
        void this.controller.closeSession(id);
        return;
      }
      this.controller.setActive(id);
    });
    root.querySelector("#device-list")!.addEventListener("click", (ev) => {
      const item = (ev.target as HTMLElement).closest<HTMLElement>("[data-device-id]");
      if (!item) return;
      void this.controller.createSession(item.dataset.deviceId!);
    });
    root.querySelector("#modal-device-list")!.addEventListener("click", (ev) => {
      const item = (ev.target as HTMLElement).closest<HTMLElement>("[data-device-id]");
      if (!item) return;
      this.closeModals();
      void this.controller.createSession(item.dataset.deviceId!);
    });
    root.querySelector("#session-list")!.addEventListener("click", (ev) => {
      const item = (ev.target as HTMLElement).closest<HTMLElement>("[data-session-id]");
      if (!item) return;
      const id = item.dataset.sessionId!;
      this.controller.setActive(id);
    });
    this.unsubscribe.push(this.controller.store.subscribe(() => this.renderFromState()));
    window.addEventListener("resize", this.onWindowResize);
    window.addEventListener("orientationchange", this.onWindowResize);
    window.addEventListener("keydown", this.onWindowKeyDown);
  }

  private setupResizeObserver(): void {
    const work = this.root.querySelector<HTMLElement>("#terminal-work");
    if (work && typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => {
        this.fitAll();
      });
      this.resizeObserver.observe(work);
    }
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  private renderFromState(): void {
    const state = this.controller.store.get();
    this.renderDevices(state.devices);
    this.renderSessions(state.sessions, state.activeSessionId);
    this.renderTabs(state.sessions, state.activeSessionId);
    this.renderActiveTerminal(state.sessions, state.activeSessionId);
    this.renderStatusBar(state);
    this.renderModals(state);
    this.renderAuth(state);
    this.renderAlert(state);
  }

  private renderAlert(state: AppState): void {
    const alert = this.root.querySelector<HTMLElement>("#app-alert")!;
    const text = this.root.querySelector<HTMLElement>("#app-alert-text")!;
    alert.classList.toggle("hidden", !state.autoError);
    text.textContent = state.autoError ?? "";
  }

  private renderDevices(devices: AppDevice[]): void {
    const list = this.root.querySelector<HTMLElement>("#device-list")!;
    if (devices.length === 0) {
      list.innerHTML = `<li class="empty">No devices configured</li>`;
      return;
    }
    list.innerHTML = devices
      .map(
        (d) => `
        <li class="device-item" data-device-id="${escapeAttr(d.id)}" title="${escapeAttr(d.name)} (${d.type})">
          <span class="status-dot ${d.online ? "online" : "offline"}" aria-hidden="true"></span>
          <span class="device-name">${getDeviceIcon(d)}${escapeHtml(d.name)}</span>
          <span class="type-badge" data-type="${d.type}">${d.type}</span>
        </li>`,
      )
      .join("");
  }

  private renderSessions(sessions: TerminalSession[], activeId: string | null): void {
    const list = this.root.querySelector<HTMLElement>("#session-list")!;
    if (sessions.length === 0) {
      list.innerHTML = `<li class="empty">No sessions yet</li>`;
      return;
    }
    list.innerHTML = sessions
      .map(
        (s) => `
        <li class="session-item ${s.id === activeId ? "active" : ""}" data-session-id="${escapeAttr(s.id)}" title="${escapeAttr(s.deviceName)} — ${s.state}">
          <span class="status-dot ${s.state === "connected" ? "online" : s.available ? "offline" : "closed"}" aria-hidden="true"></span>
          <span class="session-name">${escapeHtml(s.deviceName)}</span>
          <span class="type-badge" data-type="${s.type}">${s.type}</span>
        </li>`,
      )
      .join("");
  }

  private renderTabs(sessions: TerminalSession[], activeId: string | null): void {
    const bar = this.root.querySelector<HTMLElement>("#tab-bar")!;
    const drawerBtn = `<button class="icon-btn drawer-toggle" id="drawer-toggle" title="Open navigation" aria-label="Open navigation">☰</button>`;
    if (sessions.length === 0) {
      bar.innerHTML = `${drawerBtn}<div class="tab-empty">No sessions</div>`;
      return;
    }
    const tabsHtml = sessions
      .map((s) => {
        const stateClass =
          s.state === "connected"
            ? "tab-connected"
            : s.state === "disconnected"
              ? "tab-disconnected"
              : "tab-busy";
        return `
        <button class="tab ${s.id === activeId ? "active" : ""} ${stateClass}" data-session-id="${escapeAttr(s.id)}" role="tab">
          <span class="tab-spinner" aria-hidden="true"></span>
          <span class="tab-label">${escapeHtml(s.deviceName)}</span>
          <span class="tab-close" title="Close session" aria-label="Close session">×</span>
        </button>`;
      })
      .join("");
    bar.innerHTML = `${drawerBtn}${tabsHtml}`;
    this.bindSessionEvents(sessions);
  }

  private renderActiveTerminal(sessions: TerminalSession[], activeId: string | null): void {
    const work = this.root.querySelector<HTMLElement>("#terminal-work")!;
    const active = sessions.find((s) => s.id === activeId);
    if (!active) {
      work.innerHTML = `
        <div class="empty-state">
          <p class="empty-title">No active terminal</p>
          <p class="empty-sub">Choose a device, or press <b>＋ New session</b>.</p>
        </div>`;
      for (const [, w] of this.terminals) {
        w.element.remove();
      }
      return;
    }

    const widget = this.ensureWidget(active, work);
    if (widget.element.parentElement !== work) {
      for (const [id, w] of this.terminals) {
        if (id !== activeId && w.element.parentElement === work) {
          work.removeChild(w.element);
        }
      }
      const emptyState = work.querySelector(".empty-state");
      if (emptyState) {
        emptyState.remove();
      }
      work.appendChild(widget.element);
    }

    try {
      widget.fit.fit();
      if (widget.term.cols > 0 && widget.term.rows > 0) {
        active.resize(widget.term.cols, widget.term.rows);
      }
    } catch {
      /* ignore fit error if element not yet visible */
    }
    this.bindSessionEvents(sessions);
  }

  private ensureWidget(session: TerminalSession, container: HTMLElement): TerminalWidget {
    let widget = this.terminals.get(session.id);
    if (!widget) {
      const element = document.createElement("div");
      element.className = "terminal-holder";
      container.appendChild(element);

      const term = new Terminal({
        cursorBlink: true,
        convertEol: true,
        allowProposedApi: false,
        fontFamily:
          "'JetBrainsMono Nerd Font', 'JetBrains Mono NF', 'JetBrains Mono', 'Fira Code', Menlo, Consolas, monospace",
        fontSize: 13,
        scrollback: 4000,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.attachCustomKeyEventHandler((ev) => handleCustomKey(ev, term, session));
      widget = { element, term, fit, bound: true };
      this.terminals.set(session.id, widget);
      term.open(element);
      try {
        fit.fit();
        if (term.cols > 0 && term.rows > 0) {
          session.resize(term.cols, term.rows);
        }
      } catch {
        /* ignore initial fit if container layout is pending */
      }
      this.fitLater(fit);
      term.write(`\r\n\x1b[90m— ${session.deviceName} (${session.type}) —\x1b[0m\r\n`);
      session.events.on("output", (payload) => {
        const w = this.terminals.get(session.id);
        if (!w) return;
        if (payload.bytes.byteLength > 0) w.term.write(payload.bytes);
        else if (payload.text) w.term.write(payload.text);
      });
      term.onData((chunk) => session.sendInput(encodeUTF8(chunk)));
      term.onResize(() => {
        fit.fit();
        session.resize(term.cols, term.rows);
      });
    }
    return widget;
  }

  private fitAll(): void {
    const work = this.root.querySelector<HTMLElement>("#terminal-work");
    if (work && (work.clientWidth === 0 || work.clientHeight === 0)) {
      return;
    }
    for (const w of this.terminals.values()) {
      try {
        w.fit.fit();
      } catch {
        /* terminal not visible */
      }
    }
    const state = this.controller.store.get();
    const active = state.sessions.find((s) => s.id === state.activeSessionId);
    if (active && this.terminals.has(active.id)) {
      const widget = this.terminals.get(active.id)!;
      if (widget.term.cols > 0 && widget.term.rows > 0) {
        active.resize(widget.term.cols, widget.term.rows);
      }
    }
  }

  private fitLater(fit: FitAddon): void {
    requestAnimationFrame(() => {
      if (this.root.isConnected) {
        try {
          fit.fit();
        } catch {
          /* ignore */
        }
      }
    });
  }

  private bindSessionEvents(sessions: TerminalSession[]): void {
    for (const session of sessions) {
      if (this.boundSessionIds.has(session.id)) continue;
      this.boundSessionIds.add(session.id);
      const unbindLatency = session.events.on("latency", () => {
        this.renderStatusBar(this.controller.store.get());
      });
      const unbindState = session.events.on("state", () => {
        if (session.state === "closed" || !session.available) {
          this.disposeWidget(session.id);
          unbindLatency();
          unbindState();
          this.boundSessionIds.delete(session.id);
        }
        const cur = this.controller.store.get();
        this.renderTabs(cur.sessions, cur.activeSessionId);
        this.renderSessions(cur.sessions, cur.activeSessionId);
        this.renderStatusBar(cur);
        this.renderActiveTerminal(cur.sessions, cur.activeSessionId);
      });
    }
  }

  private boundSessionIds = new Set<string>();

  private disposeWidget(sessionId: string): void {
    const widget = this.terminals.get(sessionId);
    if (widget) {
      widget.term.dispose();
      widget.element.remove();
      this.terminals.delete(sessionId);
    }
  }

  private renderStatusBar(state: AppState): void {
    const active = state.sessions.find((s) => s.id === state.activeSessionId);
    const sessionEl = this.root.querySelector<HTMLElement>("#status-session")!;
    const latencyEl = this.root.querySelector<HTMLElement>("#status-latency")!;
    const authEl = this.root.querySelector<HTMLElement>("#status-auth")!;
    if (!active) {
      sessionEl.innerHTML = `<span class="status-badge state-none">No active session</span>`;
      latencyEl.textContent = "";
      latencyEl.className = "status-item";
    } else {
      const stateBadge = `<span class="status-badge state-${active.state}">${capitalize(active.state)}</span>`;
      sessionEl.innerHTML = `${stateBadge} <span class="status-text">${escapeHtml(active.deviceName)} · ${active.type}${active.reason ? " — " + escapeHtml(active.reason) : ""}</span>`;
      latencyEl.textContent = active.latencyMs !== null ? `${active.latencyMs} ms RTT` : "";
      latencyEl.className = "status-item";
    }
    authEl.textContent = state.user ? `● ${state.user.name}` : "";
  }

  private renderModals(state: AppState): void {
    const modalList = this.root.querySelector<HTMLElement>("#modal-device-list")!;
    if (modalList.childElementCount === 0) {
      modalList.innerHTML = state.devices
        .map(
          (d) => `
          <li class="modal-device-item" data-device-id="${escapeAttr(d.id)}">
            <span class="status-dot ${d.online ? "online" : "offline"}" aria-hidden="true"></span>
            <span class="device-name">${getDeviceIcon(d)}${escapeHtml(d.name)}</span>
            <span class="type-badge" data-type="${d.type}">${d.type}</span>
            <button class="ghost-btn" type="button">Connect</button>
          </li>`,
        )
        .join("");
    }
    const select = this.root.querySelector<HTMLSelectElement>("#theme-select")!;
    select.value = this.theme.preference;
  }

  private renderAuth(state: AppState): void {
    const chip = this.root.querySelector<HTMLElement>("#user-chip")!;
    chip.textContent = state.user ? `● ${state.user.name}` : "";
  }

  openNewSessionModal(): void {
    this.root.querySelector<HTMLElement>("#new-session-modal")!.classList.remove("hidden");
  }

  closeModals(): void {
    this.root.querySelector<HTMLElement>("#new-session-modal")!.classList.add("hidden");
    this.root.querySelector<HTMLElement>("#settings-modal")!.classList.add("hidden");
  }

  openSettings(): void {
    this.root.querySelector<HTMLElement>("#settings-modal")!.classList.remove("hidden");
  }

  openDrawer(): void {
    this.root.querySelector(".shell")?.classList.add("drawer-open");
    requestAnimationFrame(() => this.fitAll());
  }

  closeDrawer(): void {
    this.root.querySelector(".shell")?.classList.remove("drawer-open");
    requestAnimationFrame(() => this.fitAll());
  }
}

// ── Shared helpers ───────────────────────────────────────────────────────────

function getDeviceIcon(d: AppDevice): string {
  const trimmed = d.name.trim();
  if (/^[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u.test(trimmed)) {
    return "";
  }
  if (
    d.type === "android" ||
    /phone|android|mobile/i.test(d.name) ||
    /phone|android|mobile/i.test(d.id)
  ) {
    return "📱 ";
  }
  return "🖥 ";
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function escapeAttr(text: string): string {
  return text.replace(/"/g, "&quot;").replace(/&/g, "&amp;");
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function encodeUTF8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export interface ClipboardApi {
  writeText?: (text: string) => Promise<void>;
  readText?: () => Promise<string>;
}

/**
 * Handle custom key events for the xterm.js terminal instance.
 * - Ctrl+Shift+C: Copy selected terminal text to system clipboard.
 * - Ctrl+Shift+V: Paste text from system clipboard into terminal stdin.
 * - Reserved browser shortcuts (Ctrl+T, Ctrl+N, Ctrl+W, Ctrl+R, Ctrl+P, F11, F12, Ctrl+Tab): Left for the browser.
 * - Standard terminal keys (Ctrl+C, Ctrl+D, Ctrl+Z, Arrow keys, Tab, Escape, F-keys, etc.): Allowed through to xterm.js.
 */
export function handleCustomKey(
  ev: KeyboardEvent,
  term: Terminal,
  session: TerminalSession,
  clipboard?: ClipboardApi,
): boolean {
  if (ev.type !== "keydown") return true;

  const isCtrl = ev.ctrlKey || ev.metaKey;
  const isShift = ev.shiftKey;
  const key = ev.key.toLowerCase();

  // Browser-reserved shortcuts: do not intercept
  if (
    (isCtrl && (key === "t" || key === "n" || key === "w" || key === "r" || key === "p")) ||
    ev.key === "F11" ||
    ev.key === "F12" ||
    (isCtrl && key === "tab")
  ) {
    return false;
  }

  // Ctrl+Q / Cmd+Q: Prevent browser from quitting, allow xterm.js to send 0x11 (XON)
  if (isCtrl && !isShift && key === "q") {
    ev.preventDefault();
    return true;
  }

  // Ctrl+Shift+C: Copy selected text from terminal
  if (isCtrl && isShift && key === "c") {
    ev.preventDefault();
    if (term.hasSelection()) {
      const selection = term.getSelection();
      const write = clipboard?.writeText ?? ((t) => navigator.clipboard.writeText(t));
      void Promise.resolve(write(selection)).catch(() => {
        /* ignore clipboard error */
      });
    }
    return false;
  }

  // Ctrl+Shift+V: Paste text into terminal input
  if (isCtrl && isShift && key === "v") {
    ev.preventDefault();
    const read = clipboard?.readText ?? (() => navigator.clipboard.readText());
    void Promise.resolve(read())
      .then((text) => {
        if (text) {
          session.sendInput(encodeUTF8(text));
        }
      })
      .catch(() => {
        /* ignore clipboard error */
      });
    return false;
  }

  return true;
}
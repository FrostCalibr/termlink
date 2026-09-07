import "./styles.css";
import { ApiClient } from "./api.js";
import { AppController } from "./app-controller.js";
import { ThemeManager } from "./theme.js";
import { WebTransport } from "./transport.js";
import type { TransportHandle } from "./terminal-session.js";
import { mountLogin, ShellView } from "./views.js";
import type { WebTransportEvent } from "./transport.js";

const root = document.getElementById("app") as HTMLElement;
if (!root) throw new Error("missing #app mount point");

const api = new ApiClient();
const theme = new ThemeManager();
const controller = new AppController({
  api,
  transportFactory: createTransport,
  devicePollMs: 15_000,
});

let shell: ShellView | null = null;
let currentAuth: string | null = null;

controller.store.subscribe((state) => {
  if (state.auth === currentAuth) {
    return;
  }
  currentAuth = state.auth;
  if (state.auth === "authenticated") {
    if (!shell) {
      shell = new ShellView(root, {
        controller,
        theme,
        onThemeCycle: () => theme.cycle(),
        onOpenNewSession: () => shell?.openNewSessionModal(),
      });
    }
  } else if (state.auth === "anonymous" || state.auth === "booting") {
    shell?.destroy();
    shell = null;
    if (state.auth === "booting") {
      root.innerHTML = `<div class="boot-screen"><span class="boot-spinner"></span><p>Starting…</p></div>`;
    } else {
      mountLogin(
        root,
        {
          onToken: (token) => controller.loginToken(token),
          onPassword: (username, password) =>
            controller.loginPassword(username, password),
        },
        controller,
      );
    }
  }
});

/**
 * Build a {@link TransportHandle} for a session's relay connect path. The URL
 * scheme mirrors the page (wss on https); the token is the web-session token.
 */
function createTransport(opts: {
  path: string;
  token: string;
  onEvent: (event: WebTransportEvent) => void;
}): TransportHandle {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  const url = `${scheme}://${window.location.host}${opts.path}`;
  const transport = new WebTransport({
    url,
    token: opts.token,
    reconnect: true,
    maxReconnectAttempts: 5,
    reconnectBaseDelayMs: 500,
    reconnectMaxDelayMs: 8000,
    binaryType: "arraybuffer",
    onEvent: opts.onEvent,
  });
  transport.connect();
  return transport;
}

void controller.bootstrap();
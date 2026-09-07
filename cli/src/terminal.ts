import { WebSocket } from "ws";
import type { CliConfig } from "./config.js";

export interface ConnectTerminalOptions {
  config: CliConfig;
  connectPath: string;
  onExit?: (code: number) => void;
  /** Injectable stdout/stdin streams for testing. */
  stdout?: NodeJS.WriteStream;
  stdin?: NodeJS.ReadStream;
  createWebSocket?: (url: string) => WebSocket;
}

export function buildWsUrl(relayUrl: string, connectPath: string): string {
  const base = relayUrl.replace(/\/+$/, "");
  const wsBase = base.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
  return `${wsBase}${connectPath.startsWith("/") ? "" : "/"}${connectPath}`;
}

export function runCliTerminal(options: ConnectTerminalOptions): Promise<number> {
  return new Promise((resolve) => {
    const { config, connectPath } = options;
    const stdout = options.stdout ?? process.stdout;
    const stdin = options.stdin ?? process.stdin;
    const wsUrl = buildWsUrl(config.relayUrl, connectPath);

    const ws = options.createWebSocket
      ? options.createWebSocket(wsUrl)
      : new WebSocket(wsUrl);

    let isRaw = false;
    let wasResized = false;
    let cleanedUp = false;

    const cleanup = (exitCode = 0) => {
      if (cleanedUp) return;
      cleanedUp = true;

      // Restore terminal raw mode and cursor
      if (isRaw && typeof stdin.setRawMode === "function") {
        try {
          stdin.setRawMode(false);
        } catch {
          /* ignore */
        }
      }
      try {
        stdin.pause();
      } catch {
        /* ignore */
      }
      try {
        stdout.write("\x1b[?25h");
      } catch {
        /* ignore */
      }

      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }

      options.onExit?.(exitCode);
      resolve(exitCode);
    };

    const sendResize = () => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const cols = stdout.columns || 80;
      const rows = stdout.rows || 24;
      try {
        ws.send(JSON.stringify({ type: "terminal_resize", cols, rows }));
      } catch {
        /* ignore */
      }
    };

    const onResize = () => {
      sendResize();
    };

    const onStdinData = (chunk: Buffer) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(
          JSON.stringify({
            type: "terminal_input",
            data: chunk.toString("base64"),
          }),
        );
      } catch {
        /* ignore */
      }
    };

    const onProcessSigint = () => {
      // If not in raw mode, clean up and exit
      if (!isRaw) {
        cleanup(130);
      }
      // If in raw mode, stdin data handler already sent 0x03 (ETX) to remote PTY
    };

    ws.on("open", () => {
      /* waiting for hello message */
    });

    ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        stdout.write(buf);
        return;
      }

      const text = data.toString("utf-8");
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }

      switch (msg.type) {
        case "hello":
          ws.send(
            JSON.stringify({
              type: "auth_request",
              method: "token",
              token: config.sessionToken,
            }),
          );
          break;

        case "auth_ok":
          // Enable raw mode and attach terminal streaming
          if (stdin.isTTY && typeof stdin.setRawMode === "function") {
            try {
              stdin.setRawMode(true);
              isRaw = true;
            } catch {
              /* ignore */
            }
          }
          stdin.resume();
          stdin.on("data", onStdinData);

          if (stdout.isTTY) {
            stdout.on("resize", onResize);
            process.on("SIGWINCH", onResize);
            wasResized = true;
          }

          process.on("SIGINT", onProcessSigint);
          process.on("SIGTERM", onProcessSigint);

          // Send initial size
          sendResize();
          break;

        case "auth_fail":
          stdout.write(`\r\nAuthentication failed: ${String(msg.reason ?? "invalid token")}\r\n`);
          cleanup(1);
          break;

        case "terminal_output":
          if (typeof msg.data === "string") {
            const buf = Buffer.from(msg.data, "base64");
            stdout.write(buf);
          }
          break;

        case "data":
          if (typeof msg.data === "string") {
            stdout.write(msg.data);
          }
          break;

        case "binary":
          if (typeof msg.data === "string") {
            const buf = Buffer.from(msg.data, "base64");
            stdout.write(buf);
          }
          break;

        case "goodbye":
          if (typeof msg.reason === "string" && msg.reason.length > 0) {
            stdout.write(`\r\n[${msg.reason}]\r\n`);
          }
          cleanup(0);
          break;

        case "ping":
          try {
            ws.send(JSON.stringify({ type: "pong" }));
          } catch {
            /* ignore */
          }
          break;
      }
    });

    ws.on("error", (err) => {
      stdout.write(`\r\nConnection error: ${err.message}\r\n`);
      cleanup(1);
    });

    ws.on("close", () => {
      cleanup(0);
    });
  });
}

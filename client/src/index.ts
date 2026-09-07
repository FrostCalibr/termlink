import { loadClientConfig } from "./config.js";
import { TcpClient } from "./transport.js";
import type { TransportEvent } from "./transport.js";

const logger = {
  info(msg: string, fields?: Record<string, unknown>) {
    console.log(JSON.stringify({ level: "info", msg, ...fields }));
  },
  warn(msg: string, fields?: Record<string, unknown>) {
    console.warn(JSON.stringify({ level: "warn", msg, ...fields }));
  },
  error(msg: string, fields?: Record<string, unknown>) {
    console.error(JSON.stringify({ level: "error", msg, ...fields }));
  },
};

let config;
try {
  config = loadClientConfig(process.env);
} catch (err) {
  logger.error("config_error", { error: String(err) });
  process.exit(1);
}
if (!config.token && !(config.username && config.password)) {
  logger.error("config_error", {
    error: "Set AUTH_TOKEN or USERNAME/PASSWORD for authentication",
  });
  process.exit(1);
}
if (config.tls) {
  logger.info("tls_enabled", {
    detail: "outbound connection will be TLS-encrypted",
  });
}

let ready = false;
let stdinEnded = false;
const pendingLines: string[] = [];

function maybeClose(): void {
  if (stdinEnded && ready) {
    client.close();
  }
}

const client = new TcpClient({
  config,
  logger,
  onEvent: (event: TransportEvent) => {
    switch (event.type) {
      case "connected":
        logger.info("connected");
        break;
      case "ready":
        logger.info("authenticated", { sessionId: event.sessionId });
        ready = true;
        // Forward lines buffered while connecting.
        for (const line of pendingLines.splice(0)) {
          client.sendData(line);
        }
        maybeClose();
        break;
      case "auth_failed":
        logger.error("authentication_failed", { reason: event.reason });
        break;
      case "data":
        process.stdout.write(event.payload);
        break;
      case "goodbye":
        logger.info("goodbye", { reason: event.reason });
        break;
      case "disconnected":
        logger.info("disconnected");
        break;
      case "reconnecting":
        logger.warn("reconnecting", { attempt: event.attempt });
        break;
      case "reconnect_failed":
        logger.error("reconnect_failed");
        break;
      case "error":
        logger.error("client_error", { message: event.message });
        break;
      default:
        break;
    }
  },
});

client
  .connect()
  .then(() => {
    if (process.stdin.isTTY) {
      process.stdout.write(
        "\nConnected. Type a line and press Enter (Ctrl-D to quit).\n",
      );
    }
    process.stdin
      .setEncoding("utf-8")
      .on("data", (line: string) => {
        if (ready) {
          client.sendData(line);
        } else {
          pendingLines.push(line);
        }
      })
      .on("end", () => {
        stdinEnded = true;
        maybeClose();
      });
  })
  .catch((err) => {
    logger.error("connect_failed", { error: String(err) });
    process.exit(1);
  });
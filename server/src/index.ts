import { loadConfig, ConfigError } from "./config.js";
import { TcpServer } from "./server.js";

// Minimal structured logger. In later phases this may be swapped for a
// JSON logging library, but we keep it dependency-free for now.
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
  config = loadConfig(process.env);
} catch (err) {
  if (err instanceof ConfigError) {
    logger.error("config_error", { error: err.message });
  } else {
    logger.error("config_error", { error: String(err) });
  }
  process.exit(1);
}

const server = new TcpServer({ config, logger });

server.listen().then(
  () => {
    if (config.tls) {
      logger.info("tls_enabled", {
        detail: "connections are TLS-encrypted",
        hostname_verification: "client CA/pre-shared trust only",
      });
    } else {
      logger.warn(
        "NO_TLS: authentication is being performed over an unencrypted TCP connection. " +
          "This is suitable only for trusted/local development, NOT production.",
      );
    }
    logger.info("ready", {
      tls: config.tls ? "on" : "off",
      pty: config.pty ? "on" : "off",
      ssh: config.ssh ? "on" : "off",
      auth_timeout_ms: config.authTimeoutMs,
      auth_rate_global: config.authRateLimit,
      auth_rate_per_ip: config.authRateLimitPerIp,
      session_ttl_ms: config.sessionTtlMs,
    });
    if (config.ssh?.insecureHostKeyCheck) {
      logger.warn(
        "SSH_INSECURE_HOST_KEY_CHECK is enabled: SSH host-key verification is " +
          "disabled. This is a severe security risk and should only be used " +
          "for local development.",
      );
    }
    if (config.ssh && !config.tls) {
      logger.warn(
        "SSH backend is enabled but the TCP listener is not TLS-encrypted. " +
          "Enable TLS or restrict this hop to trusted networks.",
      );
    }
  },
  (err: unknown) => {
    logger.error("listen_failed", { error: String(err) });
    process.exit(1);
  },
);

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("shutdown_start", { signal });
  const timeout = setTimeout(() => {
    logger.error("shutdown_force_exit", { hint: "connections did not drain" });
    process.exit(1);
  }, 10_000);
  timeout.unref();

  try {
    await server.close();
    clearTimeout(timeout);
    logger.info("shutdown_complete");
    process.exit(0);
  } catch (err) {
    logger.error("shutdown_error", { error: String(err) });
    process.exit(1);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

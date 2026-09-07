import { loadRelayConfig, ConfigError } from "./config.js";
import { RelayServer } from "./relay.js";

const logger = {
  info: (msg: string, fields?: Record<string, unknown>) =>
    console.log(`[relay] ${msg}`, fields ?? {}),
  warn: (msg: string, fields?: Record<string, unknown>) =>
    console.warn(`[relay] ${msg}`, fields ?? {}),
  error: (msg: string, fields?: Record<string, unknown>) =>
    console.error(`[relay] ${msg}`, fields ?? {}),
};

let config;
try {
  config = loadRelayConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`[relay] config error: ${err.message}`);
  } else {
    console.error(`[relay] failed to load config: ${err}`);
  }
  process.exit(1);
}

const noTlsNotes = [];
if (!config.tls) {
  noTlsNotes.push(
    "relay → backend connections are unencrypted (set TLS_ENABLED=true + TLS_CA_FILE for TLS)",
  );
}
if (config.websocket && !config.websocket.tls) {
  noTlsNotes.push(
    "WebSocket front door is unencrypted (set TLS_ENABLED=true + TLS_CERT_FILE/TLS_KEY_FILE for WSS)",
  );
}
for (const note of noTlsNotes) {
  console.warn(`[relay] WARNING: ${note}.`);
}
if (config.websocket && config.websocket.allowedOrigins.length === 0) {
  console.warn(
    "[relay] WARNING: WS_ALLOWED_ORIGINS is empty; any Origin is accepted. Set it for production.",
  );
}
console.warn(
  `[relay] authorized targets: ${config.targets
    .map((t) => `${t.id}=${t.host}:${t.port}`)
    .join(", ")}`,
);

const relay = new RelayServer({ config, logger });

relay
  .listen()
  .then(() => {
    logger.info("relay_started", {
      host: config.host,
      port: config.port,
      tls_backend: config.tls ? "on" : "off",
      auth_timeout_ms: config.authTimeoutMs,
      auth_rate_global: config.authRateLimit,
      auth_rate_per_ip: config.authRateLimitPerIp,
      session_ttl_ms: config.sessionTtlMs,
    });
    if (relay.hasWebSocket) {
      logger.info("ws_started", {
        host: config.websocket?.host,
        port: relay.wsPort,
        tls: config.websocket?.tls ? "wss" : "ws",
        webroot: config.websocket?.webroot,
      });
    } else {
      logger.info("ws_disabled", {
        detail: "set WS_ENABLED=true to expose the WebSocket front door",
      });
    }
  })
  .catch((err) => {
    logger.error("relay_failed_to_listen", { error: String(err) });
    process.exit(1);
  });

function shutdown(signal: string): void {
  logger.info("shutdown_signal", { signal });
  // Force-exit if graceful shutdown hangs.
  const forceExit = setTimeout(() => {
    logger.error("shutdown_forced", { reason: "timed out after 10s" });
    process.exit(1);
  }, 10_000);
  forceExit.unref();
  relay.close().then(() => {
    logger.info("shutdown_complete", {});
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
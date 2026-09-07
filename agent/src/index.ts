import { loadAgentConfig, AgentConfigError } from "./config.js";
import { ensureDeviceSecret } from "./credentials.js";
import { PtyManager } from "./pty-manager.js";
import { RelayClient } from "./relay-client.js";
import type { DeviceServerMessage } from "../../shared/device/protocol.js";

/**
 * Phase 9 device agent.
 *
 * Holds a persistent, outbound WebSocket to the relay's /device endpoint.
 * Enrolls (device-generated secret) or authenticates on reconnect, then
 * spawns isolated local PTY shells for browser GUI sessions multiplexed over
 * that single connection. No inbound ports, no SSH daemon: the relay can only
 * talk to us while we are connected to it.
 */

function makeLogger(service: string) {
  const stamp = () => new Date().toISOString();
  const emit = (level: string, msg: string, fields?: Record<string, unknown>) => {
    const line = fields && Object.keys(fields).length > 0
      ? `${msg} ${JSON.stringify(fields)}`
      : msg;
    if (level === "error") console.error(`[${stamp()}] ${service} ${level}: ${line}`);
    else console.log(`[${stamp()}] ${service} ${level}: ${line}`);
  };
  return {
    info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
    warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
    error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
  };
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadAgentConfig();
  } catch (err) {
    if (err instanceof AgentConfigError) {
      console.error(`agent configuration error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const logger = makeLogger("agent");

  const creds = ensureDeviceSecret(config.credentialsFile);
  if (creds.created) {
    logger.info("device_secret_created", {
      path: config.credentialsFile,
      detail: "mode 0600; enroll this device in the relay on first connect",
    });
  }

  const pty = new PtyManager(
    {
      shell: config.shell,
      cols: 80,
      rows: 24,
      cwd: config.cwd,
    },
    (msg) => client.send(msg),
    logger,
  );

  const client = new RelayClient({
    config,
    secret: creds.secret,
    logger,
    onServerMessage: (msg) => routeServerMessage(msg, pty, client, logger),
    onFatal: (reason) => {
      logger.error("agent_stopping", { reason });
      pty.closeAll();
      process.exit(1);
    },
  });

  function routeServerMessage(
    msg: DeviceServerMessage,
    manager: PtyManager,
    relay: RelayClient,
    log: ReturnType<typeof makeLogger>,
  ): void {
    switch (msg.type) {
      case "device_session_open":
        manager.start(msg.sessionId, msg.cols, msg.rows);
        break;
      case "device_session_close":
        log.warn("agent_session_close", {
          sessionId: msg.sessionId,
          reason: msg.reason,
        });
        manager.close(msg.sessionId);
        break;
      case "device_session_input":
        manager.input(msg.sessionId, msg.data);
        break;
      case "device_session_resize":
        manager.resize(msg.sessionId, msg.cols, msg.rows);
        break;
      default:
        break;
    }
  }

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("agent_shutdown", { signal });
    client.stop();
    pty.closeAll();
    setTimeout(() => process.exit(0), 100).unref?.();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  client.start();
  logger.info("agent_started", {
    deviceId: config.deviceId,
    relay: config.relayUrl,
  });
}

main().catch((err) => {
  console.error(`agent fatal: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
import { ensureDeviceSecret, type DeviceCredentials } from "../credentials.js";
import { PtyManager } from "../pty-manager.js";
import { RelayClient, type RelayClientLogger } from "../relay-client.js";
import { AndroidWakeLockManager } from "./wake-lock.js";
import type { AndroidAgentConfig } from "./config.js";
import type { DeviceServerMessage } from "../../../shared/device/protocol.js";

export interface AndroidAgentLogger extends RelayClientLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function makeAndroidLogger(service = "android-agent"): AndroidAgentLogger {
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

/**
 * Android Device Agent.
 *
 * Holds a persistent outbound WebSocket connection to the relay's `/device` path,
 * authenticates using an Android-persisted secret (0600), and manages isolated
 * local Android shells (e.g. Termux bash/sh) for browser terminal sessions.
 * Never requires an inbound port and respects Android background execution & wake lock.
 */
export class AndroidAgent {
  readonly config: AndroidAgentConfig;
  readonly logger: AndroidAgentLogger;
  readonly wakeLock: AndroidWakeLockManager;
  readonly credentials: DeviceCredentials;
  readonly pty: PtyManager;
  readonly client: RelayClient;
  private stopping = false;

  constructor(config: AndroidAgentConfig, logger?: AndroidAgentLogger) {
    this.config = config;
    this.logger = logger ?? makeAndroidLogger();

    this.wakeLock = new AndroidWakeLockManager({
      enabled: config.wakeLock,
      logger: this.logger,
    });

    this.credentials = ensureDeviceSecret(config.credentialsFile);
    if (this.credentials.created) {
      this.logger.info("android_device_secret_created", {
        path: config.credentialsFile,
        detail: "mode 0600; secret saved for Android device enrollment",
      });
    }

    this.pty = new PtyManager(
      {
        shell: config.shellEnv.shell,
        cols: 80,
        rows: 24,
        cwd: config.shellEnv.cwd,
      },
      (msg) => this.client.send(msg),
      this.logger,
    );

    this.client = new RelayClient({
      config: {
        relayUrl: config.relayUrl,
        deviceId: config.deviceId,
        enrollmentToken: config.enrollmentToken,
        credentialsFile: config.credentialsFile,
        shell: config.shellEnv.shell,
        cwd: config.shellEnv.cwd,
        reconnectMinMs: config.reconnectMinMs,
        reconnectMaxMs: config.reconnectMaxMs,
        reconnectFactor: config.reconnectFactor,
        authTimeoutMs: config.authTimeoutMs,
        pingIntervalMs: config.pingIntervalMs,
        idleTimeoutMs: config.idleTimeoutMs,
        sendHighWaterMark: config.sendHighWaterMark,
        sendLowWaterMark: config.sendLowWaterMark,
      },
      secret: this.credentials.secret,
      logger: this.logger,
      onServerMessage: (msg) => this.routeServerMessage(msg),
      onFatal: (reason) => {
        this.logger.error("android_agent_stopping", { reason });
        void this.stop();
      },
    });
  }

  /** Start the Android Device Agent (acquire wake-lock and connect outbound to relay). */
  async start(): Promise<void> {
    this.stopping = false;
    await this.wakeLock.acquire();
    this.client.start();
    this.logger.info("android_agent_started", {
      deviceId: this.config.deviceId,
      relayUrl: this.config.relayUrl,
      shell: this.config.shellEnv.shell,
      isTermux: this.config.shellEnv.isTermux,
    });
  }

  /** Gracefully stop the agent, closing all PTY sessions, relay connections, and releasing wake lock. */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.logger.info("android_agent_stopping_gracefully", {});
    this.client.stop();
    this.pty.closeAll();
    await this.wakeLock.release();
    this.logger.info("android_agent_stopped", {});
  }

  private routeServerMessage(msg: DeviceServerMessage): void {
    switch (msg.type) {
      case "device_session_open":
        this.pty.start(msg.sessionId, msg.cols, msg.rows);
        break;
      case "device_session_close":
        this.logger.warn("android_agent_session_close", {
          sessionId: msg.sessionId,
          reason: msg.reason,
        });
        this.pty.close(msg.sessionId);
        break;
      case "device_session_input":
        this.pty.input(msg.sessionId, msg.data);
        break;
      case "device_session_resize":
        this.pty.resize(msg.sessionId, msg.cols, msg.rows);
        break;
      default:
        break;
    }
  }
}

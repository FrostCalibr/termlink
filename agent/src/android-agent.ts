import { loadAndroidAgentConfig } from "./android/config.js";
import { AndroidAgent, makeAndroidLogger } from "./android/agent.js";
import { AgentConfigError } from "./config.js";

/**
 * Phase 10 Android Device Agent CLI entry point.
 *
 * Runs on Android (Termux or Node runtime). Holds a persistent outbound
 * WebSocket to the relay's /device endpoint, acquires CPU wake locks if
 * available, and manages isolated terminal sessions for browser clients.
 */
async function main(): Promise<void> {
  let config;
  try {
    config = loadAndroidAgentConfig();
  } catch (err) {
    if (err instanceof AgentConfigError) {
      console.error(`Android agent configuration error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const logger = makeAndroidLogger("android-agent");
  const agent = new AndroidAgent(config, logger);

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("android_agent_shutdown_signal", { signal });
    agent
      .stop()
      .then(() => {
        setTimeout(() => process.exit(0), 100).unref?.();
      })
      .catch((err) => {
        logger.error("android_agent_shutdown_error", { error: String(err) });
        process.exit(1);
      });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGHUP", () => shutdown("SIGHUP"));

  await agent.start();
}

main().catch((err) => {
  console.error(`Android agent fatal error: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});

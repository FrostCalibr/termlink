import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export interface CliConfig {
  relayUrl: string;
  sessionToken: string;
  username: string;
}

export function defaultCliConfigPath(): string {
  const home = homedir();
  return join(home, ".config", "termlink", "credentials.json");
}

export function loadCliConfig(configPath = defaultCliConfigPath()): CliConfig | null {
  if (!existsSync(configPath)) return null;
  try {
    const raw = readFileSync(configPath, "utf-8");
    const json = JSON.parse(raw) as Partial<CliConfig>;
    if (typeof json.relayUrl === "string" && typeof json.sessionToken === "string") {
      return {
        relayUrl: json.relayUrl.replace(/\/+$/, ""),
        sessionToken: json.sessionToken,
        username: json.username ?? "user",
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function saveCliConfig(config: CliConfig, configPath = defaultCliConfigPath()): void {
  const dir = dirname(configPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const payload = JSON.stringify(
    {
      relayUrl: config.relayUrl.replace(/\/+$/, ""),
      sessionToken: config.sessionToken,
      username: config.username,
    },
    null,
    2,
  );
  writeFileSync(configPath, payload, { mode: 0o600 });
  try {
    chmodSync(configPath, 0o600);
  } catch {
    /* ignore on non-posix if file permissions fail */
  }
}

export function clearCliConfig(configPath = defaultCliConfigPath()): void {
  if (existsSync(configPath)) {
    try {
      unlinkSync(configPath);
    } catch {
      /* ignore */
    }
  }
}

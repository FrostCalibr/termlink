import { createInterface } from "node:readline";
import { loadCliConfig, saveCliConfig, clearCliConfig, defaultCliConfigPath } from "./config.js";
import { CliApiClient, CliApiError, type ApiDevice, type ApiSession } from "./api.js";
import { runCliTerminal } from "./terminal.js";

const DEFAULT_RELAY_URL = "http://127.0.0.1:19001";

export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  const command = args[0]?.toLowerCase();

  switch (command) {
    case "login":
      return handleLogin(args.slice(1));
    case "logout":
      return handleLogout();
    case "devices":
      return handleDevices(args.slice(1));
    case "sessions":
      return handleSessions(args.slice(1));
    case "connect":
      return handleConnect(args.slice(1));
    case "ssh":
      return handleSsh(args.slice(1));
    case "-h":
    case "--help":
    case "help":
    case undefined:
      printUsage();
      return 0;
    case "-v":
    case "--version":
      console.log("termlink 0.1.0");
      return 0;
    default:
      console.error(`Unknown command "${command}". Run "termlink --help" for usage.`);
      return 1;
  }
}

function printUsage(): void {
  console.log(`
termlink CLI Terminal Client

USAGE:
  termlink <command> [options]

COMMANDS:
  login [relayUrl]              Authenticate and save credentials to config
  devices                       List available target devices
  sessions                      List active terminal sessions
  connect <device-or-session>   Start or attach an interactive PTY shell
  ssh <target-device>           Start an interactive SSH session via server backend
  logout                        Clear saved CLI credentials

OPTIONS for login:
  --token <token>               Authenticate using a bearer token
  --username <u > --password <p> Authenticate using username and password

EXAMPLES:
  $ termlink login http://127.0.0.1:19001 --token dev-token
  $ termlink devices
  $ termlink connect my-pc
  $ termlink ssh production-server
`);
}

async function handleLogin(args: string[]): Promise<number> {
  let relayUrl = "";
  let token = "";
  let username = "";
  let password = "";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--token" && i + 1 < args.length) {
      token = args[++i];
    } else if (arg === "--username" && i + 1 < args.length) {
      username = args[++i];
    } else if (arg === "--password" && i + 1 < args.length) {
      password = args[++i];
    } else if (!arg.startsWith("-") && !relayUrl) {
      relayUrl = arg;
    }
  }

  const existingConfig = loadCliConfig();
  if (!relayUrl) {
    relayUrl = existingConfig?.relayUrl || DEFAULT_RELAY_URL;
  }
  relayUrl = relayUrl.replace(/\/+$/, "");

  const api = new CliApiClient();

  if (token) {
    try {
      const config = await api.loginToken(relayUrl, token);
      saveCliConfig(config);
      console.log(`✔ Authenticated with ${config.relayUrl} as token user`);
      return 0;
    } catch (err) {
      console.error(`Login failed: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  if (username && password) {
    try {
      const config = await api.loginPassword(relayUrl, username, password);
      saveCliConfig(config);
      console.log(`✔ Authenticated with ${config.relayUrl} as ${config.username}`);
      return 0;
    } catch (err) {
      console.error(`Login failed: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  // Interactive prompt if no auth flags provided
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (query: string): Promise<string> =>
    new Promise((resolve) => rl.question(query, resolve));

  try {
    const inputUrl = await ask(`Relay URL [${relayUrl}]: `);
    if (inputUrl.trim()) relayUrl = inputUrl.trim();

    console.log("Authentication method:\n  1) Bearer token\n  2) Username & password");
    const choice = await ask("Choice [1]: ");

    let config;
    if (choice.trim() === "2") {
      const u = await ask("Username: ");
      const p = await ask("Password: ");
      rl.close();
      config = await api.loginPassword(relayUrl, u.trim(), p);
    } else {
      const t = await ask("Relay token: ");
      rl.close();
      config = await api.loginToken(relayUrl, t.trim());
    }

    saveCliConfig(config);
    console.log(`\n✔ Authenticated with ${config.relayUrl} as ${config.username}`);
    return 0;
  } catch (err) {
    rl.close();
    console.error(`\nLogin failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

async function handleLogout(): Promise<number> {
  clearCliConfig();
  console.log(`✔ Saved credentials removed from ${defaultCliConfigPath()}`);
  return 0;
}

async function handleDevices(args: string[]): Promise<number> {
  const config = loadCliConfig();
  if (!config) {
    console.error(`Not logged in. Run "termlink login" first.`);
    return 1;
  }

  const api = new CliApiClient();
  try {
    const devices = await api.listDevices(config);
    if (devices.length === 0) {
      console.log("No devices configured.");
      return 0;
    }

    console.log(formatDeviceTable(devices));
    return 0;
  } catch (err) {
    console.error(`Failed to list devices: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

async function handleSessions(args: string[]): Promise<number> {
  const config = loadCliConfig();
  if (!config) {
    console.error(`Not logged in. Run "termlink login" first.`);
    return 1;
  }

  const api = new CliApiClient();
  try {
    const sessions = await api.listSessions(config);
    if (sessions.length === 0) {
      console.log("No active sessions.");
      return 0;
    }

    console.log(formatSessionTable(sessions));
    return 0;
  } catch (err) {
    console.error(`Failed to list sessions: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

async function handleConnect(args: string[]): Promise<number> {
  const target = args[0]?.trim();
  if (!target) {
    console.error(`Usage: termlink connect <device-or-session>`);
    return 1;
  }

  const config = loadCliConfig();
  if (!config) {
    console.error(`Not logged in. Run "termlink login" first.`);
    return 1;
  }

  const api = new CliApiClient();

  try {
    const [sessions, devices] = await Promise.all([
      api.listSessions(config).catch(() => [] as ApiSession[]),
      api.listDevices(config),
    ]);

    // 1) Match active open session id
    const existingSession = sessions.find(
      (s) => s.id === target && s.state !== "closed",
    );
    if (existingSession) {
      const connectPath = `/ws?device=${encodeURIComponent(existingSession.deviceId)}&type=${encodeURIComponent(existingSession.type)}&session=${encodeURIComponent(existingSession.id)}`;
      return runCliTerminal({ config, connectPath });
    }

    // 2) Match device ID or Name
    const device =
      devices.find((d) => d.id === target) ||
      devices.find((d) => d.name.toLowerCase() === target.toLowerCase()) ||
      devices.find((d) => d.id.toLowerCase().includes(target.toLowerCase()));

    if (!device) {
      console.error(`Device or session "${target}" not found.`);
      console.error(`Available devices: ${devices.map((d) => d.id).join(", ")}`);
      return 1;
    }

    if (!device.online && device.type !== "shell") {
      console.error(`Device "${device.name}" (${device.id}) is offline.`);
      return 1;
    }

    const created = await api.createSession(config, device.id, device.type);
    return runCliTerminal({ config, connectPath: created.connect.path });
  } catch (err) {
    console.error(`Failed to connect: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

async function handleSsh(args: string[]): Promise<number> {
  const target = args[0]?.trim();
  if (!target) {
    console.error(`Usage: termlink ssh <target-device>`);
    return 1;
  }

  const config = loadCliConfig();
  if (!config) {
    console.error(`Not logged in. Run "termlink login" first.`);
    return 1;
  }

  const api = new CliApiClient();

  try {
    const devices = await api.listDevices(config);
    const device =
      devices.find((d) => d.id === target && d.type === "ssh") ||
      devices.find((d) => d.name.toLowerCase() === target.toLowerCase() && d.type === "ssh") ||
      devices.find((d) => d.id === target) ||
      devices.find((d) => d.id.toLowerCase().includes(target.toLowerCase()));

    if (!device) {
      console.error(`SSH target device "${target}" not found.`);
      return 1;
    }

    const created = await api.createSession(config, device.id, "ssh");
    return runCliTerminal({ config, connectPath: created.connect.path });
  } catch (err) {
    console.error(`Failed SSH connection: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

function formatDeviceTable(devices: ApiDevice[]): string {
  const headers = ["ID", "NAME", "TYPE", "STATUS"];
  const rows = devices.map((d) => [
    d.id,
    d.name,
    d.type,
    d.online ? "ONLINE" : "OFFLINE",
  ]);

  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );

  const pad = (str: string, width: number) => str.padEnd(width + 2);
  const headerLine = headers.map((h, i) => pad(h, widths[i])).join("");
  const sepLine = widths.map((w) => "-".repeat(w + 2)).join("");
  const rowLines = rows.map((r) =>
    r.map((val, i) => pad(val, widths[i])).join(""),
  );

  return [headerLine, sepLine, ...rowLines].join("\n");
}

function formatSessionTable(sessions: ApiSession[]): string {
  const headers = ["ID", "DEVICE", "TYPE", "STATE", "CREATED"];
  const rows = sessions.map((s) => [
    s.id,
    s.deviceName,
    s.type,
    s.state,
    formatAge(s.createdAt),
  ]);

  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );

  const pad = (str: string, width: number) => str.padEnd(width + 2);
  const headerLine = headers.map((h, i) => pad(h, widths[i])).join("");
  const sepLine = widths.map((w) => "-".repeat(w + 2)).join("");
  const rowLines = rows.map((r) =>
    r.map((val, i) => pad(val, widths[i])).join(""),
  );

  return [headerLine, sepLine, ...rowLines].join("\n");
}

function formatAge(timestamp: number): string {
  const sec = Math.floor((Date.now() - timestamp) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  return `${hrs}h ago`;
}

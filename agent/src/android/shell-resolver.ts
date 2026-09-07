import { existsSync } from "node:fs";
import { resolve } from "node:path";

export interface AndroidShellEnvironment {
  /** Resolved shell binary executable path. */
  shell: string;
  /** Working directory for terminal sessions. */
  cwd: string;
  /** Environment variables for the shell. */
  env: Record<string, string>;
  /** Whether the shell environment is Termux. */
  isTermux: boolean;
}

const TERMUX_PREFIX = "/data/data/com.termux/files/usr";
const TERMUX_HOME = "/data/data/com.termux/files/home";

const CANDIDATE_SHELLS = [
  `${TERMUX_PREFIX}/bin/bash`,
  `${TERMUX_PREFIX}/bin/sh`,
  "/system/bin/sh",
  "/bin/bash",
  "/bin/sh",
  "sh",
];

/**
 * Resolves an appropriate Android shell binary and environment (such as Termux).
 * Never permits browser requests to override shell executables or environment vars.
 */
export function resolveAndroidShell(
  preferredShell?: string,
  preferredCwd?: string,
  processEnv: Record<string, string | undefined> = process.env as Record<string, string>,
): AndroidShellEnvironment {
  const isAndroid = process.platform === "android" || existsSync("/system/bin/sh");
  const prefix = processEnv.PREFIX ?? TERMUX_PREFIX;
  const isTermux = existsSync(prefix) || existsSync(TERMUX_HOME);

  let shell = "";

  if (preferredShell && preferredShell.trim().length > 0) {
    const candidate = preferredShell.trim();
    if (candidate === "sh" || candidate === "bash" || existsSync(candidate)) {
      shell = candidate;
    }
  }

  if (!shell && isTermux) {
    if (existsSync(`${prefix}/bin/bash`)) shell = `${prefix}/bin/bash`;
    else if (existsSync(`${prefix}/bin/sh`)) shell = `${prefix}/bin/sh`;
  }

  if (!shell) {
    for (const candidate of CANDIDATE_SHELLS) {
      if (candidate === "sh" || existsSync(candidate)) {
        shell = candidate;
        break;
      }
    }
  }

  if (!shell) {
    shell = "sh";
  }

  let cwd = preferredCwd?.trim() || "";
  if (!cwd) {
    if (isTermux && existsSync(TERMUX_HOME)) {
      cwd = TERMUX_HOME;
    } else if (processEnv.HOME && existsSync(processEnv.HOME)) {
      cwd = processEnv.HOME;
    } else {
      cwd = process.cwd();
    }
  }
  cwd = resolve(cwd);

  const envPath = isTermux
    ? `${prefix}/bin:${processEnv.PATH ?? "/usr/bin:/bin"}`
    : processEnv.PATH ?? "/system/bin:/system/xbin:/usr/bin:/bin";

  const env: Record<string, string> = {
    TERM: "xterm-256color",
    PATH: envPath,
    HOME: isTermux ? (existsSync(TERMUX_HOME) ? TERMUX_HOME : cwd) : (processEnv.HOME ?? cwd),
    TMPDIR: processEnv.TMPDIR ?? (isTermux ? `${prefix}/tmp` : "/tmp"),
    ...(isTermux ? { PREFIX: prefix } : {}),
    ...(isAndroid ? { ANDROID_DATA: processEnv.ANDROID_DATA ?? "/data" } : {}),
  };

  return {
    shell,
    cwd,
    env,
    isTermux,
  };
}

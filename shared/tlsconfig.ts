import { readFileSync } from "node:fs";

/**
 * Parsed server/listener TLS material (PEM strings, ready for
 * `tls.createServer` / `https.createServer`).
 */
export interface ServerTlsConfig {
  key: string;
  cert: string;
  ca?: string;
}

/**
 * Parsed client TLS options for outbound connections (relay → backend, CLI
 * client). If `ca` is set it replaces the system trust store for this
 * connection; `servername` overrides the SNI/hostname used for verification.
 */
export interface ClientTlsConfig {
  ca?: string;
  cert?: string;
  key?: string;
  servername?: string;
  rejectUnauthorized: boolean;
}

export interface ParseTlsOptions {
  /** Where the TLS material will be used (affects which options are valid). */
  role: "server" | "client";
  /** Name used in error messages so failures name the affected component. */
  name: string;
}

/**
 * Parse TLS configuration from the environment. Returns `undefined` when TLS
 * is disabled, or throws with a clear message when an enabled TLS setup is
 * invalid (missing/paired files, unreadable paths) — config loaders surface
 * this as a clean startup failure.
 *
 * Secrets can be supplied inline (`TLS_CERT`/`TLS_KEY`/`TLS_CA`) or as mounted
 * file paths (`TLS_CERT_FILE`/`TLS_KEY_FILE`/`TLS_CA_FILE`); the file form
 * wins when both are present.
 */
export function parseTls(
  env: NodeJS.ProcessEnv,
  opts: ParseTlsOptions,
): ServerTlsConfig | ClientTlsConfig | undefined {
  const enabled = bool(env.TLS_ENABLED, false);

  if (opts.role === "server") {
    const cert = readValue(env, "TLS_CERT", "TLS_CERT_FILE");
    const key = readValue(env, "TLS_KEY", "TLS_KEY_FILE");
    if (!enabled && !cert && !key) return undefined;
    if (!cert || !key) {
      throw new Error(
        `${opts.name}: TLS is enabled but a certificate and key are required ` +
          `(TLS_CERT_FILE/TLS_KEY_FILE or TLS_CERT/TLS_KEY)`,
      );
    }
    const ca = readValue(env, "TLS_CA", "TLS_CA_FILE");
    return { cert, key, ...(ca ? { ca } : {}) };
  }

  if (!enabled) return undefined;

  const result: ClientTlsConfig = { rejectUnauthorized: true };
  const ca = readValue(env, "TLS_CA", "TLS_CA_FILE");
  if (ca) result.ca = ca;
  const clientCert = readValue(env, "TLS_CLIENT_CERT", "TLS_CLIENT_CERT_FILE");
  const clientKey = readValue(env, "TLS_CLIENT_KEY", "TLS_CLIENT_KEY_FILE");
  if ((clientCert && !clientKey) || (!clientCert && clientKey)) {
    throw new Error(
      `${opts.name}: client TLS requires both a certificate and key ` +
        `(TLS_CLIENT_CERT_FILE/TLS_CLIENT_KEY_FILE)`,
    );
  }
  if (clientCert) {
    result.cert = clientCert;
    result.key = clientKey!;
  }
  const servername = str(env.TLS_SERVER_NAME);
  if (servername) result.servername = servername;
  result.rejectUnauthorized = bool(env.TLS_REJECT_UNAUTHORIZED, true);
  return result;
}

/** Read a secret from an inline env var or a mounted file path. */
function readValue(
  env: NodeJS.ProcessEnv,
  inline: string,
  file: string,
): string | undefined {
  const fileValue = env[file];
  if (fileValue !== undefined && fileValue.trim() !== "") {
    try {
      return readFileSync(fileValue.trim(), "utf-8");
    } catch (err) {
      throw new Error(
        `cannot read ${file}=${fileValue}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  const inlineValue = env[inline];
  return inlineValue !== undefined && inlineValue.trim() !== ""
    ? inlineValue
    : undefined;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const v = value.trim().toLowerCase();
  return v === "true" || v === "1";
}

function str(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v && v.length > 0 ? v : undefined;
}
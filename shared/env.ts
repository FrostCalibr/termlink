/**
 * Load `.env` into process.env if present using Node 22 native `process.loadEnvFile()`.
 * Explicitly exported environment variables take precedence and are preserved.
 */
export function loadEnvFile(path?: string): void {
  if (typeof process.loadEnvFile !== "function") return;
  try {
    process.loadEnvFile(path);
  } catch (err: unknown) {
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      err.code === "ENOENT"
    ) {
      return;
    }
    throw err;
  }
}

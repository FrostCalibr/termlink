#!/usr/bin/env node
import { main } from "../dist/cli/src/index.js";

main().then((code) => {
  if (typeof code === "number" && code !== 0) {
    process.exit(code);
  }
}).catch((err) => {
  console.error(`termlink fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

// Entry point used by the default `npm start` script.
//
// On Render (and any platform that injects RENDER_* env vars) this runs the
// WebSocket relay, which serves the public HTTP/WSS front door on `PORT`.
// Everywhere else it runs the local TCP terminal backend as before.
import { fileURLToPath } from "node:url";

function isRenderPlatform() {
  return (
    process.env.RENDER === "true" ||
    process.env.RENDER === "1" ||
    Boolean(
      process.env.RENDER_SERVICE_ID ||
        process.env.RENDER_INSTANCE_ID ||
        process.env.RENDER_SERVICE_TYPE ||
        process.env.RENDER_EXTERNAL_URL ||
        process.env.RENDER_APP_ID,
    )
  );
}

const target = isRenderPlatform()
  ? fileURLToPath(new URL("../dist/relay/src/index.js", import.meta.url))
  : fileURLToPath(new URL("../dist/server/src/index.js", import.meta.url));

await import(target);
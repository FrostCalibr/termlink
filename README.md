# Slop warning.

This is only had been made only for my personal use case. I don't think anyone
will see this but this is purely written by AI. This has serious security issue.
Even though this says is secure shell, I know for sure this has CVEs from the 1
BC

# termlink — remote terminal access over a TCP/WSS relay

termlink gives you secure interactive shells on machines you cannot open ports
on, from the browser or a CLI:

```text
Browser (web GUI) ──WSS──▶ Relay ──▶ PC / Android device agents (outbound)
CLI (termlink)    ──WSS──▶ Relay ──▶ static PTY/SSH backend servers
```

- **Relay** — a protocol-aware bridge with a WebSocket front door, a REST API,
  and the web GUI served from the same origin. Authenticates every hop and never
  dials arbitrary endpoints.
- **Backends** — `node-pty` shells and SSH sessions to static trusted hosts.
  Either one can run behind the relay, or you use **device agents** instead.
- **Device agents (PC and Android/Termux)** — a small process that keeps one
  persistent **outbound** WSS connection to the relay (`/device`), giving the
  browser isolated local shells on machines with no inbound ports and no SSH
  daemon.
- **Web GUI** — login, device sidebar, session tabs, and xterm.js terminals in
  the browser. Also ships a `termlink` CLI for scriptable use.

The project is 100% TypeScript/Node.js — no Python. It builds and runs on Render
Web Services with no source changes (see
[Render deployment](#render-deployment)).

## Contents

- [Local development](#local-development)
- [Web GUI usage](#web-gui-usage)
- [CLI usage](#cli-usage)
- [Authentication](#authentication)
- [SSH backend & host-key verification](#ssh-backend--host-key-verification)
- [Environment variables](#environment-variables)
- [Web API](#web-api)
- [TLS](#tls)
- [Render deployment](#render-deployment)
- [Security limitations](#security-limitations)

## Requirements

- **Node.js 22+** (uses `process.loadEnvFile()`; native `node-pty`, `ssh2`, and
  `ws` build cleanly on Node's prebuilt runtime — nothing else is needed).
- `npm install` builds every dependency. `npm run build` typechecks and compiles
  the server/relay/agent packages and bundles the web GUI.

## Local development

```bash
npm install
npm run build        # tsc + bundle the web GUI into web/dist/

npm test             # full test suite
npm run typecheck    # tsc --noEmit (server/relay/agent + web)

# ── Components (each in its own terminal) ────────────────────────────
npm run dev                                        # TCP backend server (PTY/SSH per config)
RELAY_PORT=19000 AUTH_TOKENS=relaytok \
  TARGETS=pty=backendtok@127.0.0.1:9000 npm run dev:relay
RELAY_URL=ws://127.0.0.1:19001 AGENT_DEVICE_ID=laptop \
  AGENT_CREDENTIALS_FILE=laptop.secret npm run dev:agent          # PC device agent
RELAY_URL=ws://127.0.0.1:19001 AGENT_DEVICE_ID=phone \
  AGENT_CREDENTIALS_FILE=phone.secret npm run dev:android-agent   # Android/Termux agent
npm run dev:web                                     # web GUI dev server (live rebuild)
npm run dev:cli                                     # CLI via tsx
```

Production start commands (after `npm run build`):

```bash
npm start                  # TCP backend server (PTY or SSH)
npm run start:relay        # relay: TCP + WSS front door + web GUI + REST API
npm run start:agent        # PC device agent
npm run start:android-agent
```

Every component loads `.env` automatically when present (Node 22
`process.loadEnvFile()`, missing files are ignored). See `.env.example` for
every variable.

The TCP `server` serves no terminal by default: enable a real shell with
`PTY_ENABLED` or `SSH_ENABLED` (mutually exclusive), or use `ECHO_DATA=true`
(the `.env.example` ships it) to echo `data` frames for smoke tests.

## Web GUI usage

Build the GUI (`npm run build`) and serve it from the relay front door with
`WS_STATIC_DIR=web` (or the `WEB_STATIC_DIR` alias). Open the relay origin in a
browser (e.g. `http://127.0.0.1:19001/`).

1. **Login** — sign in with a relay `AUTH_TOKENS` token or a `PASSWORD_USERS`
   username/password. The browser receives a web session token (bearer +
   HttpOnly `termlink_sid` cookie) and re-uses it across reloads.
2. **Devices** — the sidebar lists every configured target and agent device with
   `shell`/`ssh`/`android` type badges and online/offline state. Offline devices
   are refused for new sessions (`409 Device offline`).
3. **Sessions** — "New session" offers only the types each device supports. Each
   tab models `creating → connecting → connected → (re)connecting →
   closed`,
   survives reconnects with bounded backoff, and can be closed (which tears down
   the remote terminal).
4. **Terminal** — xterm.js workspace with input, resize, scrollback, live RTT
   (ping/pong), and a status bar showing session state and backend errors (e.g.
   SSH auth/host-key failures).

The GUI and raw WS clients coexist: unselected `/ws` connections still route to
the first configured target with plain relay credentials.

## CLI usage

Install the CLI binary (command name `termlink`) and use it against any relay:

```bash
npm install                # links ./bin/termlink.js → node_modules/.bin/termlink
# or run it without linking: npm run cli -- <args> / node dist/cli/src/index.js

termlink --help
termlink --version
termlink login http://127.0.0.1:19001 --token relaytok     # or --username/--password
termlink devices
termlink sessions
termlink connect my-pc                                     # device id/name or session id
termlink ssh prod-bastion                                   # SSH-type device only
termlink logout
```

- **Credential storage** — `termlink login` saves the web session token to
  `~/.config/termlink/credentials.json` with `0600` permissions (directory
  `0700`). `termlink logout` deletes it.
- `connect` matches an active session id first, then a device id/name (case- and
  substring-insensitive); `ssh` matches only `ssh`-type devices.
- The interactive terminal speaks the same protocol as the browser: input,
  resize, and output over the relay's `/ws?device=…&type=…&session=…` endpoint.

## Authentication

All credentials are **scrypt-hashed** at rest and compared in constant time
(`timingSafeEqual`). Token and password auth both apply to the TCP server and
the relay front door.

| Mechanism            | Env var                                   | Notes                                                                                                                             |
| -------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Relay/backend tokens | `AUTH_TOKENS`                             | Space-separated pre-shared tokens                                                                                                 |
| Password users       | `PASSWORD_USERS`                          | `username:password` comma-separated                                                                                               |
| Secret-file variants | `AUTH_TOKENS_FILE`, `PASSWORD_USERS_FILE` | Mounted files; the `_FILE` form overrides the inline value when both are set. Read once at startup — rotating requires a restart. |

Hardening, on both the server and the relay:

- `MAX_AUTH_ATTEMPTS` / `AUTH_BACKOFF_MS` — per-connection throttle.
- `AUTH_TIMEOUT_MS` — deadline to reach `ready` (0 disables).
- `AUTH_RATE_LIMIT` / `AUTH_PER_IP_RATE_LIMIT` / `AUTH_RATE_WINDOW_MS` —
  fixed-window global and per-IP throttling, tracked with the same
  `AuthRateLimiter`. Behind Render's L7 proxy, per-IP limits key on
  `X-Forwarded-For` (leftmost entry) when present.
- `SESSION_TTL_MS` — authenticated sessions expire after this age (0 = until
  disconnect).
- `WS_ALLOWED_ORIGINS` — optional comma-separated allowed `Origin` values on the
  front door (empty = any, with a startup warning).

**Web login/session behavior** — `POST /api/auth/login` validates against the
same credential store as the WS front door, returns `{ user, session }`, and
sets an HttpOnly `termlink_sid` cookie. Logins are throttled (20 / 10 min / IP).
Web sessions are in-memory: restarting the relay logs everyone out. Session
ownership is enforced — a user can only list/attach/close their own sessions.

**Device enrollment credentials** — agents are pre-authorized in the relay's
`DEVICES` (`id|Display Name|type[|enrollmentToken]`). On first connect an agent
registers and the relay stores only the scrypt hash of the device-generated
secret it must present afterwards (`device_auth`). An optional 4th `DEVICES`
segment is a per-device enrollment token the agent must echo to claim the id;
without one, the first authorized agent wins. The device secret lives in a
`0600` file on the machine and never leaves it.

## SSH backend & host-key verification

When `SSH_ENABLED=true` (exclusive with `PTY_ENABLED`), every authenticated
connection opens an interactive shell on a **static trusted remote host** over
SSH (`ssh2`): host, port, user, credentials, and command come only from server
config. Only an interactive `shell` is opened — no arbitrary `exec`.

Credentials: `SSH_PASSWORD`/`SSH_PASSWORD_FILE` or `SSH_PRIVATE_KEY`/
`SSH_PRIVATE_KEY_FILE` (PEM/OpenSSH, optional `SSH_PASSPHRASE`); private keys
are validated at startup.

Host-key verification is **mandatory by default** — configure at least one of:

- `SSH_KNOWN_HOSTS_FILE` — OpenSSH `known_hosts` (globs, `[host]:port`, hashed
  entries), or
- `SSH_HOST_KEY_FINGERPRINTS` — accepted SHA-256 digests
  (`ssh-keygen -E sha256 -lf` style), or
- `SSH_INSECURE_HOST_KEY_CHECK=true` — explicit opt-out (startup warning; do not
  use in production).

Unknown hosts or key mismatches abort the connection before any traffic is sent
and surface as `SSH host key verification failed` / `SSH authentication
failed`
/ `SSH connection timed out` cleanly across the relay to the browser.

```bash
SSH_ENABLED=true SSH_HOST=bastion SSH_USERNAME=deploy SSH_PASSWORD=... \
SSH_HOST_KEY_FINGERPRINTS=SHA256:... AUTH_TOKENS=backendtok npm run dev
```

## Environment variables

Defaults verified at `shared/protocol/constants.ts` and each package's config.
`_FILE` variants override inline values and are recommended for mounted secrets.

### TCP server

| Variable                                                                             | Default                                  | Purpose                                |
| ------------------------------------------------------------------------------------ | ---------------------------------------- | -------------------------------------- |
| `HOST`                                                                               | `0.0.0.0`                                | Bind address                           |
| `PORT`                                                                               | `9000`                                   | Listen port                            |
| `MAX_FRAME_SIZE`                                                                     | `1048576`                                | Max payload bytes (≤ 64 MB)            |
| `MAX_CONNECTIONS`                                                                    | `100`                                    | Max concurrent connections             |
| `IDLE_TIMEOUT_MS`                                                                    | `30000`                                  | Idle connection timeout                |
| `MAX_AUTH_ATTEMPTS` / `AUTH_BACKOFF_MS`                                              | `5` / `1000`                             | Auth throttle                          |
| `AUTH_TOKENS` / `AUTH_TOKENS_FILE`                                                   | _(none)_                                 | Tokens (inline or file)                |
| `PASSWORD_USERS` / `PASSWORD_USERS_FILE`                                             | _(none)_                                 | `username:password` users              |
| `AUTH_TIMEOUT_MS`                                                                    | `10000`                                  | Deadline to authenticate (0 disables)  |
| `AUTH_RATE_LIMIT` / `AUTH_PER_IP_RATE_LIMIT`                                         | `0` / `0`                                | Auth rate limits (0 disables)          |
| `AUTH_RATE_WINDOW_MS`                                                                | `60000`                                  | Window for rate limits                 |
| `SESSION_TTL_MS`                                                                     | `0`                                      | Session max age (0 = until disconnect) |
| `ECHO_DATA`                                                                          | `false`                                  | Echo `data` frames (demo/tests)        |
| `TLS_ENABLED` / `TLS_CERT(_FILE)` / `TLS_KEY(_FILE)` / `TLS_CA(_FILE)`               | off                                      | TLS listener (see [TLS](#tls))         |
| `PTY_ENABLED`                                                                        | `false`                                  | PTY backend (exclusive with SSH)       |
| `PTY_SHELL`                                                                          | `$SHELL` / `/bin/sh`                     | Shell executable (trusted config)      |
| `PTY_COLS` / `PTY_ROWS`                                                              | `80` / `24`                              | Initial terminal size (1–1000)         |
| `PTY_CWD`                                                                            | `$HOME`                                  | Working directory for shells           |
| `SSH_ENABLED`                                                                        | `false`                                  | SSH backend (exclusive with PTY)       |
| `SSH_HOST` / `SSH_PORT` / `SSH_USERNAME`                                             | _(none)_ / `22` / _(none)_               | SSH target                             |
| `SSH_PASSWORD(_FILE)` / `SSH_PRIVATE_KEY(_FILE)` / `SSH_PASSPHRASE`                  | _(none)_                                 | SSH credentials                        |
| `SSH_KNOWN_HOSTS_FILE` / `SSH_HOST_KEY_FINGERPRINTS` / `SSH_INSECURE_HOST_KEY_CHECK` | _(none)_ / _(none)_ / `false`            | Host-key verification                  |
| `SSH_CONNECT_TIMEOUT_MS` / `SSH_COLS` / `SSH_ROWS` / `SSH_TERM`                      | `15000` / `80` / `24` / `xterm-256color` | SSH session                            |

The server refuses to start on invalid or missing config (bad ports, no
credentials, unsupported protocol version).

### TCP client

| Variable                                                      | Default               | Purpose                        |
| ------------------------------------------------------------- | --------------------- | ------------------------------ |
| `SERVER_HOST` (=`HOST`)                                       | `0.0.0.0`             | Server address                 |
| `SERVER_PORT` (=`PORT`)                                       | `9000`                | Server port                    |
| `AUTH_TOKEN` (=`CLIENT_TOKEN`)                                | _(none)_              | Token auth                     |
| `USERNAME` / `PASSWORD`                                       | _(none)_              | Password auth                  |
| `CONNECT_TIMEOUT_MS`                                          | `10000`               | TCP connect timeout            |
| `CLIENT_IDLE_TIMEOUT_MS` (=`IDLE_TIMEOUT_MS`)                 | `60000`               | Idle timeout                   |
| `CLIENT_MAX_FRAME_SIZE` (=`MAX_FRAME_SIZE`)                   | `1048576`             | Max frame size                 |
| `RECONNECT` / `RECONNECT_DELAY_MS` / `MAX_RECONNECT_ATTEMPTS` | `true` / `1000` / `5` | Reconnect behavior             |
| `TLS_ENABLED` / `TLS_CA(_FILE)` / `TLS_SERVER_NAME`           | off                   | Outbound TLS (see [TLS](#tls)) |

### Relay (TCP + WSS front door)

| Variable                                                                                                          | Default                     | Purpose                                                       |
| ----------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------- |
| `RELAY_HOST` (=`HOST`)                                                                                            | `0.0.0.0`                   | Relay TCP bind address                                        |
| `RELAY_PORT` (=`PORT`)                                                                                            | `9000`                      | Relay TCP listen port (set `0` for an ephemeral port on PaaS) |
| `AUTH_TOKENS` / `PASSWORD_USERS` (+ `_FILE`)                                                                      | _(none)_                    | Relay client credentials (required)                           |
| `TARGETS`                                                                                                         | _(none)_                    | Static backends: `[id]\|[Name]\|[type=][creds@]host:port`     |
| `DEVICES`                                                                                                         | _(none)_                    | Agent devices: `id\|Name\|type[                               |
| `MAX_CONNECTIONS` / `MAX_FRAME_SIZE` / `IDLE_TIMEOUT_MS`                                                          | `100` / `1048576` / `30000` | Limits                                                        |
| `AUTH_TIMEOUT_MS`, `AUTH_RATE_LIMIT`, `AUTH_PER_IP_RATE_LIMIT`, `AUTH_RATE_WINDOW_MS`, `SESSION_TTL_MS`           | as server                   | Auth hardening                                                |
| `WS_ENABLED`                                                                                                      | `false`                     | Enable the WebSocket front door                               |
| `WS_HOST` (=`HOST`)                                                                                               | `0.0.0.0`                   | Front-door bind address                                       |
| `WS_PORT`                                                                                                         | `19001`                     | Front-door port (must ≠ `RELAY_PORT` unless it's `0`)         |
| `WS_MAX_CONNECTIONS` / `WS_MAX_MESSAGE_SIZE` / `WS_IDLE_TIMEOUT_MS`                                               | `100` / `1048576` / `30000` | Front-door limits                                             |
| `WS_ALLOWED_ORIGINS`                                                                                              | _(empty = any)_             | Allowed `Origin` values                                       |
| `WS_STATIC_DIR` (=`WEB_STATIC_DIR`)                                                                               | _(none)_                    | Serve the web GUI from this directory                         |
| `WS_AUTH_TIMEOUT_MS`                                                                                              | `10000`                     | Front-door auth deadline                                      |
| `WS_SEND_HIGH_WATER` / `WS_SEND_LOW_WATER`                                                                        | `1048576` / `262144`        | WS backpressure watermarks                                    |
| `TLS_ENABLED`, `TLS_CERT(_FILE)`, `TLS_KEY(_FILE)`, `TLS_CA(_FILE)`, `TLS_SERVER_NAME`, `TLS_REJECT_UNAUTHORIZED` | off                         | WSS + relay→backend TLS                                       |
| `RENDER`                                                                                                          | _(unset)_                   | `1`/`true` triggers Render auto-detection (below)             |

The relay refuses to start without client credentials **and** at least one of
`TARGETS`/`DEVICES`.

`TARGETS` entries may carry their own backend credential:
`id=backendtok@host:port` (token) or `id=user:pass@host:port` (password). These
are relay→backend only — never leaked to clients. Credentials must not contain
`@`; token credentials must not contain `:`.

### Device agent (PC)

| Variable                                                                       | Default               | Purpose                                               |
| ------------------------------------------------------------------------------ | --------------------- | ----------------------------------------------------- |
| `RELAY_URL`                                                                    | _(required)_          | `ws://`/`wss://` relay origin; `/device` is appended  |
| `AGENT_DEVICE_ID`                                                              | _(required)_          | Id matching a `DEVICES` entry (`[A-Za-z0-9_-]{1,64}`) |
| `AGENT_ENROLLMENT_TOKEN`                                                       | _(none)_              | Echo the relay's `DEVICES` 4th segment to enroll      |
| `AGENT_CREDENTIALS_FILE`                                                       | `agent-device.secret` | Device secret file, written `0600` at enrollment      |
| `AGENT_SHELL` / `AGENT_CWD`                                                    | `$SHELL` / `$HOME`    | Trusted local terminal config                         |
| `AGENT_PING_INTERVAL_MS` / `AGENT_IDLE_TIMEOUT_MS`                             | `20000` / `90000`     | Heartbeat / drop link                                 |
| `AGENT_RECONNECT_MIN_MS` / `AGENT_RECONNECT_MAX_MS` / `AGENT_RECONNECT_FACTOR` | `500` / `30000` / `2` | Bounded exponential backoff                           |
| `AGENT_AUTH_TIMEOUT_MS`                                                        | `10000`               | device_register→device_ok wait                        |

### Android / Termux agent

The Android agent accepts `ANDROID_RELAY_URL`, `ANDROID_DEVICE_ID`,
`ANDROID_CREDENTIALS_FILE`, `ANDROID_ENROLLMENT_TOKEN`, etc., each falling back
to the `AGENT_*`/`RELAY_URL` equivalents, plus:

| Variable                        | Default            | Purpose                                                 |
| ------------------------------- | ------------------ | ------------------------------------------------------- |
| `ANDROID_WAKE_LOCK`             | `true`             | Acquire `termux-wake-lock` (keep the link through Doze) |
| `ANDROID_SHELL` / `ANDROID_CWD` | Termux bash / home | Resolved via Termux shell resolution                    |

The agent needs **only an outbound `wss://` connection** — no inbound ports, no
SSH daemon.

## Web API

The backends' addresses and credentials never leave the relay. All endpoints
return JSON; authenticated calls use the web session token (bearer or
`termlink_sid` cookie).

| Endpoint                         | Description                                                                |
| -------------------------------- | -------------------------------------------------------------------------- |
| `POST /api/auth/login`           | `{ token }` or `{ username, password }` → `{ user, session }` + cookie     |
| `GET /api/auth/session`          | Current `{ user }` or `401`                                                |
| `POST /api/auth/logout`          | Invalidate the web session                                                 |
| `GET /api/devices`               | `[{ id, name, type, online, latencyMs }]` (static targets + agent devices) |
| `GET /api/sessions`              | The caller's GUI sessions                                                  |
| `POST /api/devices/:id/sessions` | `{ type: "shell"\|"ssh"\|"android" }` → `{ session, connect: { path } }`   |
| `DELETE /api/sessions/:id`       | Close a session you own                                                    |

`connect.path` is the `/ws?device=…&type=…&session=…` endpoint the browser (or
CLI) attaches to.

## TLS

TLS is per hop, enabled by `TLS_ENABLED=true`, and material comes inline or from
files (`_FILE` wins).

| Role   | Component                    | Requires                             |
| ------ | ---------------------------- | ------------------------------------ |
| Server | TCP backend listener         | `TLS_CERT(_FILE)` + `TLS_KEY(_FILE)` |
| Server | relay WSS front door         | `TLS_CERT(_FILE)` + `TLS_KEY(_FILE)` |
| Client | relay → backend / CLI client | `TLS_CA(_FILE)` (the signer's CA)    |

Client-side controls: `TLS_SERVER_NAME` (verify/SNI), `TLS_REJECT_UNAUTHORIZED`
(default `true`), and optional `TLS_CLIENT_CERT(_FILE)`/`TLS_CLIENT_KEY(_FILE)`
for mutual TLS. A component refuses to start if TLS is enabled without the
material its role requires.

```bash
# Backend server (TLS listener, PTY shells)
PTY_ENABLED=true AUTH_TOKENS=backendtok TLS_ENABLED=true \
  TLS_CERT_FILE=/etc/tls/server-cert.pem TLS_KEY_FILE=/etc/tls/server-key.pem npm start

# Relay: WSS for browsers + TLS to the backend
RELAY_PORT=19000 WS_ENABLED=true AUTH_TOKENS=relaytok \
  TARGETS=pty=backendtok@127.0.0.1:9000 TLS_ENABLED=true \
  TLS_CERT_FILE=/etc/tls/server-cert.pem TLS_KEY_FILE=/etc/tls/server-key.pem \
  TLS_CA_FILE=/etc/tls/ca-cert.pem TLS_SERVER_NAME=localhost npm run start:relay
```

The front-door HTTP surface also provides `GET /ws`, `GET /healthz`
(`{ status: "ok", uptime, connections, maxConnections }`), `GET|POST /api/*`,
and static file serving (`WS_STATIC_DIR`) with a MIME map and a 403
path-traversal guard. SPA fallback: extensionless paths not found on disk serve
`index.html` (so deep links and client-side routing work on Render).

## Render deployment

**What's already built in:** the repo ships a `render.yaml` blueprint and the
relay auto-adapts to Render (`RENDER=1` → WebSocket front door on Render's
`PORT`, internal TCP relay on an ephemeral port, binds `0.0.0.0`, graceful
`SIGTERM`, `/healthz`, forwarded `X-Forwarded-For`/`X-Forwarded-Proto`). No
Python is involved anywhere.

**Create the service:**

1. In Render: **New → Web Service**, connect the repo (fresh clone works, no
   manual source changes).
2. Render reads `render.yaml`, which pre-fills:
   - **Environment**: Node
   - **Build Command**: `npm install && npm run build`
   - **Start Command**: `node dist/relay/src/index.js`
   - **Health Check Path**: `/healthz`
3. Click **Create Web Service**.

**Required dashboard secrets** (never commit these; set in the Render
Environment tab):

| Variable             | Required         | Purpose                                                                                  |
| -------------------- | ---------------- | ---------------------------------------------------------------------------------------- |
| `RENDER`             | set by blueprint | `1` → auto `WS_PORT=$PORT`, `RELAY_PORT=0`, `WS_ENABLED=true`                            |
| `AUTH_TOKENS`        | yes              | Relay token for browser login + agent enrollment. Generate with `openssl rand -hex 32`.  |
| `DEVICES`            | yes*             | Agents, e.g. `laptop\|Workstation\|shell\|tok-pc-1,phone\|Pixel 8\|android\|tok-phone-1` |
| `WS_ALLOWED_ORIGINS` | yes              | Your Render URL, e.g. `https://my-relay.onrender.com` (comma-separated for more)         |

\* `DEVICES` if you connect agents. If you only forward to static backends, set
`TARGETS` instead, e.g. `desktop\|Workstation\|shell=backendtok@host:port`.
Optional: `PASSWORD_USERS`, `AUTH_RATE_LIMIT`/`AUTH_PER_IP_RATE_LIMIT`
(recommended e.g. `50`/`20`), `SESSION_TTL_MS`, `WS_MAX_CONNECTIONS`,
`MAX_FRAME_SIZE`.

**Agents connect outbound** (`wss://`). On the target machine or in Termux:

```bash
npm install && npm run build
RELAY_URL=wss://my-relay.onrender.com AGENT_DEVICE_ID=laptop \
  AGENT_ENROLLMENT_TOKEN=tok-pc-1 AGENT_CREDENTIALS_FILE=/var/lib/termlink/laptop.secret \
  npm run start:agent

# Termux: add AGENT_WAKE_LOCK=true and use start:android-agent;
# paths under /data/data/com.termux/files/home/
```

**Resulting URLs:**

- Web GUI: `https://my-relay.onrender.com` (login → devices → sessions →
  terminal, all from the same origin).
- Health check: `https://my-relay.onrender.com/healthz`.

**Limitations:**

- Web sessions are in-memory — a redeploy/restart logs everyone out; device
  enrollment persists (scrypt-hashed), so agents reconnect without re-enrolling.
- The raw TCP relay listener binds an ephemeral port and is not public; all
  traffic enters through Render's HTTP/WSS `PORT`.
- Render free-tier services suspend when idle; billing is required for
  persistent service.

## Security limitations

- TLS is operator-configured per hop. Plain TCP hops (client→relay,
  client→server) carry credentials in plaintext and must be firewalled or
  tunneled.
- Password auth transmits username/password as a protocol message (no
  challenge-response); prefer token auth over WSS/TLS.
- `WS_ALLOWED_ORIGINS` stops cross-site scripted clients only — it is not an
  authentication boundary.
- Reconnects are best-effort: buffered frames flush after re-auth, but frames in
  flight during a disconnect are dropped.
- Web GUI users share the relay credential store; treat `PASSWORD_USERS`/
  `AUTH_TOKENS` with the same care as anywhere else.
- Mounted secret files (`*_FILE`) are read once at startup; rotating credentials
  requires a restart.
- The SSH backend gives every authenticated client a shell with the server's SSH
  identity on the configured host — always verify the host key, never run with
  `SSH_INSECURE_HOST_KEY_CHECK=true` in production.
- Device enrollment without a `DEVICES` 4th-segment token is first-come-first-
  served on untrusted networks; set enrollment tokens and keep the secret file
  `0600`. The relay stores only scrypt hashes, so a relay compromise does not
  reveal device secrets.

## Tests & build status

Current verified status (all green):

- **Tests**: `npm test` — 48 files, **389 tests passing** (framing edge cases,
  both protocol state machines, auth/hashing, throttling, rate limits, session
  expiry, TLS/known-hosts suites, web API + GUI, agent enrollment/re-auth/e2e
  over real WebSockets, and a full Render deployment suite incl. `PORT`
  auto-detection, `/healthz`, static/SPA serving, and forwarded-IP rate limits).
- **Typecheck**: `npm run typecheck` clean.
- **Build**: `npm run build` clean (compiles all packages + bundles the web GUI
  to `web/dist/`).

## Architecture in brief

- `shared/` — framing (`protocol/framing.ts`), protocol constants/messages, TLS
  parsing (`tlsconfig.ts`), known-hosts parsing, device config.
- `server/` — TCP backend: config, auth, sessions, PTY (`pty.ts`) and SSH
  (`ssh-backend.ts`) terminal backends.
- `relay/` — protocol-aware bridge: `relay.ts`, `session.ts`; `ws-server.ts`
  (front door `/ws`, `/healthz`, static); `api.ts` (REST); `device-*` (agent
  enrollment/links); `http-sessions.ts`.
- `agent/` — PC + Android/Termux device agents (`relay-client.ts`,
  `pty-manager.ts`, `android/`).
- `cli/` — `termlink` command-line client.
- `web/` — browser GUI (xterm.js) built to `web/dist/`.
- `client/` — the TCP protocol client library used by the relay and CLI.

The wire protocol is a 4-byte big-endian length header + UTF-8/JSON body, with a
discriminated-union message set (`hello`, `auth_*`, `data`, `binary`,
`terminal_*`, `ping`/`pong`, `goodbye`), validated before processing and capped
at `MAX_FRAME_SIZE`.


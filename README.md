# TCP Relay — TCP Server, Client, Relay, and Interactive Terminal (PTY / SSH)

A production-oriented TCP relay system. **Phase 1** delivered the TCP server,
its protocol, authentication, and tests. **Phase 2** adds the TCP client.
**Phase 3** adds the relay: a protocol-aware bridge that authenticates client
sessions and forwards them to explicitly configured backend targets. **Phase 4**
adds the WebSocket front door and browser web client. **Phase 5** adds the
interactive terminal backend: each authenticated connection can spawn an
isolated PTY shell reachable interactively from the browser. **Phase 6** adds
transport security and production hardening: TLS on the browser→relay (WSS) and
relay→backend hops, authentication timeouts and rate limiting, session TTL,
secret-file credentials, a health endpoint and optional static web serving on
the front door, and production start scripts. **Phase 7** adds a second
terminal backend: each authenticated connection can instead open an interactive
shell on a trusted remote host over SSH, with mandatory host-key verification.
**Phase 8** adds the production web GUI: a logged-in browser application built on
the relay's WSS front door — device sidebar, session tabs with xterm.js,
per-session reconnect/disconnect handling, SSH/shell session creation via the
relay API, dark/light/system theming, and a responsive layout.
**Phase 9** adds the device agent: a separate, PC-only agent package that keeps
an authenticated, persistent **outbound** connection to the relay's `/device`
endpoint, so the browser can open isolated local shells on machines with no
inbound ports and no SSH daemon exposed.
**Phase 10** adds Android/Termux device agent support: running natively in Termux
on Android devices with CPU wake-lock management (`termux-wake-lock`), Termux-native
shell resolution (`/data/data/com.termux/files/usr/bin/bash`), `📱` GUI indicators,
and secure file permissions (`0600`).
**Phase 11** completes production deployment readiness and final system audit: Render-compatible
relay deployment, production start/build commands, `/healthz` health checks, graceful
SIGTERM/SIGINT shutdown, L7 WebSocket proxy compatibility (`X-Forwarded-For`, `X-Forwarded-Proto`),
static web serving, secure production defaults, and complete setup documentation.

**Transport security is end-user-visible, but operator-configured.** TLS between
the browser and the relay (WSS) and between the relay and backend servers (TLS)
is on whenever you set the TLS variables; it is not on by default because it
needs certificates. The plaintext TCP client→relay and TCP client→server hops
remain optional and must be firewalled or tunneled. The server and relay warn at
startup whenever a hop is left unencrypted.

---

## Architecture

```
TCP client ──length-prefixed frames──▶ TCP Server
                                         ├─ protocol state machine (per connection)
                                         ├─ authentication (scrypt-hashed creds)
                                         └─ session registry

Browser ──Web GUI (Phase 8)──▶ WSS front door (RelayServer) ─▶ target (a TCP Server)
  │   xterm.js tabs, devices, sessions        ├─ http(s): /ws, /healthz, /api/*, static
  │   auth: web session token (HttpOnly)      ├─ authenticates the client against relay creds
  └── login/logout, devices, sessions ───────▶│    or the web session token
                                               ├─ routes WS by ?device= to the static target
                                               └─ authenticates to the target as a protocol client

TCP client ─▶ RelayServer ─▶ authorized target (a TCP Server)
                │   ├─ authenticates the client against relay creds
                │   └─ authenticates to the target as a normal protocol client
                └── RelaySession (one client ↔ one target)

Browser (GUI) ──WSS──▶ RelayServer /device ◀──WSS outbound── Device Agent
                │        - persistent authenticated device link
                └──────── - agent devices offer isolated local PTY shells
                            multiplexed per GUI session over that one link
```

A TCP Server runs one of two terminal backends: `node-pty` shells
(`PTY_ENABLED`) or SSH sessions to a static remote host (`SSH_ENABLED`, mutually
exclusive). Either way the backend appears to its clients as the same framed
terminal protocol (`terminal_input` / `terminal_output` / `terminal_resize`).

Responsibilities are kept separate:

- `shared/protocol/` — framing and message types (no auth/session logic)
- `server/config.ts` — environment parsing and validation
- `server/server.ts` — listen/accept/connection-limit/shutdown lifecycle
- `server/connection.ts` — per-socket reads/writes/timeouts/backpressure
- `server/protocol.ts` — deterministic server protocol state machine
- `server/auth.ts` — credential hashing and verification, secure IDs
- `server/sessions.ts` — authenticated session tracking and cleanup
- `client/config.ts` — client-side environment parsing/validation
- `client/protocol.ts` — deterministic client protocol state machine
- `client/transport.ts` — socket lifecycle, auth, reconnects, backpressure
- `relay/config.ts` — relay configuration, static targets, validation
- `relay/session.ts` — the bridge pairing one client with one backend
- `relay/relay.ts` — relay server: accept, authenticate, create sessions
- `relay/ws-server.ts` — WebSocket front door over HTTP(S): `/ws`, `/healthz`, static files
- `shared/tlsconfig.ts` — shared TLS environment parsing for server/client roles

Both peers share `shared/protocol/framing.ts`, so framing behavior is identical
on both sides and never duplicated.

## Protocol

### Framing

Each TCP frame is length-prefixed:

```text
+----------------------+-------------------------+
| 4-byte uint32 BE     | UTF-8 JSON payload      |
| payload length       |                         |
+----------------------+-------------------------+
```

The length is the byte count of the UTF-8 payload. The decoder handles partial
headers, partial payloads, multiple frames per read, and frames split across
reads. It enforces a maximum frame size and never allocates based on an
unvalidated length field. There are no magic bytes.

### Messages (discriminated union on `type`)

**Server → Client:** `hello`, `auth_ok`, `auth_fail`, `data`, `binary`, `terminal_output`, `pong`, `goodbye`

**Client → Server:** `auth_request`, `data`, `binary`, `terminal_input`, `terminal_resize`, `ping`, `goodbye`

```jsonc
// S→C on connect
{ "type": "hello", "version": 1, "auth_methods": ["token", "password"] }

// C→S
{ "type": "auth_request", "method": "token", "token": "..." }
{ "type": "auth_request", "method": "password", "username": "...", "password": "..." }

// S→C
{ "type": "auth_ok", "session_id": "..." }
{ "type": "auth_fail", "reason": "..." }

// Bidirectional application data after auth
{ "type": "data", "data": "..." }
{ "type": "binary", "data": "<base64>" }   // arbitrary bytes

// Interactive terminal (PTY backend), after auth
{ "type": "terminal_input", "data": "<base64>" }        // C→S stdin bytes
{ "type": "terminal_output", "data": "<base64>" }       // S→C stdout/stderr bytes
{ "type": "terminal_resize", "cols": 80, "rows": 24 }   // C→S winsize change

// Keepalive
{ "type": "ping" }   // → { "type": "pong" }

// Clean close
{ "type": "goodbye", "reason": "..." }
```

`binary` carries arbitrary bytes base64-encoded, so the data path is not
text-only; it is limited in size only by the frame size cap.

Incoming JSON is validated against the schema before processing; malformed or
out-of-state messages terminate the connection.

### State machine

```text
connecting
    ↓
authenticating        (hello sent)
    ↓
ready                (on successful auth)
    ↓
closing
```

Before authentication only `auth_request` is valid. After it, `data`, `ping`,
and `goodbye` become available. Invalid sequences are rejected.

## Authentication

Two methods, both verified against **scrypt-hashed** credentials (never raw):

- **Token** — `AUTH_TOKENS`
- **Password** — `PASSWORD_USERS` (`username:password` comma-separated)

Credentials can be supplied inline or read from mounted secret files
(`AUTH_TOKENS_FILE` / `PASSWORD_USERS_FILE`); the file form wins when both are
present and the values are never logged.

Comparisons use constant-time `timingSafeEqual`. Session/connection IDs come
from `crypto.randomBytes`. Failed attempts are throttled per connection
(`MAX_AUTH_ATTEMPTS`, `AUTH_BACKOFF_MS`), and a global connection cap
(`MAX_CONNECTIONS`) prevents trivially bypassing throttling with unlimited
connections.

Additional hardening, applied by both the TCP server and the relay:

- **`AUTH_TIMEOUT_MS`** — a deadline for reaching `ready`. Unauthenticated
  sockets are ended with an "Authentication timed out" goodbye (0 disables).
- **`AUTH_RATE_LIMIT` / `AUTH_PER_IP_RATE_LIMIT`** — fixed-window rate limits on
  authentication attempts, globally and per remote address, tracked
  independently from the per-connection backoff. `AUTH_RATE_WINDOW_MS` sets the
  window; 0 disables either limit. Denied attempts get an immediate `auth_fail`
  and never touch a PTY or session.
- **`SESSION_TTL_MS`** — authenticated sessions expire after this age and are
  torn down with a "Session expired" goodbye (0 = live until disconnect).

Passwords, tokens, and session secrets are never logged.

## Transport security (TLS)

TLS is configured per hop with environment variables. Three dependent roles:

| Role | Component | Enables | Requires |
|------|-----------|---------|----------|
| Server | `server` | TCP listener speaks TLS | `TLS_CERT(_FILE)` + `TLS_KEY(_FILE)` |
| Server | `relay` WSS front door | WebSocket serves HTTPS/WSS | `TLS_CERT(_FILE)` + `TLS_KEY(_FILE)` |
| Client | `relay` → backend | relay dials backends over TLS | `TLS_CA(_FILE)` (the backend's CA) |

Each role turns on when `TLS_ENABLED=true`. Secrets are either inline PEM
(`TLS_CERT` / `TLS_KEY` / `TLS_CA`) or file paths (`TLS_CERT_FILE` / `TLS_KEY_FILE`
/ `TLS_CA_FILE`); the file form wins and is the recommended way to mount
certificates. A component refuses to start if TLS is enabled without the
material its role requires.

The relay's single `TLS_ENABLED` flag drives both its roles, so a WSS relay
must set **both** the server material (`TLS_CERT`/`TLS_KEY` for the front door)
and the client material (`TLS_CA` for verifying backends). Client-side controls:
`TLS_SERVER_NAME` (hostname to verify against the backend cert's SAN; used as
SNI), `TLS_REJECT_UNAUTHORIZED` (default `true`), and optional
`TLS_CLIENT_CERT(_FILE)` / `TLS_CLIENT_KEY(_FILE)` for mutual TLS to the
backend.

The `client` package, which the relay uses as a library, supports the same TLS
options; the plain `SERVER_HOST` path stays clear-text unless you set them (its
direct TCP connections are an operator-controlled network hop).

### Example (real deployment)

```bash
# Backend server (TLS listener, PTY shells)
PTY_ENABLED=true AUTH_TOKENS=backendtok TLS_ENABLED=true \
  TLS_CERT_FILE=/etc/tls/server-cert.pem TLS_KEY_FILE=/etc/tls/server-key.pem \
  npm start

# Relay: WSS for browsers + TLS to the backend
RELAY_PORT=19000 WS_ENABLED=true AUTH_TOKENS=relaytok \
  TARGETS=pty=backendtok@127.0.0.1:9000 \
  TLS_ENABLED=true \
  TLS_CERT_FILE=/etc/tls/server-cert.pem TLS_KEY_FILE=/etc/tls/server-key.pem \
  TLS_CA_FILE=/etc/tls/ca-cert.pem TLS_SERVER_NAME=localhost \
  npm run start:relay
```

Browsers then connect to `wss://relay-host:19001/ws` and must trust the relay's
CA. (The Node client uses the same `TLS_CA`/`TLS_SERVER_NAME` env vars.)

### Front-door HTTP surface

The relay's HTTP(S) front door provides, on top of the WebSocket endpoint:

- `GET /ws` — WebSocket upgrade (constant `WS_PATH` default).
- `GET /healthz` — liveness/`status: "ok"`, uptime, and connection counts.
- `GET|POST /api/...` — the Phase 8 web API (below).
- Static files — set `WS_STATIC_DIR` (or `WEB_STATIC_DIR`) to a directory to
  serve the browser bundle, with a MIME map and a path-traversal guard that
  refuses any resolved path outside the root with `403`.

### Web API (`/api`)

The GUI is a capability-based client: it can only create/close sessions the
relay already knows how to serve. Backend addresses and credentials never leave
the relay. All endpoints return JSON; authenticated calls use a web session
token (returned by `login`, also set as an HttpOnly cookie `termlink_sid`).

- `POST /api/auth/login` — body `{ "token": "…" }` or `{ "username", "password" }`
  (same credential store as the WS front door). Returns `{ user, session: { token } }`
  and sets the session cookie. Logins are throttled (20 attempts / 10 min / IP).
- `GET /api/auth/session` — current `{ user }` or `401`.
- `POST /api/auth/logout` — invalidates the web session.
- `GET /api/devices` — `{ devices: [{ id, name, type, online, latencyMs }] }`.
  One device per configured target **and** per pre-authorized agent device
  (`DEVICES`); `online` is a relay-side TCP reachability probe for static
  targets (never exposes host/port to the browser) and actual link-presence for
  agent devices.
- `GET /api/sessions` — the caller's GUI sessions
  (`[{ id, deviceId, deviceName, type, state, createdAt, … }]`).
- `POST /api/devices/:id/sessions` — body `{ "type": "shell" | "ssh" }`, must
  match the device's configured type. Agent devices are rejected with
  `409 Device offline` while disconnected. Returns
  `{ session, connect: { path } }` where `connect.path` is the
  `/ws?device=…&type=…&session=…` endpoint.
- `DELETE /api/sessions/:id` — close a GUI session you own (tears down its
  terminal if one is attached).

GUI sessions model the whole life of a terminal tab: `creating → connecting →
connected → disconnected → (re)connecting → closed`. The relay GCs stale ones
(kept 60s mid-create, 60s disconnected, purged after 30 min closed). WebSockets
attach to a session by id and by authenticated user; a user cannot attach to or
close another user's session.

### WS origin allow-list

`WS_ALLOWED_ORIGINS` is a comma-separated list of `Origin` values accepted by
the front door. An empty list means **any** origin is accepted and the relay
logs a startup *warning* telling you to set it in production; setting it makes
unlisted origins rejected with a connection close. This is a browser-side
mitigation (it stops cross-site scripted clients), not an authentication
boundary — tokens still gate the session.

## Server configuration

All server configuration comes from environment variables (see `.env.example`):

| Variable | Default | Purpose |
|----------|---------|---------|
| `HOST` | `127.0.0.1` | Bind address |
| `PORT` | `9000` | Listen port |
| `PROTOCOL_VERSION` | `1` | Negotiated protocol version |
| `MAX_FRAME_SIZE` | `1048576` | Max payload bytes (≤ 64 MB) |
| `MAX_CONNECTIONS` | `100` | Max concurrent connections |
| `IDLE_TIMEOUT_MS` | `30000` | Idle connection timeout |
| `MAX_AUTH_ATTEMPTS` | `5` | Failed attempts before throttling |
| `AUTH_BACKOFF_MS` | `1000` | Base backoff for auth throttling |
| `AUTH_TOKENS` | *(none)* | Space-separated pre-shared tokens |
| `AUTH_TOKENS_FILE` | *(none)* | Load tokens from a file (overrides `AUTH_TOKENS`) |
| `PASSWORD_USERS` | *(none)* | `username:password` comma-separated |
| `PASSWORD_USERS_FILE` | *(none)* | Load password users from a file |
| `AUTH_TIMEOUT_MS` | `10000` | Deadline to authenticate (0 disables) |
| `AUTH_RATE_LIMIT` | `0` | Global auth attempts per window (0 disables) |
| `AUTH_PER_IP_RATE_LIMIT` | `0` | Auth attempts per remote address per window (0 disables) |
| `AUTH_RATE_WINDOW_MS` | `60000` | Window for the two rate limits |
| `SESSION_TTL_MS` | `0` | Authenticated session max age (0 = until disconnect) |
| `ECHO_DATA` | `false` | Echo received `data` frames back (demo/tests) |
| `TLS_ENABLED` | `false` | Serve TLS on the TCP listener |
| `TLS_CERT` / `TLS_CERT_FILE` | *(none)* | PEM certificate (inline or file, file wins) |
| `TLS_KEY` / `TLS_KEY_FILE` | *(none)* | PEM private key (inline or file, file wins) |
| `TLS_CA` / `TLS_CA_FILE` | *(none)* | Optional CA chain for verifying peer certs |
| `PTY_ENABLED` | `false` | Spawn an interactive PTY shell per connection |
| `PTY_SHELL` | `$SHELL` / `/bin/sh` | Shell executable (trusted config only) |
| `PTY_COLS` / `PTY_ROWS` | `80` / `24` | Initial terminal size (1–1000) |
| `PTY_CWD` | `$HOME` | Working directory for spawned shells |
| `SSH_ENABLED` | `false` | Open an interactive SSH shell per connection (exclusive with `PTY_ENABLED`) |
| `SSH_HOST` | *(none)* | Remote SSH host (required; trusted static config) |
| `SSH_PORT` | `22` | Remote SSH port (1–65535) |
| `SSH_USERNAME` | *(none)* | SSH username (required) |
| `SSH_PASSWORD` / `SSH_PASSWORD_FILE` | *(none)* | SSH password (file wins) |
| `SSH_PRIVATE_KEY` / `SSH_PRIVATE_KEY_FILE` | *(none)* | SSH private key (PEM/OpenSSH, file wins) |
| `SSH_PASSPHRASE` | *(none)* | Passphrase for an encrypted private key |
| `SSH_CONNECT_TIMEOUT_MS` | `15000` | SSH handshake deadline |
| `SSH_COLS` / `SSH_ROWS` | `80` / `24` | Remote pty size (1–1000) |
| `SSH_TERM` | `xterm-256color` | `$TERM` requested for the remote pty |
| `SSH_KNOWN_HOSTS_FILE` | *(none)* | OpenSSH known_hosts file for host-key verification |
| `SSH_HOST_KEY_FINGERPRINTS` | *(none)* | Allowed host-key SHA-256 digests (bare or `SHA256:` prefix) |
| `SSH_INSECURE_HOST_KEY_CHECK` | `false` | Skip host-key verification (explicit opt-in; startup warning) |

The server refuses to start if configuration is invalid (bad ports, no
credentials, oversized frame limits, unsupported protocol version).

## Client configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `SERVER_HOST` (=`HOST`) | `127.0.0.1` | Server address |
| `SERVER_PORT` (=`PORT`) | `9000` | Server port |
| `AUTH_TOKEN` | *(none)* | Pre-shared token for `token` auth |
| `USERNAME` / `PASSWORD` | *(none)* | Credentials for `password` auth |
| `CONNECT_TIMEOUT_MS` | `10000` | TCP connect timeout |
| `CLIENT_IDLE_TIMEOUT_MS` (=`IDLE_TIMEOUT_MS`) | `60000` | Idle socket timeout |
| `CLIENT_MAX_FRAME_SIZE` (=`MAX_FRAME_SIZE`) | `1048576` | Max frame size |
| `RECONNECT` | `true` | Auto-reconnect on disconnect |
| `RECONNECT_DELAY_MS` | `1000` | Delay between attempts |
| `MAX_RECONNECT_ATTEMPTS` | `5` | Reconnect cap before giving up |
| `TLS_ENABLED` | `false` | Connect to the server over TLS |
| `TLS_CA` / `TLS_CA_FILE` | *(none)* | PEM CA (inline or file) to verify the server |
| `TLS_SERVER_NAME` | *(none)* | Hostname to verify against the server cert (SNI) |
| `TLS_REJECT_UNAUTHORIZED` | `true` | Certificate verification (false = insecure) |
| `TLS_CLIENT_CERT` / `TLS_CLIENT_CERT_FILE` | *(none)* | Optional mutual-TLS client cert |
| `TLS_CLIENT_KEY` / `TLS_CLIENT_KEY_FILE` | *(none)* | Optional mutual-TLS client key |

The client reuses the shared frame encoder/decoder, so read/write behavior on
both sides is identical.

## Relay

The relay is a **protocol-aware bridge**, not a raw TCP proxy. Both halves of
every relayed session speak the framed protocol and both must independently
reach `ready` before any data is forwarded:

```text
Client ─◀▶ RelayClient (auth ≿ relay creds)  ─┐
                                              ├─ RelaySession bridge
Backend ─◀▶ TcpClient (auth ≿ target creds)  ─┘
```

- The client authenticates to the relay with the relay's own credentials.
- The relay authenticates to the target as a normal protocol client (per-target
  credentials), using the same `TcpClient` the interactive client uses.
- Nothing is forwarded until **both** halves are authenticated. Data the client
  sends while the backend is still connecting is buffered (bounded) and flushed
  when the backend reaches `ready`.
- If backend authentication fails, the relay tears the whole client session down
  cleanly instead of leaving a half-connected session.
- Backpressure is applied at the frame level across the bridge; no raw
  socket-to-socket piping.
- Clients can only reach **statically configured targets** — the relay never
  dials an arbitrary host:port, so it is not an open proxy.

### Relay configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `RELAY_HOST` (=`HOST`) | `127.0.0.1` | Relay bind address |
| `RELAY_PORT` (=`PORT`) | `9000` | Relay listen port |
| `AUTH_TOKENS` | *(none)* | Tokens clients must present to the relay |
| `PASSWORD_USERS` | *(none)* | Client password credentials |
| `TARGETS` | *(none)* | Comma-separated `[id]|[Name]|[type=][creds@]host:port` list |
| `DEVICES` | *(none)* | Comma-separated pre-authorized agent devices `id|Name|type[|enrollmentToken]` (Phase 9) |
| `MAX_CONNECTIONS` | `100` | Max concurrent client connections |
| `MAX_FRAME_SIZE` | `1048576` | Frame size cap shared with targets |
| `IDLE_TIMEOUT_MS` | `30000` | Idle session timeout |
| `AUTH_TIMEOUT_MS` | `10000` | Deadline to authenticate (0 disables) |
| `AUTH_RATE_LIMIT` | `0` | Global auth attempts per window (0 disables) |
| `AUTH_PER_IP_RATE_LIMIT` | `0` | Auth attempts per remote address per window (0 disables) |
| `AUTH_RATE_WINDOW_MS` | `60000` | Window for the two rate limits |
| `SESSION_TTL_MS` | `0` | Relay session max age (0 = until disconnect) |
| `TLS_ENABLED` | `false` | WSS front door + relay→backend TLS (see TLS section) |
| `TLS_CERT_FILE` / `TLS_CERT` | *(none)* | PEM cert for the WSS front door |
| `TLS_KEY_FILE` / `TLS_KEY` | *(none)* | PEM key for the WSS front door |
| `TLS_CA_FILE` / `TLS_CA` | *(none)* | CA verifying backend certificates |
| `TLS_SERVER_NAME` | *(none)* | Hostname to verify against backend certs (SNI) |
| `TLS_REJECT_UNAUTHORIZED` | `true` | Certificate verification (false = insecure) |
| `WS_ENABLED` | `false` | Enable the WebSocket front door |
| `WS_HOST` (=`HOST`) | `127.0.0.1` | Front-door bind address |
| `WS_PORT` | `19001` | Front-door listen port (≠ `RELAY_PORT`) |
| `WS_MAX_CONNECTIONS` | `MAX_CONNECTIONS` | Max concurrent WS clients |
| `WS_MAX_MESSAGE_SIZE` | `MAX_FRAME_SIZE` | Max WS message bytes |
| `WS_IDLE_TIMEOUT_MS` | `IDLE_TIMEOUT_MS` | Idle WS connection timeout |
| `WS_ALLOWED_ORIGINS` | *(empty = any)* | Comma-separated allowed `Origin` values |
| `WS_STATIC_DIR` (=`WEB_STATIC_DIR`) | *(none)* | Serve static web files from this directory |
| `WS_AUTH_TIMEOUT_MS` | `10000` | Front-door auth deadline (0 disables) |

The relay refuses to start without at least one target and at least one client
credential.

A target may carry its own backend credential, written as a `creds@` prefix on
the target: `targetId=backendtok@host:port` for a token or
`targetId=user:pass@host:port` for username/password. These are the relay →
backend credentials only; they are never sent to or parsed by clients, so
browser users can never read them. Credentials must not contain `@`, and token
credentials must not contain `:`.

### Target metadata (Phase 8)

Each target can carry browser-facing metadata so the GUI can present a real
device list. The grammar is additive and backward-compatible:

```text
[id]|[Display Name]|type=[creds@]host:port
```

- `[id]` — the target id (as before; required).
- `[Display Name]` — a human-readable device name shown to browsers (optional;
  omitted or empty falls back to the id).
- `type=` — the terminal type this device offers, `shell` (a PTY backend) or
  `ssh` (an SSH backend); optional, defaults to `shell`. The configured type
  must match what the backend actually runs, and browsers cannot request a type
  the device does not offer.

Examples:

```text
TARGETS=desktop|Workstation|shell=backendtok@127.0.0.1:9000,deploy|Prod bastion|ssh=ops@10.0.0.5:22
# legacy forms still parse:
TARGETS=pty=backendtok@127.0.0.1:9000
TARGETS=desktop|backendtok@127.0.0.1:9000
```

The relay validates metadata at startup (unknown types, empty names, malformed
segments, duplicate ids are rejected). A WebSocket may select a target by id via
`/ws?device=<id>&type=<type>`; the all-legacy form (no `device`) still routes to
the first target, so existing clients are unaffected.

### Relay lifecycle example

```bash
# Terminal 1 — an authorized target (any protocol server)
AUTH_TOKENS=backendtok npm run dev

# Terminal 2 — the relay
RELAY_PORT=19000 AUTH_TOKENS=relaytok TARGETS=pty=backendtok@127.0.0.1:9000 npm run dev:relay

# Terminal 3 — a client pointed at the relay
SERVER_PORT=19000 AUTH_TOKEN=relaytok npm run dev:client
```

Production runs use the built artifacts instead of `tsx`:
`npm start` (server) and `npm run start:relay` (relay) after `npm run build`.
Both respond to `SIGTERM`/`SIGINT` with a graceful shutdown.

## Interactive terminal (PTY backend)

When `PTY_ENABLED=true`, every authenticated server connection gets its own
isolated PTY process (via `node-pty`) running the configured shell, byte-exact
in both directions:

```text
Browser ──xterm.js──▶ WebSocket ──▶ Relay front door ──▶ TCP ──▶ Server ──▶ PTY ──▶ shell
             terminal_input / resize           terminal_output ◀──────────────────────┘
```

- **One PTY per connection.** A fresh shell is spawned after authentication and
  torn down on disconnect; reconnects get a new connection and a new shell —
  never a shared or duplicated PTY.
- **Config-only shell.** The executable path comes solely from `PTY_SHELL`
  (trusted server configuration). Clients never supply a command or path.
- **Byte-exact and binary-safe.** PTY output is decoded byte-exactly (`latin1`)
  and streamed base64; input is written as raw bytes. Terminal escape codes and
  multi-byte UTF-8 survive round trips.
- **Bounded output.** PTY output is chunked to respect `MAX_FRAME_SIZE`, and the
  relay backpressure/Buffering stays in place across the browser hop.
- **Cleanup guarantees.** A shell that exits (or a failed spawn) ends the
  connection gracefully; disconnect and server shutdown kill the PTY and its
  process group, so no orphaned children survive.
- **No secrets in the child env.** Shells get a safe, allow-listed environment —
  server tokens and target credentials are never inherited.
- Controlled via `terminal_input` / `terminal_output` / `terminal_resize`
  protocol messages. `binary` frames instead carry arbitrary non-terminal bytes
  and are untouched by the PTY path.

The browser client connects to the relay's WebSocket front door (`/ws`) using
the relay's client credentials and gets a live terminal:

```bash
# Terminal 1 — the PTY backend server
PTY_ENABLED=true PTY_SHELL=/bin/bash AUTH_TOKENS=backendtok npm run dev

# Terminal 2 — the relay with a WebSocket front door
RELAY_PORT=19000 AUTH_TOKENS=relaytok TARGETS=pty=backendtok@127.0.0.1:9000 npm run dev:relay
```

Point a browser at the relay's front door and connect with the relay token. With
TLS configured the front door serves WSS and (optionally) the static bundle and
`/healthz`, so a browser needs only the relay's hostname and CA to reach the
shell. Add `WS_STATIC_DIR=web` (after a `npm run build`) to serve the bundle:
`https://relay-host:19001/`.

## Interactive terminal (SSH backend)

When `SSH_ENABLED=true`, every authenticated server connection opens its own
interactive shell on a trusted remote host over SSH (`ssh2`), instead of a
local PTY. `PTY_ENABLED` and `SSH_ENABLED` are mutually exclusive.

```text
Browser ──xterm.js──▶ WebSocket ──▶ Relay front door ──▶ TCP ──▶ Server ──▶ SSH ──▶ remote shell
             terminal_input / resize          terminal_output (stdout + stderr) ◀────────────┘
```

- **Static trusted target.** The host, port, username, credentials, and host-key
  trust anchors come only from server configuration. Clients can never choose or
  influence the SSH endpoint, user, or command; only an interactive `shell` is
  opened (`exec`/arbitrary commands are not supported).
- **Credentials.** Password (`SSH_PASSWORD` / `SSH_PASSWORD_FILE`) or private key
  (`SSH_PRIVATE_KEY` / `SSH_PRIVATE_KEY_FILE`, with optional `SSH_PASSPHRASE`).
  Private keys are validated at startup via `ssh2`'s parser — a malformed or
  passphrase-missing key aborts launch.
- **Host-key verification (secure by default).** You MUST configure
  `SSH_KNOWN_HOSTS_FILE` (OpenSSH format: globs, `[host]:port`, hashed entries),
  `SSH_HOST_KEY_FINGERPRINTS` (`ssh-keygen -E sha256 -lf` style digests), or
  explicitly set `SSH_INSECURE_HOST_KEY_CHECK=true` (startup warning). Unknown
  hosts and key mismatches abort the connection before any traffic is sent.
- **Streaming.** stdout and stderr are merged into `terminal_output` (base64,
  chunked to `MAX_FRAME_SIZE`); input is written byte-exact to the shell;
  `terminal_resize` is forwarded as a remote pty window change. Session-display
  size is `SSH_COLS`/`SSH_ROWS`.
- **Failure surfacing.** Connect/auth/host-key failures produce a clean goodbye
  (e.g. `SSH authentication failed`, `SSH host key verification failed`,
  `SSH connection timed out`) rather than a silent hang, and propagate across
  the relay to the browser.
- **Cleanup guarantees.** If the remote host or shell ends the channel, the
  client session is closed gracefully. Disconnect and server shutdown tear the
  session down (ssh2 `keepalive` every 15s detects dead peers).

```bash
# Terminal 1 — the SSH backend server (fingerprint mode)
SSH_ENABLED=true SSH_HOST=bastion SSH_USERNAME=deploy SSH_PASSWORD=... \
SSH_HOST_KEY_FINGERPRINTS=SHA256:... AUTH_TOKENS=backendtok npm run dev

# Terminal 2 — the relay with a WebSocket front door
RELAY_PORT=19000 AUTH_TOKENS=relaytok TARGETS=pty=backendtok@127.0.0.1:9000 npm run dev:relay
```

## Web GUI (Phase 8)

The web client is a full browser application served by the front door
(`WS_STATIC_DIR=web` after `npm run build`). It replaces the bare token form with
a login screen, a device sidebar, session tabs, and xterm.js terminals.

```text
Browser (GUI) ─▶ POST /api/auth/login ─▶ web session token (HttpOnly cookie + bearer)
   │  GET /api/devices, GET|POST|DELETE /api/sessions
   └─▶ /ws?device=<id>&type=<type>&session=<guiSessionId>  (token = web session token)
```

Features:

- **Login screen** with token or `username`/`password` sign-in; sessions persist
  across reloads (`sessionStorage` token + server cookie).
- **App shell**: responsive layout (sidebar drawer under 720 px), a device
  sidebar with online/offline reachability and per-device `shell`/`ssh` badges,
  and a “New session” flow that only offers the types each device supports.
- **Session tabs**: open multiple terminals side by side — PTY/local-shell and
  SSH sessions alike (the relay picks the backend from the requested device).
  Each tab shows connecting / connected / disconnected state and a close button.
- **Terminal workspace** with xterm.js: input, resize, scrollback, and a status
  bar with the active session's state and measured RTT (ping/pong).
- **Reconnect/disconnect handling**: each session reconnects with bounded
  backoff, exposes `reconnecting`/`disconnected` states with a reason, lets you
  manually re-attach a session, and shows backend errors (e.g. an SSH auth
  failure) in the terminal area and status bar.
- **Themes** (dark / light / system), persisted via localStorage, applied as a
  `data-theme` attribute consumed by CSS variables.
- **Security posture**: the browser only ever knows the relay's public origin
  and its own web session token. Backend addresses, relay tokens, TLS keys, and
  SSH credentials stay in relay/server configuration. GUI sessions are scoped to
  the owning user, and the front door validates every `device`/`type`/`session`
  against static config before upgrading.

The GUI and existing WS clients coexist: unselected `/ws` connections still
route to the first configured target with plain relay credentials.

## Device agent (Phase 9)

The device agent gives the GUI secure, isolated shells on machines that allow no
inbound connections. Instead of opening a port or running an SSH daemon, the
machine runs `agent/` — a small process that keeps **one persistent outbound**
WSS connection (`/device`) to the relay. Agent devices must be pre-authorized in
the relay's `DEVICES` config; the relay initiates nothing and browsers never
talk to the device directly, so there is nothing exposed at the network edge.

```text
Browser (GUI) ─▶ POST /api/devices/<id>/sessions   device must be online
   │   └─▶ /ws?device=<id>&type=shell&session=<guiSessionId>
   ▼
Relay ──device link (multiplexed)──▶ Device Agent ──▶ local PTY shell
        one channel per GUI session                    (isolated, per session)
```

- **Enrollment.** On first connect the agent sends `device_register` and the
  relay replies `device_ok`, storing only an scrypt hash of the device-generated
  secret it must present on later connects (`device_auth`). Re-registration is
  refused once enrolled; an optional per-device enrollment token in `DEVICES`
  gates who may claim the id. The device secret lives in a `0600` file
  (`AGENT_CREDENTIALS_FILE`) and never leaves the machine.
- **Multiplexing.** Each GUI session becomes one channel over the single device
  link. The browser attaches via
  `/ws?device=<id>&type=shell&session=<guiSessionId>` using its own web session
  token. Output flows device→relay→browser, input the reverse, both with
  bounded buffering and drain on the same frame-level backpressure the rest of
  the system uses.
- **Isolation.** Every GUI session gets its own PTY process; browsers never
  share a shell, cannot pick the command, cwd, environment, or executable
  (`AGENT_SHELL` / `AGENT_CWD` come from trusted agent config only), and cannot
  read the device secret. Closing the browser tab or the session (or the device
  agent exiting) tears the PTY down with no orphaned children.
- **Resilience.** The agent reconnects with bounded exponential backoff, pings
  to keep the relay's `online`/`latencyMs` fresh, and treats permanent failures
  (bad secret, refused enrollment, protocol errors) as fatal instead of
  hammering the relay. The relay refuses to create sessions for a device that is
  offline (`409 Device offline`).
- **Security posture.** The device holds the lowest standing secret and only
  ever dials out over TLS. Browser access still requires the relay's web
  sessions, rate limits, and origin policy — the device link itself never
  accepts inbound traffic.

### Device agent configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `RELAY_URL` | *(none, required)* | `ws://` or `wss://` relay origin, `/device` appended |
| `AGENT_DEVICE_ID` | *(none, required)* | Device id as pre-authorized in `DEVICES` |
| `AGENT_ENROLLMENT_TOKEN` | *(none)* | Echo back when the relay configured one |
| `AGENT_CREDENTIALS_FILE` | *(required)* | Device identity file, written `0600` on first enrollment |
| `AGENT_SHELL` | `$SHELL` | Shell executable (trusted config only) |
| `AGENT_CWD` | `$HOME` | Working directory for spawned shells |
| `AGENT_PING_INTERVAL_MS` | `20000` | Heartbeat to refresh the relay's last-seen |
| `AGENT_IDLE_TIMEOUT_MS` | `90000` | Drop the link if no relay traffic in this window |
| `AGENT_RECONNECT_MIN_MS` / `AGENT_RECONNECT_MAX_MS` | `500` / `30000` | Bounded exponential reconnect backoff |

### Running an agent device (PC)

On the relay (`DEVICES` must contain the agent device):

```bash
AUTH_TOKENS=relaytok WS_ENABLED=true DEVICES='laptop|Alice laptop|shell|tok-abc' \
  npm run dev:relay
```

On the device itself (only an outbound connection is required):

```bash
RELAY_URL=ws://relay-host:19001 AGENT_DEVICE_ID=laptop \
  AGENT_ENROLLMENT_TOKEN=tok-abc AGENT_CREDENTIALS_FILE=laptop.secret \
  npm run dev:agent
```

Production PC agent:
```bash
npm run build
RELAY_URL=wss://relay.example.com AGENT_DEVICE_ID=laptop \
  AGENT_ENROLLMENT_TOKEN=tok-abc AGENT_CREDENTIALS_FILE=/var/lib/agent/laptop.secret \
  npm run start:agent
```

### Android / Termux device agent (Phase 10)

The Android Device Agent runs inside Termux on Android devices. It acquires a CPU wake lock (`termux-wake-lock`) to maintain background WebSocket connection stability during Android Doze mode, auto-detects Termux shell binaries (`/data/data/com.termux/files/usr/bin/bash`), stores its enrollment secret in a `0600` file, and presents a `📱` icon in the Web GUI device list.

On the relay (`DEVICES` must configure the `android` device type):

```bash
AUTH_TOKENS=relaytok WS_ENABLED=true DEVICES='phone|Pixel 8|android|tok-xyz' \
  npm run dev:relay
```

On the Android device in Termux:

```bash
# Development / Termux
RELAY_URL=ws://relay-host:19001 AGENT_DEVICE_ID=phone \
  AGENT_ENROLLMENT_TOKEN=tok-xyz AGENT_CREDENTIALS_FILE=phone.secret \
  AGENT_WAKE_LOCK=true npm run dev:android-agent

# Production run after build
npm run build
RELAY_URL=wss://relay.example.com AGENT_DEVICE_ID=phone \
  AGENT_ENROLLMENT_TOKEN=tok-xyz AGENT_CREDENTIALS_FILE=/data/data/com.termux/files/home/phone.secret \
  AGENT_WAKE_LOCK=true npm run start:android-agent
```

## Production deployment (Phase 11)

### Build & Start commands

```bash
# Build the TypeScript packages and bundle the Web GUI
npm run build

# Start the TCP backend server (PTY or SSH)
npm start

# Start the Relay (TCP + WSS Front Door + Web GUI + REST API)
npm run start:relay

# Start the PC Device Agent
npm run start:agent

# Start the Android / Termux Device Agent
npm run start:android-agent
```

### Deploy to Render

This section walks through deploying the **relay** (with the Web GUI, REST API,
and WebSocket front door) as a single Render Web Service. Render terminates
TLS at its reverse proxy; the Node process itself runs plain HTTP/WS on the
port Render injects.

#### 1. Create the Render Web Service

1. In the Render dashboard click **New → Web Service**.
2. Connect your repository (a fresh clone of this project works — no manual
   source changes).
3. Set the **Name** to anything you like (this is never read by the code).
4. Set the following:
   - **Environment**: Node
   - **Build Command**: `npm install && npm run build`
   - **Start Command**: `node dist/relay/src/index.js`
   - **Health Check Path**: `/healthz`
5. Click **Create Web Service**.

Alternatively, use the included [`render.yaml`](render.yaml) blueprint:
Render reads it automatically and pre-fills the service name, build/start
commands, and health check.

#### 2. Required build/start commands

| Field | Value |
|-------|-------|
| Build Command | `npm install && npm run build` |
| Start Command | `node dist/relay/src/index.js` |
| Health Check Path | `/healthz` |

No deployment-specific wrappers are needed — these reuse the existing npm build
and start scripts.

#### 3. Required environment variables

Set these in the **Environment** tab of your Render Web Service:

| Variable | Required | Purpose |
|----------|----------|---------|
| `RENDER` | Yes | Set to `1`. Triggers auto-detection: WS front door binds Render's `PORT`, relay TCP binds an ephemeral port. |
| `AUTH_TOKENS` | Yes | Relay authentication token(s) that both the browser login and device agents present. Space-separated. |
| `DEVICES` | Yes* | Pre-authorized device agents, e.g. `laptop\|Workstation\|shell\|tok-abc,phone\|Pixel 8\|android\|tok-xyz` |
| `WS_ALLOWED_ORIGINS` | Yes | The Render service URL, e.g. `https://my-relay.onrender.com` (or a custom domain). Comma-separated for multiple. |

\* `DEVICES` is required if you are connecting device agents. If you are only
forwarding to a static `TARGETS` backend, set `TARGETS` instead.

| Variable | Default | Purpose |
|----------|---------|---------|
| `TARGETS` | *(none)* | Static backend targets for the relay, e.g. `desktop\|Workstation\|shell=backendtok@host:port` |
| `PASSWORD_USERS` | *(none)* | Optional `username:password` credentials for the browser login |
| `AUTH_PER_IP_RATE_LIMIT` | `0` | Recommended: throttle auth attempts per IP (e.g. `20`) |
| `AUTH_RATE_LIMIT` | `0` | Recommended: throttle global auth attempts (e.g. `50`) |
| `AUTH_RATE_WINDOW_MS` | `60000` | Window for `AUTH_RATE_*` limits |
| `SESSION_TTL_MS` | `0` | Max authenticated session lifetime (0 = until disconnect) |
| `WS_MAX_CONNECTIONS` | `100` | Max concurrent WebSocket connections |
| `MAX_FRAME_SIZE` | `1048576` | Max frame size in bytes |

Production secrets are set via Render's **Environment** tab (or **Secret
Files** for `*_FILE` variants). Never commit credentials to the repository.

#### 4. Generate strong authentication credentials

Generate a relay auth token:

```bash
openssl rand -hex 32
# or
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Optionally generate per-device enrollment tokens (one per device in `DEVICES`):

```bash
openssl rand -hex 16
```

#### 5. Configure DEVICES/TARGETS

The relay needs at least one of `DEVICES` (device agents) or `TARGETS`
(static backends) configured.

**Using device agents** (recommended — agents connect outbound, no inbound
ports needed on the device):

```env
DEVICES=laptop|Workstation|shell|tok-pc-1,phone|Pixel 8|android|tok-phone-1
```

Each entry is `id|Display Name|type[|enrollmentToken]`. `type` is `shell`
(PC/Termux) or `android`.

**Using static backends** (a TCP server running PTY or SSH):

```env
TARGETS=desktop|Workstation|shell=backendtok@192.168.1.10:9000
```

#### 6. Connect the PC agent

On the target machine (no inbound ports required):

```bash
npm install
npm run build
RELAY_URL=wss://my-relay.onrender.com \
  AGENT_DEVICE_ID=laptop \
  AGENT_ENROLLMENT_TOKEN=tok-pc-1 \
  AGENT_CREDENTIALS_FILE=/var/lib/termlink/laptop.secret \
  npm run start:agent
```

Required agent env vars for Render:

| Variable | Purpose |
|----------|---------|
| `RELAY_URL` | `wss://my-relay.onrender.com` (must be `wss://` in production) |
| `AGENT_DEVICE_ID` | Must match a `DEVICES` id on the relay |
| `AGENT_ENROLLMENT_TOKEN` | Echo the per-device token from `DEVICES` (only on first connect) |
| `AGENT_CREDENTIALS_FILE` | Path to a `0600` file the agent persists its secret in |

#### 7. Connect the Android / Termux agent

Inside Termux:

```bash
pkg install nodejs
npm install
npm run build
RELAY_URL=wss://my-relay.onrender.com \
  AGENT_DEVICE_ID=phone \
  AGENT_ENROLLMENT_TOKEN=tok-phone-1 \
  AGENT_CREDENTIALS_FILE=/data/data/com.termux/files/home/phone.secret \
  AGENT_WAKE_LOCK=true \
  npm run start:android-agent
```

The same required env vars as the PC agent, plus `AGENT_WAKE_LOCK=true` to
keep the WebSocket alive during Android Doze.

#### 8. Use the resulting Web GUI

Open `https://my-relay.onrender.com` in a browser. You will see the login
screen. Log in with `AUTH_TOKENS` (token) or `PASSWORD_USERS` (username +
password). The Web GUI is served from the same origin as the API and the
WebSocket endpoint, so no additional frontend service is needed.

#### 9. Health-check URL

`https://my-relay.onrender.com/healthz`

Returns `200 OK` with JSON:
`{ "status": "ok", "uptime": 120, "connections": 2, "maxConnections": 100 }`

#### 10. Important limitations

- **Web sessions are in-memory.** Restarting the Relay Web Service invalidates
  all browser login sessions. Users must log in again after a redeploy or
  restart.
- **Device enrollment is persistent** (scrypt-hashed on the relay), so device
  agents reconnect automatically after a relay restart without re-enrolling.
- **Relay TCP backend is internal-only.** The raw TCP listener binds to an
  ephemeral port (`RELAY_PORT=0`) and is not exposed publicly. All traffic
  enters through the public HTTP/WSS listener on Render's `PORT`.
- **Render requires billing** for persistent web services on the free tier;
  the service suspends when idle (any in-memory state is lost).

### Graceful shutdown & lifecycle

All components (`server`, `relay`, `agent`, `android-agent`) install process signal handlers for `SIGTERM` and `SIGINT`:
- Stop accepting new inbound connections.
- Flush in-flight frames and send `goodbye` frames.
- Dispose child PTY processes (`node-pty`) and end SSH streams.
- Unref active timers and exit with code `0`.
- Include a 10-second forced exit safeguard to ensure processes never hang on dead sockets.

## Local development

```bash
npm install

# Run tests
npm test

# Typecheck
npm run typecheck

# Run the server (echo mode on)
cp .env.example .env     # edit as needed
npm run dev

# In another terminal, run the interactive client
npm run dev:client
```

The client's TTY mode forwards each line you type as a `data` frame and prints
incoming `data` frames to stdout (Ctrl-D to quit).

Example raw interaction (using `node` for framing):

```bash
# authenticate with a token using a one-liner
node -e '
const net=require("net");
const c=net.connect(9000);
c.on("data",d=>{console.log("<-",d.toString())});
c.on("connect",()=>{
  const auth=JSON.stringify({type:"auth_request",method:"token",token:"my-secret-token-1"});
  const h=Buffer.alloc(4); h.writeUInt32BE(Buffer.byteLength(auth));
  c.write(Buffer.concat([h,Buffer.from(auth)]));
});
'
```

## Security limitations

- TLS protects the browser→relay (WSS) and relay→backend hop when configured.
  Plain TCP client hops (client→relay, client→server) carry credentials in
  plaintext and must be firewalled or tunneled; they still work for trusted
  networks.
- Password auth transmits username/password as a protocol message (no
  challenge-response); use token auth over WSS/TLS where feasible.
- `WS_ALLOWED_ORIGINS` guards against cross-site scripted clients only; it is
  not an authentication boundary.
- Per-IP rate limits key on the relay's direct peer address. Behind an L7
  reverse proxy that terminates TCP, every browser shares the proxy's address
  unless the proxy forwards the real client address.
- Reconnect is lost-data-best-effort: buffered frames are flushed after
  reauthentication, but anything in flight during a disconnect is dropped.
- The web GUI scopes sessions to users, but users share the relay credential
  store; treat `PASSWORD_USERS`/`AUTH_TOKENS` credentials shown on the login
  screen with the same care as anywhere else.
- Mounted secret files (`*_FILE`) are read once at process start; rotating
  credentials still requires a restart.
- The SSH backend forwards the server's SSH secrets to the configured remote
  host and gives each authenticated client a shell there — an authenticated
  client gains the server's SSH identity. Verify the remote host key (never run
  with `SSH_INSECURE_HOST_KEY_CHECK=true` in production) and treat the SSH
  credentials with the same care as the server's auth tokens.
- The device agent's enrollment window is the weak point: without an enrollment
  token any authorized agent that connects first wins. Set the optional 4th
  `DEVICES` segment on untrusted networks, and put the device's secret file
  somewhere only the agent user can read. The relay only ever knows the scrypt
  hash, so a relay compromise does not reveal device secrets.

## Tests

Coverage includes framing edge cases (partial/fragmented/oversized/malformed),
both protocol state machines, authentication and hashing, brute-force
throttling, connection limits, idle timeout, concurrent clients, cleanup after
disconnect, graceful shutdown, client reconnect/disconnect detection, partial
reads on the client, auth timeouts, per-IP auth rate limiting, session expiry,
and a full end-to-end lifecycle over a real TCP socket. TLS suites exercise TLS
on the TCP listener, WSS + relay→backend TLS round-trips through a real PTY,
hostname/CA-mismatch rejection, HTTPS `/healthz` and static-file traversal
protection, and origin allow-listing. Phase 8 adds the web API and GUI test
suites: relay `/api/*` endpoints (login/logout/session persistence, devices with
reachability, session CRUD and ownership), WS routing by `device`/`type`/`session`
with web-session-token authentication and cross-user isolation, plus DOM-free
browser tests for the API client, theme resolution, terminal-session
reconnect/disconnect/backend-error states, and the app controller's login,
device, session, and tab lifecycle. Phase 9 adds the device-agent suites:
enrollment/re-auth against a real relay (register, direct re-auth, permanent
failure on bad secret, refused re-registration, backoff reconnects,
heartbeats, graceful goodbye), config/secret-file handling, a real PTY management
test, and a full device e2e over real WebSockets (enrollment + device listing,
a shell round-trip through the relay, resizes, multi-session isolation, PTY
cleanup on browser close and on `DELETE`, offline rejection, rogue-agent denial,
and graceful shutdown).

## Compiling the web GUI

`npm run build` typechecks everything and bundles the web app (`web/src/index.ts`
→ `web/dist/bundle.js` + `bundle.css`). During development,
`npm run dev:web` serves the bundle from `web/` with live rebuilds. To serve the
GUI from the relay itself, set `WS_STATIC_DIR=web` and point a browser at the
front door origin (e.g. `http://relay-host:19001/` or the WSS host with TLS).

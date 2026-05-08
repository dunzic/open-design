# Plan — Multi-host runtime (类 multica 三层模型)

Status: Research complete, not started
Date: 2026-05-09
Scope: dunzic/open-design fork
Related custom requirements (existing): 001 (HTTP proxy env), 002 (system proxy detection)

## 0. Goal

Today the Open Design daemon is a single-host service: it binds 127.0.0.1,
has zero inbound authentication, and assumes "the user's filesystem ==
the daemon's filesystem." Web/desktop clients on the same machine talk
to it freely; nothing else can.

We want a runtime story closer to multica.ai's:

1. **Local runtime** — your machine, your daemon. Today's behavior.
2. **跨自己其他机器** — sign in on a second machine, that machine's
   daemon shows up under your account, and your web/desktop on either
   machine can target either runtime.
3. **跨用户共享** — invite another user to use one of your runtimes
   (or task pool) under a scoped credential.

This document is the research-to-plan handoff. Implementation work
gets split into per-step `custom/NNN-*.md` requirements once we
commit to a path.

## 1. Critical reframing — what multica actually does

Investigation of the multica-ai/multica repo, docs, and DeepWiki entries
shows their three-tier UX is **not** built on "daemon exposes inbound
HTTP to remote callers." Their daemon never accepts inbound. The model
is server-pulled:

- daemon initiates **outbound** HTTP/WS to a central server (Multica
  Cloud or self-hosted). The server is the source of truth.
- pairing: `multica login` issues a Personal Access Token (PAT). daemon
  generates a machine UUID at `~/.multica/daemon.id` and trades
  PAT + UUID for a workspace-scoped daemon token (`mdt_…`, 40 hex).
  Server stores only `sha256(token)` in a `daemon_token` table keyed
  by `(token_hash, workspace_id, daemon_id, expires_at)`.
- "your other machines" = repeat pairing on machine 2; both daemons
  appear in the workspace's Runtime panel.
- "shared with others" is **not** a primitive. Each runtime has an
  `owner_id`; only owner / workspace admin can delete it. What the
  workspace shares is the **task queue + skills library** — a task
  enqueued to the workspace can be claimed by any matching runtime,
  but no one logs into someone else's runtime directly.
- daemon's exposed primitives are deliberately narrow: spawn provider
  agent binaries (`claude`, `codex`, etc.), prepare a workdir,
  inject `CLAUDE.md` / `AGENTS.md` / skills, stream stdout back. No
  raw filesystem / shell / RPC.

The implication for us: copying the multica UX does **not** require
exposing our daemon's HTTP port. There's a real architectural choice
to make (Path A vs B below), and the user's mental model of "make
the daemon reachable" is one option, not the only one.

## 2. Current state — what blocks remote use today

Audit findings (file:line references), grouped by concern:

### 2.1 Network binding
- `apps/daemon/src/server.ts:1739` — `startServer({ host = process.env.OD_BIND_HOST || '127.0.0.1' })`
- `app.listen(port, host, …)` at `server.ts:6624`
- Already env-var driven; `0.0.0.0` is one env-var away. **Not the blocker.**

### 2.2 Origin / CORS
- `apps/daemon/src/origin-validation.ts:1750` — `isLocalSameOrigin()`
  hardcodes `^https?://(127\.0\.0\.1|localhost|\[::1\])$`.
- 16+ routes call it directly (e.g. `server.ts:1892, 1919, 1948, 2008,
  2022, 2047, 2098, 2172, 2193`). Replacing the function isn't
  enough — every call site needs to switch to an auth-based gate.
- `OD_ALLOWED_ORIGINS` env-var exists but is only consulted by the
  weaker `isAllowedBrowserOrigin()` path.

### 2.3 Authentication
- **None on inbound.** Daemon trusts whoever can reach the socket.
- `mcp-tokens.ts:27` stores Bearer tokens *for outbound MCP server
  calls only*.
- `parseBearerToken()` exists at `server.ts:1430` but only scopes
  tool access (`requestProjectOverride`, `requestRunOverride`), not
  HTTP authentication.

### 2.4 SSE / streaming
- `/api/runs/:id/events` at `server.ts:5902` → `createSseResponse()`
  at `server.ts:1674–1713`, plain `text/event-stream` on a TCP socket.
- No `X-Forwarded-For` parsing, no client-side reconnect with
  `Last-Event-ID`. Survives a flaky LAN connection poorly.

### 2.5 SQLite
- `apps/daemon/src/db.ts:28–40` opens `<projectRoot>/.od/app.sqlite`
  with WAL, single module-level `dbInstance`.
- Single-process safe; concurrent remote writers from a different
  daemon process are not in scope. NFS/SMB-mounted DB would be a
  corruption risk.

### 2.6 Filesystem assumptions
- Import Folder (`server.ts:2414–2436`) calls `realpath()` on user
  input and pins it as `metadata.baseDir`. Subsequent reads/writes
  for that project use `resolveSafe(…, metadata.baseDir)` (`server.ts:1797`).
- `apps/daemon/src/design-systems.ts` reads from `.od/design-systems/<id>/`.
- `apps/daemon/src/craft.ts` scans local skill directories.
- `apps/daemon/src/project-watchers.ts` uses chokidar on local paths.
- All four assume "the path the user named exists on the daemon's box."

### 2.7 Sidecar IPC
- `apps/daemon/src/sidecar/server.ts:137–138` listens on a Unix
  socket / Windows named pipe at `/tmp/open-design/ipc/<namespace>/<app>.sock`.
- No TLS, no auth. Desktop ↔ daemon is local-socket-only.

### 2.8 Namespace / identity
- `packages/sidecar/src/index.ts` — `namespace` is per-instance
  isolation on one box (parallel daemons, smoke runs).
- Database has no `owner_user_id` column; projects are UUID-keyed but
  not partitioned by user.

## 3. Two paths

### 3.1 Path A — "daemon-as-service, but properly authed"

Keep the daemon as the inbound HTTP/SSE server. Add the missing
security layer + multi-tenant identity + a tunneling story for users
who can't expose ports.

| Tier | Mapping in Path A |
|---|---|
| Local | unchanged — daemon on `127.0.0.1`, web/desktop on same box |
| 跨自己其他机器 | machine B's daemon paired to your account via PAT → `od_…` daemon token; web client on either machine connects via tunnel + token |
| 跨用户共享 | runtime owner mints a scoped share token (`ods_…`) with TTL + capability list (read-only / specific project / no shell); peer's web client uses it as bearer |

Pros:
- Incremental on the existing codebase.
- Daemon stays in charge of its own state — no central server to host.
- Self-hosting friendly.

Cons:
- Each user has to expose their daemon to peers (Tailscale Funnel /
  Cloudflare Tunnel / SSH reverse tunnel — we'd ship a wrapper).
- Filesystem features (Import Folder, design-systems, craft, watchers)
  remain "the daemon owns the fs"; remote peers can't mount their
  own `baseDir`. We'd disable Import Folder for non-owner sessions
  in v1, optionally proxy file ops in v2.
- No central audit, no marketplace, no billing hook.

Effort: **medium** — 2–4 focused weeks for v1 (single user, two
machines, one share token). Mostly mechanical refactor of 16+ routes
+ schema migration + a token-mint flow.

### 3.2 Path B — "central server brokers everything"

Mirror multica's structure. Introduce a new central service; daemon
becomes outbound-only.

| Tier | Mapping in Path B |
|---|---|
| Local | daemon runs on your machine, opens WS to central server |
| 跨自己其他机器 | each machine pairs to the same account; both visible in workspace runtime panel; tasks dispatched to either |
| 跨用户共享 | workspace shares **task queue + skills**, not the runtime itself |

Pros:
- UX identical to multica.
- Naturally handles audit, billing, marketplace, scheduled tasks.
- Daemon never needs an inbound port — works behind any NAT/firewall.

Cons:
- Architectural inversion: web client now talks to the central server,
  not the local daemon. Real-time features (SSE) get rerouted.
- Need to host (or self-host) a central service: Postgres,
  WebSocket broker, identity/billing surface.
- "Shared runtime" the way the user described it isn't even a thing
  in this model — it's task-pool sharing instead.
- Effectively a new product. Can't ship in a sprint.

Effort: **large** — multiple months; net-new service + client refactor.

## 4. Recommendation

Start with **Path A**. Reasons:

- Covers all three user-described tiers with reasonable approximations.
- Doesn't require running infrastructure.
- Path B remains open if we later need centralized audit/billing/marketplace.
- Failure mode is bounded: if Path A's auth proves too weak,
  hardening it (mTLS, OIDC, etc.) doesn't undo the schema work.

## 5. Path A milestones — implementation outline

Each milestone gets its own `custom/NNN-*.md` once we commit. The
filenames below reserve the slots in the existing serial.

### M1 — `custom/004-daemon-inbound-bearer-auth.md`
- New module: `apps/daemon/src/auth/inbound-token.ts`.
- New table: `daemon_tokens(id, hash, owner_user_id, machine_id,
  scope, capabilities_json, expires_at, revoked_at, created_at)`.
- Express middleware checks `Authorization: Bearer od_…` on every
  `/api/*` route except a small loopback-only allowlist (status,
  health, metric).
- Migration helper: when `OD_REQUIRE_AUTH=false` and request is
  loopback, allow request through (back-compat for local desktop).
- Tests: positive (valid token), negative (no token / expired /
  revoked / wrong scope), back-compat (loopback no-token still works
  when flag off).

### M2 — `custom/005-daemon-multi-tenant-schema.md`
- Migration: add `owner_user_id` (TEXT NOT NULL DEFAULT 'local')
  to `projects`, `runs`, `agents`, `artifacts`, `media_keys`, etc.
- Backfill: existing rows get `owner_user_id = 'local'`; new
  `users` table seeded with one row.
- Read/write helpers in `db.ts` always filter by request's
  `owner_user_id` (extracted from the token by M1 middleware).
- Tests: cross-tenant isolation, no leaks via list endpoints,
  `local` user behaves identically to today.

### M3 — `custom/006-origin-validation-replacement.md`
- Retire `isLocalSameOrigin()` per-route checks; the auth middleware
  is now the gate.
- Keep `isAllowedBrowserOrigin()` for the cookie-based browser web
  surface; harden `OD_ALLOWED_ORIGINS` parsing.
- Update all 16+ route call sites identified in §2.2.
- Tests: rewrite `origin-validation.test.ts`, `server-cors.test.ts`.

### M4 — `custom/007-pairing-cli.md`
- New CLI subcommand on the `od` bin: `od login` (browser-based PAT
  retrieval), `od pair --token <PAT>` (mints a daemon token),
  `od tokens list` / `revoke`.
- `~/.open-design/identity.json` stores the active token + machine
  UUID (analogous to `~/.multica/daemon.id`).
- Tests: pairing happy path, revoke takes effect on next request.

### M5 — `custom/008-tunnel-wrapper.md`
- New CLI subcommand: `od tunnel start [--cloudflare | --tailscale]`.
- Wraps existing tunnel CLIs; we don't reinvent transport.
- Outputs a public URL the peer pastes into their web client.
- Optional: ship a small daemon-side acceptor that limits accept rate
  / refuses requests with no bearer.

### M6 — `custom/009-share-tokens.md`
- New endpoint: `POST /api/shares` (owner-only) — mints a
  capability-scoped, TTL-bounded `ods_…` token.
- Peer's web client treats `ods_…` as the bearer; middleware in M1
  resolves capabilities to ACL checks.
- UI: a "Share runtime" dialog producing a QR code / link.
- Tests: capability enforcement (no shell escape, no Import Folder,
  no token mint by share-bearer), TTL expiry.

### M7 — `custom/010-remote-mode-feature-flags.md`
- Audit list: features disabled when request is non-loopback /
  non-owner.
  - **Disabled (v1):** Import Folder, design-systems write, craft
    write, project-watchers attach to non-`.od` paths.
  - **Read-only (v1):** existing project files, runs, artifacts.
  - **Allowed:** chat, agent runs in default workdir, SSE.
- Web UI hides disabled actions when `session.mode == 'remote'`.

### M8 — SSE / reverse-proxy hardening (small, fold into M3 or its own)
- `X-Forwarded-For` / `X-Forwarded-Host` parsing.
- SSE `id:` field + client-side `EventSource.onerror` reconnect with
  `Last-Event-ID` resume.
- Longer keepalive default (`OD_SSE_KEEPALIVE_MS`).

## 6. What we are explicitly NOT doing in v1

- No central server. No Postgres. No webhooks. (That's Path B.)
- No filesystem RPC proxy — Import Folder stays owner-local. Peers
  who need their own files use their own runtime (= run a daemon
  on their machine).
- No skill marketplace, no billing, no audit log shipping.
- No cluster of daemons behind one identity — each machine gets its
  own daemon and its own runtime entry.
- No built-in tunnel transport — we wrap third-party tunnels (M5).

## 7. Open questions to resolve before M1

1. **Token format** — copy multica's `mdt_<40 hex>` shape or use a
   JWT? Hex is simpler and aligns with the audit story (server holds
   only the hash); JWT lets us encode capabilities without a DB hit.
   *Lean: hex + DB lookup, capabilities in `daemon_tokens.capabilities_json`.*
2. **Where does `od login` retrieve the PAT?** multica has a
   server-side identity provider. The fork doesn't have one. Options:
   - GitHub OAuth (every fork user has a GH account).
   - Local-only mode: `od login` just generates a random token and
     prints it; user pastes it into the second machine. No identity
     provider, two machines = same user by convention.
   *Lean: local-only mode for v1; GitHub OAuth as M-future.*
3. **How does the web client know which runtime to talk to?**
   Today the web origin is fixed to localhost. We need a runtime
   picker UI plus per-runtime base URL stored client-side.
4. **What's the upgrade path for existing local-only users?**
   M1's back-compat flag lets loopback requests through unauthed,
   so today's desktop keeps working. Remove the flag once tooling
   is shipped.

## 8. References

- multica architecture report (subagent transcript, this session)
- daemon audit report (subagent transcript, this session)
- multica self-hosting docs: https://github.com/multica-ai/multica/blob/main/SELF_HOSTING.md
- multica daemon pairing: https://deepwiki.com/multica-ai/multica/7.2-daemon-pairing-and-token-authentication
- Open Design merge policy: `custom/README.md` (四原则 — adding
  middleware to 16+ routes is the kind of cross-cutting customization
  that makes the next upstream merge expensive; M1/M3 should design
  the patch surface to be diff-friendly)

## 9. Decision needed

Before any of this gets started:

- [ ] confirm Path A is the chosen direction (vs B, vs "do nothing")
- [ ] pick token format (hex vs JWT) — §7.1
- [ ] pick identity provider for `od login` (local-only vs GitHub OAuth) — §7.2
- [ ] confirm the v1 feature-flag list in M7 is acceptable — §5

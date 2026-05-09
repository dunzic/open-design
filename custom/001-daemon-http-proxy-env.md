# 001 — Daemon respects host HTTP_PROXY / HTTPS_PROXY

- **Date:** 2026-05-08
- **Status:** Active
- **Scope:** `apps/daemon` only

## Rationale

Upstream's daemon uses Node's built-in `fetch` (undici) for every outbound
call — provider connection tests, the `/api/proxy/*` chat routes, media
generation, research/Tavily, deploy, connectors/Composio,
community-pets-sync. Node's built-in fetch **ignores** `HTTPS_PROXY` /
`HTTP_PROXY` env vars by default.

For users behind a system proxy (Clash, corporate gateway, VPN) the
browser works but the daemon's outbound traffic is silently blocked.
The packaged Windows app shows "runtime detected" but every API call
fails because the daemon can't reach `api.anthropic.com` etc.

This customization wires undici's `EnvHttpProxyAgent` as the global
dispatcher when any of `HTTPS_PROXY` / `https_proxy` / `HTTP_PROXY` /
`http_proxy` / `ALL_PROXY` / `all_proxy` is set. `NO_PROXY` defaults to
`localhost,127.0.0.1,::1` so local providers (Ollama, LM Studio,
llama.cpp) and the daemon's own self-checks bypass the proxy.

## Added

- `apps/daemon/src/http-proxy.ts` — `configureGlobalProxy()`,
  `createOutboundDispatcher()`, `isProxyEnvConfigured()`,
  `maskProxyUrl()`, `__resetGlobalProxyForTests()`.
- `apps/daemon/tests/http-proxy.test.ts` — unit tests covering env
  detection, dispatcher selection, NO_PROXY defaulting, idempotency,
  credential masking in startup logs, and the global undici dispatcher
  install. (Subsequent customizations may extend this file — see the
  per-customization "Test cases" sections for the active count and
  scenario list.)

## Modified

- `apps/daemon/src/cli.ts` — calls `configureGlobalProxy()` immediately
  after the import block, before subcommand dispatch and before
  `startServer()`.
- `apps/daemon/src/media.ts` — replaces the eager
  `new UndiciAgent({ headersTimeout, bodyTimeout })` for OpenAI image
  requests with a lazy `getOpenAIImageDispatcher()` getter that wraps
  `createOutboundDispatcher({ headersTimeout, bodyTimeout })`. Lazy is
  required because `cli.ts` calls `configureGlobalProxy()` *after* ESM
  imports have evaluated this module — a module-level dispatcher would
  capture pre-Layer-2 env state and miss system-detected proxies. See
  002 for why the bug only surfaces under Layer 2.

## Test cases

```bash
pnpm --filter @open-design/daemon exec vitest run tests/http-proxy.test.ts
```

Covered scenarios in `tests/http-proxy.test.ts` (this customization's
contribution; later entries add more):

- `isProxyEnvConfigured`
  - returns false when no proxy env is set
  - returns true for each of `HTTPS_PROXY`, `https_proxy`, `HTTP_PROXY`,
    `http_proxy`, `ALL_PROXY`, `all_proxy`
  - ignores `NO_PROXY` alone
- `createOutboundDispatcher`
  - returns plain undici `Agent` when no proxy env is set
  - returns `EnvHttpProxyAgent` when `HTTPS_PROXY` is set
- `configureGlobalProxy`
  - no-op when no proxy env is set (does not synthesize NO_PROXY)
  - defaults `NO_PROXY` to `localhost,127.0.0.1,::1` when proxy is set
    but NO_PROXY is not
  - preserves an explicit user-set `NO_PROXY`
  - configures only once even when called multiple times
- `maskProxyUrl`
  - `undefined` passthrough
  - credential-free URL untouched (only path normalization)
  - `user:pass@host` → `***:***@host` (host visible, secret stripped)
  - unparseable string returned unchanged

## Manual smoke (Windows packaged app)

```powershell
$env:HTTPS_PROXY = "http://127.0.0.1:7890"   # Clash / V2Ray HTTP port
# launch the packaged Open Design app
# in Settings, run "Test connection" against any cloud provider
```

Daemon log should print one line on startup:

```
[proxy] outbound fetch will use env proxy { https: 'http://127.0.0.1:7890/', http: undefined, all: undefined, no: 'localhost,127.0.0.1,::1' }
```

Provider connection test should succeed; previously it failed with
`fetch failed` / `ECONNRESET` / `ETIMEDOUT` against `api.anthropic.com`.

## Re-apply notes

If upstream rewrites any of the touched files, re-apply by:

1. **`apps/daemon/src/cli.ts`** — ensure `import { configureGlobalProxy }`
   is the **first** local import and `configureGlobalProxy()` is invoked
   on a top-level statement before any other code runs (before subcommand
   dispatch, before `startServer()`). Order matters: undici reads
   `process.env` at dispatcher construction, so the call must happen
   before any module evaluates code that captures a dispatcher.
2. **`apps/daemon/src/media.ts`** — keep the OpenAI image dispatcher
   construction routed through `createOutboundDispatcher` (NOT through
   `new Agent` directly), AND keep it inside a lazy getter rather than
   a module-level constant. The 10-minute headers/body timeout values
   must be preserved; `createOutboundDispatcher` forwards Agent.Options
   to the inner ProxyAgent / Agent. If a future refactor extracts the
   dispatcher to a module-level binding, Layer 2 system-proxy detection
   will break for image requests — the dispatcher captures pre-detection
   env state.
3. **`http-proxy.ts`** — if upstream introduces a different proxy
   abstraction (e.g. a settings-UI configurable proxy), this module
   becomes the integration point; expand it rather than scattering
   `setGlobalDispatcher` calls across the codebase.
4. **Tests** — `tests/http-proxy.test.ts` is self-contained and only
   imports from `../src/http-proxy.js`. It should survive refactors of
   other daemon modules.

## Upstream signal to watch

If a future upstream PR adds proxy support natively (e.g. a `Settings →
Network` panel that writes to `app-config.json`), demote this
requirement to **superseded** and reconcile the test case.

Search terms for upstream alignment: `EnvHttpProxyAgent`,
`setGlobalDispatcher`, `HTTPS_PROXY`, `proxy-agent`, `Settings.network`.

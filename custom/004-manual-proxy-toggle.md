# 004 — Manual proxy toggle in Settings (hardcoded local proxy)

- **Date:** 2026-05-09
- **Status:** Active
- **Scope:** `apps/daemon`, `apps/web`, `packages/contracts`
- **Builds on:** [001 — Daemon respects host HTTP_PROXY / HTTPS_PROXY](001-daemon-http-proxy-env.md), [002 — System proxy detection](002-daemon-system-proxy-detection.md)

## Rationale

001 wires daemon outbound through `HTTPS_PROXY` env. 002 auto-detects
the OS-level system proxy. Both fall short for the common GFW-China
flow:

1. The user runs Clash / Surge / Mihomo Party at default port 7890.
2. They want the daemon AND spawned agent CLIs (Claude Code) to egress
   through it — direct connection to api.anthropic.com is blocked.
3. They don't want to set OS-level env vars (would leak to every
   shell process they don't intend to proxy).
4. The 002 auto-detection of "system proxy" caused the agent CLI hang
   (custom/002 2026-05-09 revision) because Clash rules typed for
   browser traffic don't accept the CLI's request shape.

The fix: a Settings UI toggle that explicitly sets a hardcoded local
proxy on the daemon side, with the user's full knowledge that it
applies to both daemon and child CLIs.

## Behavior

- Settings → Execution & model → row with the "Test" button now also
  shows `Proxy: ON` / `Proxy: OFF` toggle button.
- Tooltip on hover renders the exact endpoint:
  - OFF: "Proxy OFF — daemon and CLIs go direct. Click to route through `http://127.0.0.1:7890` (Clash/Surge default port)."
  - ON: "Proxy ON — routing through `http://127.0.0.1:7890` (NO_PROXY=localhost,127.0.0.1,::1). Click to disable."
- Proxy URL is hardcoded to `http://127.0.0.1:7890` (see "Why hardcoded" below).
- Toggle state persists in `app-config.json` under `manualProxyEnabled`.
- Daemon flips the global undici dispatcher in real time on PUT
  `/api/app-config` — no daemon restart required.
- When ON: daemon outbound + spawned CLI children both go through the proxy.
- When OFF: falls back to env > system > none auto-detection chain.

## Resolution order

| Priority | Source | Trigger |
| --- | --- | --- |
| 1 | manual | `manualProxyEnabled === true` in app-config |
| 2 | env | `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` in process env |
| 3 | system | Windows registry / macOS scutil (custom/002) |
| 4 | none | direct connection |

Manual beats everything else — this is an explicit user gesture and
should not be silently overridden by env or system state.

## Child propagation

- `proxyEnvForChild()` returns `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`
  values for `spawn()` env injection IF either:
  - the proxy source is `manual` (this customization), OR
  - the user opted in via `OD_PROPAGATE_PROXY_TO_AGENTS=true` (escape
    hatch from custom/002 fix-leak revision).
- For `env` and `system` sources, propagation stays opt-out by default.
  The reason: those sources may auto-detect a proxy that breaks CLI
  traffic; the user didn't explicitly ask the CLIs to use it.
- When `manualProxyEnabled === true`, the user has explicitly opted
  into the proxy for everything. We propagate.
- `spawnEnvForAgent` in `agents.ts` reads `proxyEnvForChild()` and
  merges into spawn env, never overwriting existing env keys (a
  user-set `HTTPS_PROXY` on the OS level still wins).

## Why hardcoded?

User feedback: "先把这个写到程序里面" — start by hardcoding. The 7890
port is the Clash / Surge / Mihomo Party default mixed port; it
covers the overwhelming majority of the target audience. Making it
configurable is a v2 feature once the core toggle is validated.

If this needs to become user-editable, the place to extend is:
- `MANUAL_PROXY` constant in `apps/daemon/src/http-proxy.ts`
- Settings UI: replace the toggle button with a toggle + URL input
- App-config: extend `manualProxyEnabled: boolean` to
  `{ enabled: boolean, url: string, noProxy?: string }`

## Added

- `apps/daemon/src/http-proxy.ts`:
  - `MANUAL_PROXY` constant (URL + NO_PROXY)
  - `setManualProxyEnabled(enabled)` — flip + reinstall dispatcher in real time
  - `isManualProxyEnabled()` — read for diagnostics / sync
  - `installResolved()` helper — applies `resolveProxy()` output to global dispatcher
  - `installedOurDispatcher` flag — tracks whether we've ever swapped the
    global dispatcher so toggle-off can revert to a vanilla `Agent()`
    without perturbing undici's default in the no-proxy boot path
- `apps/daemon/src/http-proxy.ts` `proxyEnvForChild()` now also
  propagates when source is `manual` (in addition to opt-in env flag)
- `MANUAL_PROXY_HTTPS` / `MANUAL_PROXY_HTTP` / `MANUAL_PROXY_NO_PROXY`
  exports in `packages/contracts/src/api/app-config.ts` so the UI can
  render the same URL the daemon will dial without duplication
- `apps/web/src/components/SettingsDialog.tsx` — `Proxy: ON/OFF` toggle
  button next to Test button, with hover tooltip
- `apps/daemon/tests/http-proxy.test.ts` — 6 new tests covering the
  manual toggle, child propagation precedence, and dispatcher flip
- `custom/004-manual-proxy-toggle.md` (this file)

## Modified

- `packages/contracts/src/api/app-config.ts` — `manualProxyEnabled?: boolean` field on `AppConfigPrefs`
- `apps/daemon/src/app-config.ts` — same field + `ALLOWED_KEYS` membership + boolean validation
- `apps/daemon/src/server.ts` — boot path applies persisted
  `manualProxyEnabled`; PUT `/api/app-config` re-applies on change
- `apps/daemon/src/agents.ts` — `spawnEnvForAgent` always merges
  `proxyEnvForChild()` into spawn env (the function itself decides
  whether the result is empty based on source / opt-in)
- `apps/web/src/types.ts` — `manualProxyEnabled?: boolean` on AppConfig
- `apps/web/src/state/config.ts` — `syncConfigToDaemon` sends the flag;
  `mergeDaemonConfig` reads it back

## Re-apply notes

- If upstream rewrites `http-proxy.ts`: keep the `manualProxyEnabled`
  precedence in `resolveProxy()`; the rest follows.
- If upstream adds a Settings → Network UI: this customization can
  likely be demoted to **superseded**.
- The hardcoded 7890 port is locale-flavored. Don't be tempted to
  move it into env-var-only configuration without updating the UI
  tooltip in lockstep — the on-hover URL has to match what the
  daemon dials.

## Verify

```bash
pnpm --filter @open-design/daemon test tests/http-proxy.test.ts
pnpm --filter @open-design/daemon typecheck
pnpm --filter @open-design/web typecheck
```

Manual smoke (Windows, packaged build):

1. Launch Open Design with no system proxy / env proxy set.
2. Settings → Execution & model. The button row shows
   `Proxy: OFF | Test | Rescan`.
3. Hover the Proxy button — tooltip shows the proxy URL.
4. Click the toggle. The daemon log prints
   `[proxy] outbound fetch will use manual proxy { ... }`.
5. Click Test. Claude CLI should now egress through 7890; if Clash is
   running and configured for `api.anthropic.com`, the test passes.
6. Toggle off. Daemon log prints
   `[proxy] outbound fetch will go direct (no proxy)`.

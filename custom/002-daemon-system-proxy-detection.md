# 002 — Daemon detects OS system proxy (Windows registry / macOS scutil)

- **Date:** 2026-05-08
- **Status:** Active
- **Scope:** `apps/daemon` only
- **Builds on:** [001 — Daemon respects host HTTP_PROXY / HTTPS_PROXY](001-daemon-http-proxy-env.md)

## Rationale

001 wires the daemon's outbound fetch through `HTTPS_PROXY` / `HTTP_PROXY`
env vars. That covers users who set env vars in their shell, but it
misses the most common Windows / Mac flow: clicking "Set as system
proxy" in Clash / Surge / ClashX / V2RayU / Mihomo Party.

These clients do NOT export env vars — they write to:

- **Windows:** `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`
  (`ProxyEnable`, `ProxyServer`, `ProxyOverride`)
- **macOS:** SystemConfiguration store, readable via `scutil --proxy`
  (active interface; `HTTPEnable`, `HTTPProxy`, `HTTPPort`, `HTTPSEnable`,
  `HTTPSProxy`, `HTTPSPort`, `ExceptionsList`)

This customization extends `configureGlobalProxy()` so when no proxy env
var is set, the daemon falls back to the OS system proxy by reading
those sources and bridging the result into `HTTPS_PROXY` / `HTTP_PROXY` /
`NO_PROXY` before constructing the global undici dispatcher.

### Out of scope

- **PAC files** (Windows `AutoConfigURL`) — would require a JS PAC
  evaluator on the hot path of every fetch.
- **WPAD auto-detect** — same reason.
- **SOCKS-only configurations** — undici's `EnvHttpProxyAgent` does not
  speak SOCKS. Users with SOCKS-only proxies should set `ALL_PROXY`
  explicitly to a SOCKS endpoint via env var.
- **Linux** — no universal "system proxy" concept; env vars remain the
  idiomatic configuration.
- **iOS sandboxed proxy clients** (Shadow Rocket, Loon, Stash,
  Quantumult X) — even when run on Apple Silicon Macs, these only proxy
  iOS apps inside their own container and do not affect macOS system
  proxy settings, so detection cannot help. Users on those should
  switch to a macOS-native client (ClashX / Surge / Mihomo Party) or
  set env vars manually.

## Added

- `apps/daemon/src/system-proxy.ts` — `detectSystemProxy()`,
  platform-specific `readWindowsSystemProxy()` / `readMacSystemProxy()`,
  pure parsers `parseWindowsProxyServer()`, `parseWindowsProxyOverride()`,
  `parseScutilProxyOutput()`.
- `apps/daemon/tests/system-proxy.test.ts` — unit tests covering every
  parser variant. Includes a smoke test that `detectSystemProxy()` is
  safe to call unconditionally on the current platform. See the "Test
  cases" section below for the scenario list.

## Modified

- `apps/daemon/src/http-proxy.ts` — `configureGlobalProxy()` now
  consults `detectSystemProxy()` when no proxy env var is set,
  bridging the result into `process.env.HTTPS_PROXY` /
  `process.env.HTTP_PROXY` / `process.env.NO_PROXY`. Startup log
  reports `env` vs `system` as the proxy source.
- `apps/daemon/tests/http-proxy.test.ts` — mocks `system-proxy.js` via
  `vi.hoisted` so tests are host-independent (otherwise running tests
  on a developer's box with Clash's "system proxy" enabled would fail
  the env-only no-op cases). Adds 3 new tests that exercise the env↔
  system precedence and bridge.

This file is also tracked in 001 — keep both entries in sync when
either changes.

## Test cases

```bash
# Layer 2 parsers (host-independent)
pnpm --filter @open-design/daemon exec vitest run tests/system-proxy.test.ts

# Layer 1 + bridge composition
pnpm --filter @open-design/daemon exec vitest run tests/http-proxy.test.ts
```

`tests/system-proxy.test.ts` covers:

- `parseWindowsProxyServer`
  - empty / whitespace input
  - bare `host:port` → both http and https
  - per-protocol form `http=…;https=…`
  - drops unsupported protocols (ftp, socks)
  - case-insensitive on the protocol prefix (`HTTP=` / `HTTPS=`)
  - skips malformed pairs without crashing
- `parseWindowsProxyOverride`
  - empty input
  - semicolon → comma conversion
  - drops the `<local>` token (no NO_PROXY equivalent)
  - trims whitespace around entries
- `parseScutilProxyOutput`
  - both http and https proxies when both `*Enable: 1`
  - https-only configuration (uses `http://` scheme even for HTTPS proxy
    because EnvHttpProxyAgent talks to the proxy via plain HTTP CONNECT)
  - both disabled → no http/https returned
  - extracts `ExceptionsList` items into noProxy
  - empty `ExceptionsList` → noProxy undefined
  - missing `ExceptionsList` block → no crash
- `detectSystemProxy`
  - returns null on Linux
  - safe to call unconditionally on the current platform

`tests/http-proxy.test.ts` adds:

- bridges detected system proxy into `HTTPS_PROXY` / `HTTP_PROXY` and
  preserves a system-supplied `noProxy`
- falls back to loopback `NO_PROXY` when system proxy supplies none
- does not consult system proxy when env vars already provide one
  (env wins, no `reg query` / `scutil` invocation)

## Manual smoke

### Windows + Clash for Windows

1. Open Clash → 设置 → 系统代理 ✓ (writes `ProxyEnable=1`,
   `ProxyServer=127.0.0.1:7890`).
2. Do **NOT** set `HTTPS_PROXY` env var.
3. Launch the packaged Open Design app.
4. Daemon log should print:
   ```
   [proxy] outbound fetch will use system proxy { https: 'http://127.0.0.1:7890', http: 'http://127.0.0.1:7890', all: undefined, no: 'localhost,127.0.0.1,::1' }
   ```
5. In Settings, run "Test connection" against any cloud provider — it
   should succeed.

### macOS + ClashX / Mihomo Party

1. Click "Set as System Proxy" in the menubar app (ClashX writes via
   `networksetup`; Mihomo writes via `scutil`).
2. Verify with `scutil --proxy` — should show `HTTPSEnable : 1` and
   `HTTPSProxy : 127.0.0.1`.
3. Launch the packaged Open Design app.
4. Daemon log should print `system proxy` with the detected values.
5. Provider connection test should succeed.

### Verify env still wins

1. With Clash's system proxy enabled (Windows or Mac), set
   `HTTPS_PROXY=http://different-proxy:9999` in your shell.
2. Launch daemon from that shell.
3. Log should print `env proxy` with `different-proxy:9999`, NOT the
   system proxy. `reg query` / `scutil` should not be invoked.

## Re-apply notes

If upstream rewrites any of the touched files:

1. **`apps/daemon/src/http-proxy.ts`** — keep the resolution order
   `env > system > none`. The `applySystemProxyToEnv()` helper bridges
   detection results into env vars *before* constructing
   `EnvHttpProxyAgent`, so the existing dispatcher path remains the
   single source of truth for how proxies are honored.
2. **`apps/daemon/src/system-proxy.ts`** — the file is self-contained
   and only depends on `node:child_process`. Parsers are pure; the
   `read*SystemProxy` functions are platform-guarded and silent on
   non-target platforms.
3. **Reg query format** — Windows ships `reg.exe` in `System32`; the
   output format `Name    REG_TYPE    Value` is stable from XP onward.
   `ProxyEnable` is `0x0` / `0x1`; the `0x0*1` regex tolerates either
   `0x1` or `0x00000001`.
4. **scutil format** — the plist-debug renderer is a private Apple
   format but has been stable for years. If Apple changes it, the
   parser tests will fail before users notice — bump the regex and
   re-snapshot in tests.
5. **Tests** — `tests/http-proxy.test.ts` mocks `system-proxy.js` via
   `vi.hoisted()`. If upstream restructures the import path, update the
   `vi.mock(path)` argument in lockstep.

## Upstream signal to watch

If a future upstream PR adds native system-proxy detection or a
Settings → Network UI, demote both 001 and 002 to **superseded** in
lockstep and reconcile. Search terms: `EnvHttpProxyAgent`,
`setGlobalDispatcher`, `scutil --proxy`, `ProxyEnable`, `reg query`,
`Settings.network`.

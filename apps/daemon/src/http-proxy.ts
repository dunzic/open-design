// Wires Node's outbound fetch (undici) through the host's proxy
// configuration. Node's built-in fetch ignores both env vars and OS-level
// system proxy settings by default, which is why users behind a system
// proxy (Clash, Surge, corporate gateway) see the daemon's provider /
// media calls fail even though their browser works fine.
//
// Proxy resolution order (first hit wins):
//   1. HTTPS_PROXY / HTTP_PROXY / ALL_PROXY env vars (and lowercase aliases)
//   2. OS system proxy:
//        - Windows: HKCU\…\Internet Settings\Proxy{Enable,Server,Override}
//        - macOS:   `scutil --proxy` (active interface)
//        - Linux:   not auto-detected — set env vars
//
// configureGlobalProxy() is called once at daemon entry; afterwards every
// fetch() in the daemon — connectionTest, media, research, deploy,
// connectors, the /api/proxy/* chat routes — picks up the proxy without
// per-call changes.
//
// Scope: this module configures the daemon's own outbound dispatcher
// only. It deliberately does NOT mutate process.env, so spawned children
// (Claude CLI, Codex, etc.) inherit whatever proxy env the user
// configured at the OS level, not whatever the daemon detected. Forcing
// children through a system proxy that's only valid for browser-shaped
// traffic was a real regression — the agent CLIs hung on smoke tests
// when Clash-style proxies refused their destination.
//
// NO_PROXY behavior: if the user has not set NO_PROXY (and the system
// proxy detection didn't supply one), default to bypassing loopback so
// local providers (Ollama, LM Studio, llama.cpp) and the daemon's own
// self-checks keep working when a system proxy is enabled.

import {
  Agent,
  EnvHttpProxyAgent,
  setGlobalDispatcher,
  type Dispatcher,
} from 'undici';
import { detectSystemProxy } from './system-proxy.js';

interface ProxyEnv {
  https: string | undefined;
  http: string | undefined;
  all: string | undefined;
  no: string | undefined;
}

interface ResolvedProxy {
  http?: string;
  https?: string;
  noProxy: string;
}

const DEFAULT_NO_PROXY = 'localhost,127.0.0.1,::1';

// Hardcoded "manual proxy" — fork-only (custom/004). Targets the
// Clash/Surge/Mihomo default local mixed port. The Settings dialog
// renders a toggle next to the Test button; flipping it on calls
// `setManualProxyEnabled(true)` here, which swaps the global undici
// dispatcher in real time and starts propagating HTTPS_PROXY /
// HTTP_PROXY / NO_PROXY into spawned CLI children (so Claude Code etc.
// also egress through the proxy). Flipping it off restores the
// env/system auto-detection path.
const MANUAL_PROXY: ResolvedProxy = {
  http: 'http://127.0.0.1:7890',
  https: 'http://127.0.0.1:7890',
  noProxy: DEFAULT_NO_PROXY,
};

function readProxyEnv(): ProxyEnv {
  return {
    https: process.env.HTTPS_PROXY ?? process.env.https_proxy,
    http: process.env.HTTP_PROXY ?? process.env.http_proxy,
    all: process.env.ALL_PROXY ?? process.env.all_proxy,
    no: process.env.NO_PROXY ?? process.env.no_proxy,
  };
}

export function isProxyEnvConfigured(): boolean {
  const env = readProxyEnv();
  return Boolean(env.https || env.http || env.all);
}

// Strips username/password from a proxy URL so the startup log doesn't
// leak credentials when the user has `http://user:pass@host:port` set.
export function maskProxyUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = parsed.username ? '***' : '';
      parsed.password = parsed.password ? '***' : '';
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

let configured = false;
let resolvedProxy: ResolvedProxy | null = null;
let resolvedSource: 'env' | 'system' | 'manual' | 'none' = 'none';
let manualProxyEnabled = false;
// Tracks whether we've ever swapped the global undici dispatcher. Lets
// us undo back to a vanilla Agent if the user disables manual proxy
// after we'd installed an EnvHttpProxyAgent, while leaving the
// global dispatcher untouched in the steady-state no-proxy boot path.
let installedOurDispatcher = false;

export interface ProxySnapshot {
  source: 'env' | 'system' | 'manual' | 'none';
  http?: string;
  https?: string;
  noProxy?: string;
}

// Returns the daemon's currently-resolved outbound proxy config in a
// shape safe for diagnostics (credentials masked). Used by the
// connectionTest error path so the user can see *why* the daemon
// thinks there's a proxy in play (or why there isn't).
export function snapshotResolvedProxy(): ProxySnapshot {
  if (resolvedProxy && resolvedSource !== 'none') {
    const out: ProxySnapshot = { source: resolvedSource };
    const httpsMasked = maskProxyUrl(resolvedProxy.https);
    const httpMasked = maskProxyUrl(resolvedProxy.http);
    if (httpsMasked) out.https = httpsMasked;
    if (httpMasked) out.http = httpMasked;
    if (resolvedProxy.noProxy) out.noProxy = resolvedProxy.noProxy;
    return out;
  }
  // configureGlobalProxy() may not have run yet (some test paths reach
  // diagnostics before boot). Fall back to a direct env read.
  const env = readProxyEnv();
  if (env.https || env.http || env.all) {
    const out: ProxySnapshot = { source: 'env' };
    const httpsMasked = maskProxyUrl(env.https ?? env.all);
    const httpMasked = maskProxyUrl(env.http ?? env.all);
    if (httpsMasked) out.https = httpsMasked;
    if (httpMasked) out.http = httpMasked;
    if (env.no) out.noProxy = env.no;
    return out;
  }
  return { source: 'none' };
}

// Returns env-var-shaped proxy entries for use when the daemon spawns
// a child process. Empty unless the daemon has resolved a proxy AND
// either the user has opted into propagation (`OD_PROPAGATE_PROXY_TO_AGENTS=true`)
// or the proxy came from the manual Settings toggle (an explicit user
// gesture — propagation is the whole point of flipping that switch).
// Auto-detected env / system proxy stays daemon-only by default to
// avoid the regression where Clash-style rules break agent CLI traffic.
export function proxyEnvForChild(): Record<string, string> {
  if (!resolvedProxy) return {};
  const optedIn =
    resolvedSource === 'manual' ||
    process.env.OD_PROPAGATE_PROXY_TO_AGENTS === 'true';
  if (!optedIn) return {};
  const out: Record<string, string> = {};
  if (resolvedProxy.https) out.HTTPS_PROXY = resolvedProxy.https;
  if (resolvedProxy.http) out.HTTP_PROXY = resolvedProxy.http;
  if (resolvedProxy.noProxy) out.NO_PROXY = resolvedProxy.noProxy;
  return out;
}

function resolveProxy(): {
  source: 'env' | 'system' | 'manual' | 'none';
  proxy: ResolvedProxy | null;
} {
  // Manual override (the Settings toggle) wins over everything: when
  // the user explicitly says "use the local proxy", honor that even if
  // env vars or system settings disagree. The auto-detect paths only
  // run when manual is off.
  if (manualProxyEnabled) {
    return { source: 'manual', proxy: { ...MANUAL_PROXY } };
  }

  const env = readProxyEnv();
  if (env.https || env.http || env.all) {
    const proxy: ResolvedProxy = { noProxy: env.no ?? DEFAULT_NO_PROXY };
    const http = env.http ?? env.all;
    const https = env.https ?? env.all;
    if (http) proxy.http = http;
    if (https) proxy.https = https;
    return { source: 'env', proxy };
  }

  const sys = detectSystemProxy();
  if (sys && (sys.http || sys.https)) {
    const proxy: ResolvedProxy = { noProxy: sys.noProxy ?? DEFAULT_NO_PROXY };
    if (sys.http) proxy.http = sys.http;
    if (sys.https) proxy.https = sys.https;
    return { source: 'system', proxy };
  }

  return { source: 'none', proxy: null };
}

// Applies whatever resolveProxy() returns to the global undici
// dispatcher. When no proxy is resolved AND we haven't installed our
// own dispatcher yet, leaves the global dispatcher alone — the
// boot-time no-proxy path stays a no-op so we don't perturb undici's
// default. When transitioning from a previously-installed proxy
// dispatcher back to no-proxy (e.g. user disables the toggle), reset
// to a vanilla Agent so the proxy dispatcher doesn't leak.
function installResolved(): void {
  const { source, proxy } = resolveProxy();
  resolvedProxy = proxy;
  resolvedSource = source;
  if (proxy) {
    setGlobalDispatcher(new EnvHttpProxyAgent(envProxyAgentOpts(proxy)));
    installedOurDispatcher = true;
    console.log(`[proxy] outbound fetch will use ${source} proxy`, {
      https: maskProxyUrl(proxy.https),
      http: maskProxyUrl(proxy.http),
      no: proxy.noProxy,
    });
    return;
  }
  if (installedOurDispatcher) {
    setGlobalDispatcher(new Agent());
    installedOurDispatcher = false;
    console.log('[proxy] outbound fetch will go direct (no proxy)');
  }
}

/**
 * Toggles the fork-only manual proxy. Re-resolves the dispatcher
 * immediately so the change takes effect without a daemon restart.
 * Called from /api/app-config when manualProxyEnabled flips and
 * once at boot from cli.ts after reading persisted config.
 */
export function setManualProxyEnabled(enabled: boolean): void {
  if (manualProxyEnabled === enabled && configured) return;
  manualProxyEnabled = enabled;
  configured = true;
  installResolved();
}

/** Read-only — used by the Settings UI / diagnostics to render the
 *  toggle's current state without re-deriving it. */
export function isManualProxyEnabled(): boolean {
  return manualProxyEnabled;
}

export function configureGlobalProxy(): void {
  if (configured) return;
  configured = true;
  installResolved();
}

// EnvHttpProxyAgent forwards Agent.Options to the inner Agent / ProxyAgent
// it creates per origin, so headersTimeout / bodyTimeout still apply when
// the request is proxied. Used by media.ts where image generation needs
// 10-minute timeouts but must still go through the user's proxy.
export function createOutboundDispatcher(opts: {
  headersTimeout?: number;
  bodyTimeout?: number;
}): Dispatcher {
  if (resolvedProxy) {
    return new EnvHttpProxyAgent({
      ...opts,
      ...envProxyAgentOpts(resolvedProxy),
    });
  }
  // env-var fallback for callers reached before configureGlobalProxy()
  // (e.g. unit tests of media.ts that set HTTPS_PROXY but skip global
  // configuration). In normal daemon boot, configureGlobalProxy() runs
  // first and resolvedProxy is already cached.
  if (isProxyEnvConfigured()) return new EnvHttpProxyAgent(opts);
  return new Agent(opts);
}

// Builds an EnvHttpProxyAgent options object that only includes the
// httpProxy / httpsProxy keys when they actually have values. Required
// because `exactOptionalPropertyTypes: true` rejects `key: undefined`.
function envProxyAgentOpts(
  proxy: ResolvedProxy,
): { httpProxy?: string; httpsProxy?: string; noProxy: string } {
  const opts: { httpProxy?: string; httpsProxy?: string; noProxy: string } = {
    noProxy: proxy.noProxy,
  };
  if (proxy.http) opts.httpProxy = proxy.http;
  if (proxy.https) opts.httpsProxy = proxy.https;
  return opts;
}

// Test-only — lets unit tests reset the configure-once latch + cache
// between cases.
export function __resetGlobalProxyForTests(): void {
  configured = false;
  resolvedProxy = null;
  resolvedSource = 'none';
  manualProxyEnabled = false;
  installedOurDispatcher = false;
}

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

function resolveProxy(): {
  source: 'env' | 'system' | 'none';
  proxy: ResolvedProxy | null;
} {
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

export function configureGlobalProxy(): void {
  if (configured) return;
  configured = true;

  const { source, proxy } = resolveProxy();
  resolvedProxy = proxy;
  if (!proxy) return;

  // Pass proxy URLs explicitly so EnvHttpProxyAgent doesn't fall back to
  // reading process.env at request time. Children spawned later in the
  // daemon (CLI agents) get an unmodified env from the OS.
  setGlobalDispatcher(new EnvHttpProxyAgent(envProxyAgentOpts(proxy)));

  console.log(`[proxy] outbound fetch will use ${source} proxy`, {
    https: maskProxyUrl(proxy.https),
    http: maskProxyUrl(proxy.http),
    no: proxy.noProxy,
  });
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
}

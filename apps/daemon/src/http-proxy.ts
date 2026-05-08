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

// Bridges OS-level system proxy into env vars so EnvHttpProxyAgent picks
// it up. We mutate process.env (rather than constructing the agent
// manually) for two reasons: it keeps the resolution path uniform with
// Layer 1, and any child processes the daemon spawns inherit the same
// proxy without extra wiring.
function applySystemProxyToEnv(): 'env' | 'system' | 'none' {
  if (isProxyEnvConfigured()) return 'env';

  const sys = detectSystemProxy();
  if (!sys) return 'none';

  if (sys.https) process.env.HTTPS_PROXY = sys.https;
  if (sys.http) process.env.HTTP_PROXY = sys.http;
  if (sys.noProxy && !process.env.NO_PROXY && !process.env.no_proxy) {
    process.env.NO_PROXY = sys.noProxy;
  }
  return isProxyEnvConfigured() ? 'system' : 'none';
}

export function configureGlobalProxy(): void {
  if (configured) return;
  configured = true;

  const source = applySystemProxyToEnv();
  if (source === 'none') return;

  if (!process.env.NO_PROXY && !process.env.no_proxy) {
    process.env.NO_PROXY = 'localhost,127.0.0.1,::1';
  }

  setGlobalDispatcher(new EnvHttpProxyAgent());

  const env = readProxyEnv();
  console.log(`[proxy] outbound fetch will use ${source} proxy`, {
    https: maskProxyUrl(env.https),
    http: maskProxyUrl(env.http),
    all: maskProxyUrl(env.all),
    no: process.env.NO_PROXY,
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
  return isProxyEnvConfigured()
    ? new EnvHttpProxyAgent(opts)
    : new Agent(opts);
}

// Test-only — lets unit tests reset the configure-once latch between cases.
export function __resetGlobalProxyForTests(): void {
  configured = false;
}

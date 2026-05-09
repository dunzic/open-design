// Reads OS-level "system proxy" configuration so the daemon can honor
// proxies set via Windows Internet Settings (ProxyEnable/ProxyServer) or
// macOS System Preferences → Network → Proxies (i.e. what Clash, Surge,
// ClashX, V2RayU configure when the user clicks "Set as system proxy").
//
// Node's built-in fetch reads neither, and `EnvHttpProxyAgent` reads only
// env vars. We bridge the two by detecting the system proxy and writing
// it into process.env before constructing the global dispatcher.
//
// Out of scope:
//   - PAC files (AutoConfigURL on Windows) — would require a JS PAC
//     evaluator on the hot path of every fetch, not worth it for a
//     local app.
//   - SOCKS-only configurations — undici's EnvHttpProxyAgent doesn't
//     speak SOCKS. A user with SOCKS-only is best served by setting
//     ALL_PROXY explicitly to their SOCKS endpoint.
//   - Linux: no universal "system proxy" — env vars are idiomatic.

import { execFileSync } from 'node:child_process';

export interface SystemProxy {
  http?: string;
  https?: string;
  noProxy?: string;
}

// ---- Windows --------------------------------------------------------------

// `reg query` output for Internet Settings looks like:
//
//   HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Internet Settings
//       ProxyEnable    REG_DWORD    0x1
//       ProxyServer    REG_SZ    127.0.0.1:7890
//       ProxyOverride  REG_SZ    localhost;127.*;<local>
//
// ProxyServer takes one of two forms:
//   - "host:port" — applies to all protocols
//   - "http=h:p;https=h:p;ftp=h:p;socks=h:p" — per protocol
export function parseWindowsProxyServer(value: string): {
  http?: string;
  https?: string;
} {
  const trimmed = value.trim();
  if (!trimmed) return {};

  if (!trimmed.includes('=')) {
    const url = `http://${trimmed}`;
    return { http: url, https: url };
  }

  const out: { http?: string; https?: string } = {};
  for (const pair of trimmed.split(';')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const proto = pair.slice(0, eq).trim().toLowerCase();
    const hostport = pair.slice(eq + 1).trim();
    if (!hostport) continue;
    if (proto === 'http') out.http = `http://${hostport}`;
    else if (proto === 'https') out.https = `http://${hostport}`;
  }
  return out;
}

// `<local>` is Windows shorthand for "any hostname without dots". There's
// no exact NO_PROXY equivalent, but our default loopback bypass covers
// the common case (localhost / 127.0.0.1). Drop `<local>` and pass the
// rest through as comma-separated NO_PROXY entries.
//
// Format mismatch caveat: Windows ProxyOverride supports glob-ish
// patterns like `127.*` and `192.168.*`. undici's NO_PROXY parser does
// suffix and exact matching but does NOT expand these into CIDR-like
// ranges, so a `127.*` entry will only match the literal string. The
// daemon's outbound traffic is overwhelmingly to public APIs, where
// suffix matches (`*.example.com`) work as expected; entries that rely
// on Windows wildcard semantics are passed through verbatim and may
// not bypass the proxy. Users who need precise internal-network bypass
// should set NO_PROXY explicitly via env var.
export function parseWindowsProxyOverride(value: string): string {
  return value
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part !== '<local>')
    .join(',');
}

// `reg query` healthy-path latency is single-digit milliseconds; 500 ms
// is a generous ceiling that still keeps daemon startup snappy if the
// registry call hangs. On timeout we silently fall back to "no system
// proxy detected" rather than blocking.
const REG_QUERY_TIMEOUT_MS = 500;

function readRegValue(key: string, name: string): string | null {
  try {
    const out = execFileSync('reg', ['query', key, '/v', name], {
      encoding: 'utf8',
      timeout: REG_QUERY_TIMEOUT_MS,
      windowsHide: true,
    });
    // Match the line: "    Name    REG_TYPE    Value...". Anchor `name`
    // with word boundaries so a partial-prefix value name in the output
    // can't accidentally match a different field.
    const re = new RegExp(`\\b${name}\\b\\s+REG_\\w+\\s+(.*)`);
    const match = re.exec(out);
    return match?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

export function readWindowsSystemProxy(): SystemProxy | null {
  if (process.platform !== 'win32') return null;

  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
  const enableRaw = readRegValue(key, 'ProxyEnable');
  if (enableRaw == null) return null;
  // ProxyEnable is REG_DWORD; reg query renders it as `0x1` or `0x0`.
  if (!/^0x0*1$/i.test(enableRaw)) return null;

  const server = readRegValue(key, 'ProxyServer');
  if (!server) return null;
  const parsed = parseWindowsProxyServer(server);
  if (!parsed.http && !parsed.https) return null;

  const result: SystemProxy = {};
  if (parsed.http) result.http = parsed.http;
  if (parsed.https) result.https = parsed.https;

  const override = readRegValue(key, 'ProxyOverride');
  if (override) {
    const noProxy = parseWindowsProxyOverride(override);
    if (noProxy) result.noProxy = noProxy;
  }
  return result;
}

// ---- macOS ----------------------------------------------------------------

// `scutil --proxy` output (interface-aware: returns the active interface's
// settings) looks like:
//
//   <dictionary> {
//     ExceptionsList : <array> {
//       0 : *.local
//       1 : 169.254/16
//     }
//     HTTPEnable : 1
//     HTTPPort : 7890
//     HTTPProxy : 127.0.0.1
//     HTTPSEnable : 1
//     HTTPSPort : 7890
//     HTTPSProxy : 127.0.0.1
//     ...
//   }
//
// Top-level keys are stable across macOS versions; the format is
// scutil's plist-debug renderer, not real plist, so we parse with regex
// rather than pulling in a plist dependency.
export function parseScutilProxyOutput(text: string): SystemProxy {
  const value = (key: string): string | null => {
    const match = new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, 'm').exec(text);
    return match?.[1]?.trim() ?? null;
  };

  const result: SystemProxy = {};

  if (value('HTTPEnable') === '1') {
    const host = value('HTTPProxy');
    const port = value('HTTPPort');
    if (host && port) result.http = `http://${host}:${port}`;
  }

  if (value('HTTPSEnable') === '1') {
    const host = value('HTTPSProxy');
    const port = value('HTTPSPort');
    // EnvHttpProxyAgent connects TO the proxy via plain HTTP CONNECT
    // regardless of whether the upstream target is HTTPS, so the URL
    // scheme here is `http://`, not `https://`.
    if (host && port) result.https = `http://${host}:${port}`;
  }

  // ExceptionsList is a multi-line array block. We only care about the
  // values, not the indices.
  const block = /ExceptionsList\s*:\s*<array>\s*\{([\s\S]*?)\}/.exec(text);
  const blockBody = block?.[1];
  if (blockBody) {
    const items = blockBody
      .split('\n')
      .map((line) => /^\s*\d+\s*:\s*(.+)$/.exec(line.trim())?.[1]?.trim())
      .filter((item): item is string => Boolean(item));
    if (items.length > 0) result.noProxy = items.join(',');
  }

  return result;
}

// Same rationale as REG_QUERY_TIMEOUT_MS: single-digit ms in practice,
// 500 ms keeps a stalled scutil from blocking daemon boot.
const SCUTIL_TIMEOUT_MS = 500;

export function readMacSystemProxy(): SystemProxy | null {
  if (process.platform !== 'darwin') return null;
  let out: string;
  try {
    out = execFileSync('scutil', ['--proxy'], {
      encoding: 'utf8',
      timeout: SCUTIL_TIMEOUT_MS,
    });
  } catch {
    return null;
  }
  const parsed = parseScutilProxyOutput(out);
  if (!parsed.http && !parsed.https) return null;
  return parsed;
}

// ---- Dispatch -------------------------------------------------------------

export function detectSystemProxy(): SystemProxy | null {
  if (process.platform === 'win32') return readWindowsSystemProxy();
  if (process.platform === 'darwin') return readMacSystemProxy();
  return null;
}

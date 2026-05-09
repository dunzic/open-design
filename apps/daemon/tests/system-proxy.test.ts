import { describe, expect, it } from 'vitest';

import {
  detectSystemProxy,
  parseScutilProxyOutput,
  parseWindowsProxyOverride,
  parseWindowsProxyServer,
} from '../src/system-proxy.js';

describe('parseWindowsProxyServer', () => {
  it('returns empty for empty input', () => {
    expect(parseWindowsProxyServer('')).toEqual({});
    expect(parseWindowsProxyServer('   ')).toEqual({});
  });

  it('treats a bare host:port as both http and https proxy', () => {
    expect(parseWindowsProxyServer('127.0.0.1:7890')).toEqual({
      http: 'http://127.0.0.1:7890',
      https: 'http://127.0.0.1:7890',
    });
  });

  it('parses per-protocol pairs', () => {
    expect(
      parseWindowsProxyServer('http=127.0.0.1:7890;https=127.0.0.1:7891'),
    ).toEqual({
      http: 'http://127.0.0.1:7890',
      https: 'http://127.0.0.1:7891',
    });
  });

  it('ignores unsupported protocols (ftp, socks)', () => {
    const parsed = parseWindowsProxyServer(
      'http=h:1;https=h:2;ftp=h:3;socks=h:4',
    );
    expect(parsed).toEqual({ http: 'http://h:1', https: 'http://h:2' });
  });

  it('is case-insensitive on the protocol prefix', () => {
    expect(parseWindowsProxyServer('HTTP=h:1;HTTPS=h:2')).toEqual({
      http: 'http://h:1',
      https: 'http://h:2',
    });
  });

  it('skips malformed pairs without crashing', () => {
    expect(parseWindowsProxyServer('http=;=h:1;https=h:2')).toEqual({
      https: 'http://h:2',
    });
  });
});

describe('parseWindowsProxyOverride', () => {
  it('returns empty string for empty input', () => {
    expect(parseWindowsProxyOverride('')).toBe('');
  });

  it('converts semicolons to commas', () => {
    expect(parseWindowsProxyOverride('localhost;127.*;*.internal')).toBe(
      'localhost,127.*,*.internal',
    );
  });

  it('drops the <local> token (no NO_PROXY equivalent)', () => {
    expect(parseWindowsProxyOverride('localhost;<local>;*.example.com')).toBe(
      'localhost,*.example.com',
    );
  });

  it('trims whitespace around entries', () => {
    expect(parseWindowsProxyOverride('  localhost ;  127.*  ; ')).toBe(
      'localhost,127.*',
    );
  });
});

describe('parseScutilProxyOutput', () => {
  const sampleEnabled = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : 169.254/16
    2 : *.corp.example
  }
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7891
  HTTPSProxy : 127.0.0.1
}`;

  const sampleDisabled = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
  }
  FTPPassive : 1
  HTTPEnable : 0
  HTTPSEnable : 0
}`;

  const sampleHttpsOnly = `<dictionary> {
  HTTPEnable : 0
  HTTPSEnable : 1
  HTTPSPort : 8888
  HTTPSProxy : proxy.example.com
}`;

  it('parses both http and https proxies when enabled', () => {
    const parsed = parseScutilProxyOutput(sampleEnabled);
    expect(parsed.http).toBe('http://127.0.0.1:7890');
    expect(parsed.https).toBe('http://127.0.0.1:7891');
  });

  it('uses http:// scheme for the proxy URL even for HTTPS proxy', () => {
    // EnvHttpProxyAgent talks to the proxy via plain HTTP CONNECT
    // regardless of whether the upstream target is https.
    const parsed = parseScutilProxyOutput(sampleHttpsOnly);
    expect(parsed.https).toBe('http://proxy.example.com:8888');
    expect(parsed.http).toBeUndefined();
  });

  it('returns no http/https when both are disabled', () => {
    const parsed = parseScutilProxyOutput(sampleDisabled);
    expect(parsed.http).toBeUndefined();
    expect(parsed.https).toBeUndefined();
  });

  it('extracts ExceptionsList items into noProxy', () => {
    const parsed = parseScutilProxyOutput(sampleEnabled);
    expect(parsed.noProxy).toBe('*.local,169.254/16,*.corp.example');
  });

  it('omits noProxy when ExceptionsList is empty', () => {
    const text = `<dictionary> {
  ExceptionsList : <array> {
  }
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
}`;
    const parsed = parseScutilProxyOutput(text);
    expect(parsed.noProxy).toBeUndefined();
  });

  it('handles missing ExceptionsList block', () => {
    const text = `<dictionary> {
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
}`;
    const parsed = parseScutilProxyOutput(text);
    expect(parsed.noProxy).toBeUndefined();
    expect(parsed.http).toBe('http://127.0.0.1:7890');
  });
});

describe('detectSystemProxy', () => {
  it('returns null on Linux', () => {
    if (process.platform === 'linux') {
      expect(detectSystemProxy()).toBeNull();
    }
  });

  it('does not throw on the current platform regardless of state', () => {
    // Smoke test — the function must be safe to call unconditionally at
    // daemon startup. Whether it returns a value depends on whether the
    // host actually has a system proxy configured.
    expect(() => detectSystemProxy()).not.toThrow();
  });
});

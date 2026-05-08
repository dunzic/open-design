import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Agent,
  EnvHttpProxyAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
} from 'undici';

// Mock the system-proxy detection so this test file is host-independent.
// Layer 2 parsing is covered by system-proxy.test.ts; here the mock lets
// individual tests assert how Layer 1 (env) and Layer 2 (system) compose.
//
// vi.mock factories are hoisted above any other top-level code, so the
// mock fn must be declared via vi.hoisted to be available when the
// factory runs.
const { detectSystemProxyMock } = vi.hoisted(() => ({
  detectSystemProxyMock: vi.fn<() => unknown>(),
}));
vi.mock('../src/system-proxy.js', () => ({
  detectSystemProxy: detectSystemProxyMock,
}));

import {
  __resetGlobalProxyForTests,
  configureGlobalProxy,
  createOutboundDispatcher,
  isProxyEnvConfigured,
  maskProxyUrl,
} from '../src/http-proxy.js';

const PROXY_KEYS = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
] as const;

describe('http-proxy', () => {
  const saved: Record<string, string | undefined> = {};
  let savedDispatcher: ReturnType<typeof getGlobalDispatcher>;

  beforeEach(() => {
    for (const key of PROXY_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    // configureGlobalProxy mutates Node's global dispatcher, which is
    // process-wide. Snapshot and restore it so tests in this file don't
    // pollute the global state of any other test file run in the same
    // worker.
    savedDispatcher = getGlobalDispatcher();
    __resetGlobalProxyForTests();
    detectSystemProxyMock.mockReset();
    detectSystemProxyMock.mockReturnValue(null);
  });

  afterEach(() => {
    for (const key of PROXY_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    setGlobalDispatcher(savedDispatcher);
    __resetGlobalProxyForTests();
  });

  describe('isProxyEnvConfigured', () => {
    it('returns false when no proxy env is set', () => {
      expect(isProxyEnvConfigured()).toBe(false);
    });

    it.each(['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'])(
      'returns true when %s is set',
      (key) => {
        process.env[key] = 'http://127.0.0.1:7890';
        expect(isProxyEnvConfigured()).toBe(true);
      },
    );

    it('ignores NO_PROXY alone', () => {
      process.env.NO_PROXY = 'localhost';
      expect(isProxyEnvConfigured()).toBe(false);
    });
  });

  describe('createOutboundDispatcher', () => {
    it('returns a plain Agent when no proxy env is set', () => {
      const dispatcher = createOutboundDispatcher({ headersTimeout: 1000 });
      expect(dispatcher).toBeInstanceOf(Agent);
      expect(dispatcher).not.toBeInstanceOf(EnvHttpProxyAgent);
    });

    it('returns an EnvHttpProxyAgent when HTTPS_PROXY is set', () => {
      process.env.HTTPS_PROXY = 'http://127.0.0.1:7890';
      const dispatcher = createOutboundDispatcher({ bodyTimeout: 5000 });
      expect(dispatcher).toBeInstanceOf(EnvHttpProxyAgent);
    });
  });

  describe('configureGlobalProxy', () => {
    it('is a no-op when no proxy env is set and system proxy is not detected', () => {
      configureGlobalProxy();
      expect(process.env.NO_PROXY).toBeUndefined();
    });

    it('defaults NO_PROXY to loopback when env proxy is set but NO_PROXY is not', () => {
      process.env.HTTPS_PROXY = 'http://127.0.0.1:7890';
      configureGlobalProxy();
      expect(process.env.NO_PROXY).toBe('localhost,127.0.0.1,::1');
    });

    it('preserves an explicit NO_PROXY', () => {
      process.env.HTTPS_PROXY = 'http://127.0.0.1:7890';
      process.env.NO_PROXY = '*.internal,10.0.0.0/8';
      configureGlobalProxy();
      expect(process.env.NO_PROXY).toBe('*.internal,10.0.0.0/8');
    });

    it('only configures once even if called multiple times', () => {
      process.env.HTTPS_PROXY = 'http://127.0.0.1:7890';
      configureGlobalProxy();
      const first = process.env.NO_PROXY;
      process.env.NO_PROXY = 'changed-after-first-call';
      configureGlobalProxy();
      expect(process.env.NO_PROXY).toBe('changed-after-first-call');
      expect(first).toBe('localhost,127.0.0.1,::1');
    });

    it('bridges detected system proxy into HTTPS_PROXY / HTTP_PROXY', () => {
      detectSystemProxyMock.mockReturnValue({
        http: 'http://127.0.0.1:7890',
        https: 'http://127.0.0.1:7891',
        noProxy: '*.local,*.corp',
      });
      configureGlobalProxy();
      expect(process.env.HTTPS_PROXY).toBe('http://127.0.0.1:7891');
      expect(process.env.HTTP_PROXY).toBe('http://127.0.0.1:7890');
      expect(process.env.NO_PROXY).toBe('*.local,*.corp');
    });

    it('falls back to loopback NO_PROXY when system proxy supplies none', () => {
      detectSystemProxyMock.mockReturnValue({
        https: 'http://127.0.0.1:7890',
      });
      configureGlobalProxy();
      expect(process.env.HTTPS_PROXY).toBe('http://127.0.0.1:7890');
      expect(process.env.NO_PROXY).toBe('localhost,127.0.0.1,::1');
    });

    it('does not consult system proxy when env vars already provide one', () => {
      process.env.HTTPS_PROXY = 'http://env-proxy:9999';
      detectSystemProxyMock.mockReturnValue({
        https: 'http://system-proxy:7890',
      });
      configureGlobalProxy();
      expect(process.env.HTTPS_PROXY).toBe('http://env-proxy:9999');
      expect(detectSystemProxyMock).not.toHaveBeenCalled();
    });

    it('installs an EnvHttpProxyAgent as the global undici dispatcher', () => {
      process.env.HTTPS_PROXY = 'http://127.0.0.1:7890';
      configureGlobalProxy();
      expect(getGlobalDispatcher()).toBeInstanceOf(EnvHttpProxyAgent);
    });

    it('leaves the global dispatcher untouched when no proxy is configured', () => {
      const before = getGlobalDispatcher();
      configureGlobalProxy();
      expect(getGlobalDispatcher()).toBe(before);
    });

    it('installs the global dispatcher even when proxy comes from system detection', () => {
      detectSystemProxyMock.mockReturnValue({
        https: 'http://127.0.0.1:7890',
      });
      configureGlobalProxy();
      expect(getGlobalDispatcher()).toBeInstanceOf(EnvHttpProxyAgent);
    });
  });

  describe('maskProxyUrl', () => {
    it('returns undefined for undefined input', () => {
      expect(maskProxyUrl(undefined)).toBeUndefined();
    });

    it('leaves credential-free URLs untouched', () => {
      expect(maskProxyUrl('http://127.0.0.1:7890')).toBe('http://127.0.0.1:7890/');
    });

    it('masks the password while keeping the host visible', () => {
      const masked = maskProxyUrl('http://alice:s3cret@proxy.example:8080');
      expect(masked).toContain('proxy.example:8080');
      expect(masked).not.toContain('s3cret');
      expect(masked).toContain('***');
    });

    it('returns the input unchanged when it cannot be parsed as a URL', () => {
      expect(maskProxyUrl('not a url')).toBe('not a url');
    });
  });
});

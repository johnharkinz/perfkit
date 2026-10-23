/**
 * The HTTP client seam, for behaviour no current tool can reach through MCP:
 * refusing destinations outside the fixed Google endpoints, and the PSI
 * timeout/retry defaults that performance_pagespeed (#7) inherits.
 * Everything else is tested through the MCP client harness.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/infra/config.js';
import { createHttpClient, type Endpoint, type HttpRequest } from '../src/infra/http.js';
import { createLogger } from '../src/infra/logger.js';
import { createSecretScrubber } from '../src/security/secrets.js';
import { CapturedStream, TEST_API_KEY } from './support/harness.js';
import { fakeFetch, type FakeReply } from './support/fake-google.js';

function setup(reply: () => FakeReply | Promise<FakeReply>, env: Record<string, string> = {}) {
  const fetch = fakeFetch(reply);
  const sleeps: number[] = [];
  const stderr = new CapturedStream();
  const http = createHttpClient({
    fetch,
    apiKey: TEST_API_KEY,
    policies: loadConfig({ GOOGLE_API_KEY: TEST_API_KEY, ...env }).upstream,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  const logger = createLogger({ stream: stderr, now: () => new Date(0), scrub: createSecretScrubber([]) });
  const request = (endpoint: Endpoint, extra: Partial<HttpRequest> = {}) =>
    http.request({ endpoint, method: 'GET', logger, ...extra });
  return { fetch, sleeps, stderr, request };
}

describe('HTTP client destinations', () => {
  it.each(['https://evil.example/', 'constructor', 'toString', '__proto__'])(
    'refuses an endpoint outside the fixed Google endpoints (%s) without calling fetch',
    async (endpoint) => {
      const { fetch, request } = setup(() => ({ status: 200, body: {} }));

      await expect(request(endpoint as Endpoint)).rejects.toMatchObject({
        code: 'internal_error',
        source: 'perfkit',
        retryable: false,
      });
      expect(fetch.calls).toHaveLength(0);
    },
  );

  it('calls only the fixed PageSpeed Insights URL, with the key in a header', async () => {
    const { fetch, request } = setup(() => ({ status: 200, body: {} }));

    await request('pagespeed', { query: { url: 'https://example.com/', category: ['performance', 'seo'] } });

    const call = fetch.calls[0];
    expect(`${call?.url.origin}${call?.url.pathname}`).toBe(
      'https://www.googleapis.com/pagespeedonline/v5/runPagespeed',
    );
    expect(call?.url.searchParams.getAll('category')).toEqual(['performance', 'seo']);
    expect(call?.url.href).not.toContain(TEST_API_KEY);
    expect(call?.headers.get('x-goog-api-key')).toBe(TEST_API_KEY);
  });
});

describe('HTTP client PSI policy', () => {
  it('retries PageSpeed Insights once by default', async () => {
    const { fetch, sleeps, request } = setup(() => ({ status: 503, body: {} }));

    const res = await request('pagespeed');

    expect(res.status).toBe(503);
    expect(fetch.calls).toHaveLength(2);
    expect(sleeps).toHaveLength(1);
  });

  it('honours PERFKIT_PSI_RETRIES and PERFKIT_PSI_TIMEOUT_MS', async () => {
    const { fetch, stderr, request } = setup(() => new Promise<FakeReply>(() => {}), {
      PERFKIT_PSI_RETRIES: '2',
      PERFKIT_PSI_TIMEOUT_MS: '5',
    });

    await expect(request('pagespeed')).rejects.toMatchObject({
      code: 'upstream_timeout',
      source: 'pagespeed',
      retryable: true,
    });
    expect(fetch.calls).toHaveLength(3);
    expect(stderr.jsonLines()).toContainEqual(expect.objectContaining({ msg: 'upstream timeout', timeoutMs: 5 }));
  });

  it('defaults to a 60 s PSI timeout and a 10 s CrUX timeout', () => {
    const { upstream } = loadConfig({ GOOGLE_API_KEY: TEST_API_KEY });
    expect(upstream).toEqual({ pagespeed: { timeoutMs: 60_000, retries: 1 }, crux: { timeoutMs: 10_000, retries: 3 } });
  });
});

describe('HTTP client cancellation', () => {
  it('stops at once with upstream_timeout when the caller aborts (e.g. an overview budget)', async () => {
    const { fetch, request } = setup(() => new Promise<FakeReply>(() => {}));
    const budget = new AbortController();
    const pending = request('pagespeed', { signal: budget.signal });

    budget.abort();

    await expect(pending).rejects.toMatchObject({ code: 'upstream_timeout', source: 'pagespeed', retryable: true });
    expect(fetch.calls).toHaveLength(1);
  });
});

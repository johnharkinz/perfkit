import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectPerfkit, TEST_API_KEY, type Perfkit } from './support/harness.js';
import { fakeFetch, fixture, type FakeReply } from './support/fake-google.js';

let perfkit: Perfkit | undefined;
afterEach(async () => {
  await perfkit?.close();
  perfkit = undefined;
});

const CRUX_OK = (): FakeReply => ({ status: 200, body: fixture('crux/current-url-phone.json') });
const googleError = (code: number, status: string): FakeReply => ({
  status: code,
  body: { error: { code, message: `upstream says ${status}`, status } },
});

/** Replies with each scripted reply in turn, then repeats the last one. */
function script(...replies: (() => FakeReply)[]) {
  let i = 0;
  return fakeFetch(() => (replies[Math.min(i++, replies.length - 1)] as () => FakeReply)());
}

async function callCruxCurrent(p: Perfkit) {
  return p.client.callTool({ name: 'performance_crux_current', arguments: { url: 'https://developer.chrome.com/' } });
}

describe('upstream retries', () => {
  it('retries a 5xx from CrUX and returns the data once Google recovers', async () => {
    const fetch = script(() => googleError(503, 'UNAVAILABLE'), CRUX_OK);
    perfkit = await connectPerfkit({ fetch });

    const res = await callCruxCurrent(perfkit);

    expect(res.isError ?? false).toBe(false);
    expect(res.structuredContent).toMatchObject({ status: 'ok' });
    expect(fetch.calls).toHaveLength(2);
    expect(perfkit.sleeps).toHaveLength(1);
  });

  it('gives up on a persistent 429 after 3 CrUX retries with upstream_rate_limit, retryable', async () => {
    const fetch = script(() => googleError(429, 'RESOURCE_EXHAUSTED'));
    perfkit = await connectPerfkit({ fetch });

    const res = await callCruxCurrent(perfkit);

    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({
      status: 'error',
      error: { code: 'upstream_rate_limit', source: 'crux', retryable: true },
    });
    expect(fetch.calls).toHaveLength(4);
  });

  it('gives up on a persistent 5xx with upstream_error, retryable', async () => {
    const fetch = script(() => googleError(500, 'INTERNAL'));
    perfkit = await connectPerfkit({ fetch });

    const res = await callCruxCurrent(perfkit);

    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({
      error: { code: 'upstream_error', source: 'crux', retryable: true },
    });
    expect(fetch.calls).toHaveLength(4);
  });

  it.each([400, 403])('does not retry a %i and reports it as non-retryable upstream_error', async (code) => {
    const fetch = script(() => googleError(code, 'INVALID_ARGUMENT'));
    perfkit = await connectPerfkit({ fetch });

    const res = await callCruxCurrent(perfkit);

    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({
      error: { code: 'upstream_error', source: 'crux', retryable: false },
    });
    expect(fetch.calls).toHaveLength(1);
    expect(perfkit.sleeps).toHaveLength(0);
  });

  it('backs off exponentially with jitter between attempts', async () => {
    perfkit = await connectPerfkit({ fetch: script(() => googleError(503, 'UNAVAILABLE')), random: () => 0 });
    await callCruxCurrent(perfkit);
    expect(perfkit.sleeps).toEqual([250, 500, 1000]);
    await perfkit.close();

    perfkit = await connectPerfkit({ fetch: script(() => googleError(503, 'UNAVAILABLE')), random: () => 0.999999 });
    await callCruxCurrent(perfkit);
    expect(perfkit.sleeps).toEqual([500, 1000, 2000]);
  });

  it('takes the CrUX retry limit from PERFKIT_CRUX_RETRIES', async () => {
    const fetch = script(() => googleError(503, 'UNAVAILABLE'));
    perfkit = await connectPerfkit({
      fetch,
      env: { GOOGLE_API_KEY: TEST_API_KEY, PERFKIT_CRUX_RETRIES: '1' },
    });

    await callCruxCurrent(perfkit);

    expect(fetch.calls).toHaveLength(2);
  });
});

describe('upstream timeouts', () => {
  /** A Google that never answers. */
  const hang = () => fakeFetch(() => new Promise<FakeReply>(() => {}));

  it('times out each attempt after PERFKIT_CRUX_TIMEOUT_MS, retries, then reports upstream_timeout', async () => {
    const fetch = hang();
    perfkit = await connectPerfkit({
      fetch,
      env: { GOOGLE_API_KEY: TEST_API_KEY, PERFKIT_CRUX_TIMEOUT_MS: '5' },
    });

    const res = await callCruxCurrent(perfkit);

    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({
      status: 'error',
      error: { code: 'upstream_timeout', source: 'crux', retryable: true },
    });
    expect(fetch.calls).toHaveLength(4);
    const timeouts = perfkit.stderr.jsonLines().filter((l) => l['msg'] === 'upstream timeout');
    expect(timeouts).toHaveLength(4);
    expect(timeouts[0]).toMatchObject({ endpoint: 'cruxCurrent', timeoutMs: 5, correlationId: expect.any(String) });
  });

  it('recovers when a retry answers after an attempt timed out', async () => {
    let first = true;
    const fetch = fakeFetch(() => {
      if (first) {
        first = false;
        return new Promise<FakeReply>(() => {});
      }
      return CRUX_OK();
    });
    perfkit = await connectPerfkit({
      fetch,
      env: { GOOGLE_API_KEY: TEST_API_KEY, PERFKIT_CRUX_TIMEOUT_MS: '5' },
    });

    const res = await callCruxCurrent(perfkit);

    expect(res.structuredContent).toMatchObject({ status: 'ok' });
    expect(fetch.calls).toHaveLength(2);
  });
});

describe('PageSpeed Insights policy', () => {
  const callPagespeed = (p: Perfkit) =>
    p.client.callTool({ name: 'performance_pagespeed', arguments: { url: 'https://developer.chrome.com/' } });

  it('retries a PSI 5xx once by default, then reports upstream_error, retryable', async () => {
    const fetch = script(() => googleError(503, 'UNAVAILABLE'));
    perfkit = await connectPerfkit({ fetch });

    const res = await callPagespeed(perfkit);

    expect(res.structuredContent).toMatchObject({
      status: 'error',
      error: { code: 'upstream_error', source: 'pagespeed', retryable: true },
    });
    expect(fetch.calls).toHaveLength(2);
    expect(perfkit.sleeps).toHaveLength(1);
  });

  it('takes the PSI retry limit and timeout from PERFKIT_PSI_RETRIES and PERFKIT_PSI_TIMEOUT_MS', async () => {
    const fetch = fakeFetch(() => new Promise<FakeReply>(() => {}));
    perfkit = await connectPerfkit({
      fetch,
      env: { GOOGLE_API_KEY: TEST_API_KEY, PERFKIT_PSI_RETRIES: '2', PERFKIT_PSI_TIMEOUT_MS: '5' },
    });

    const res = await callPagespeed(perfkit);

    expect(res.structuredContent).toMatchObject({
      status: 'error',
      error: { code: 'upstream_timeout', source: 'pagespeed', retryable: true },
    });
    expect(fetch.calls).toHaveLength(3);
    expect(perfkit.stderr.jsonLines()).toContainEqual(
      expect.objectContaining({ msg: 'upstream timeout', endpoint: 'pagespeed', timeoutMs: 5 }),
    );
  });
});

describe('client cancellation', () => {
  it.each(['performance_pagespeed', 'performance_crux_current'])(
    '%s stops at once when the client cancels, and does not report it as an upstream timeout',
    async (name) => {
      const fetch = fakeFetch(() => new Promise<FakeReply>(() => {}));
      perfkit = await connectPerfkit({ fetch });
      const cancel = new AbortController();

      const pending = perfkit.client.callTool(
        { name, arguments: { url: 'https://developer.chrome.com/' } },
        { signal: cancel.signal },
      );
      await vi.waitFor(() => expect(fetch.calls).toHaveLength(1));
      cancel.abort('user pressed stop');

      await expect(pending).rejects.toThrow();
      const failed = await vi.waitFor(() => {
        const line = perfkit?.stderr.jsonLines().find((l) => l['msg'] === 'tool call failed');
        expect(line).toBeDefined();
        return line;
      });
      expect(failed).toMatchObject({ code: 'internal_error', source: 'perfkit' });
      expect(perfkit.stderr.jsonLines()).toContainEqual(
        expect.objectContaining({ msg: 'upstream request cancelled', attempt: 1 }),
      );
      expect(perfkit.stderr.jsonLines()).not.toContainEqual(expect.objectContaining({ code: 'upstream_timeout' }));
      expect(fetch.calls).toHaveLength(1);
    },
  );
});

describe('default timeouts', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['performance_pagespeed', 60_000, 2],
    ['performance_crux_current', 10_000, 4],
  ])('%s gives each attempt %i ms before retrying, %i attempts in all', async (name, timeoutMs, attempts) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fetch = fakeFetch(() => new Promise<FakeReply>(() => {}));
    perfkit = await connectPerfkit({ fetch });

    const pending = perfkit.client.callTool(
      { name, arguments: { url: 'https://developer.chrome.com/' } },
      { timeout: 10 * timeoutMs * attempts },
    );
    // (vi.waitFor would advance the fake clock itself, so only exact advances are used.)
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(timeoutMs - 1);
    expect(fetch.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(timeoutMs * attempts);
    const res = await pending;

    expect(fetch.calls).toHaveLength(attempts);
    expect(res.structuredContent).toMatchObject({ error: { code: 'upstream_timeout', retryable: true } });
  });
});

describe('configuration', () => {
  it.each(['PERFKIT_CRUX_TIMEOUT_MS', 'PERFKIT_CRUX_RETRIES', 'PERFKIT_PSI_TIMEOUT_MS', 'PERFKIT_PSI_RETRIES'])(
    'refuses to start when %s is not a whole number, naming the variable but not the value',
    async (name) => {
      const attempt = connectPerfkit({
        fetch: fakeFetch(CRUX_OK),
        env: { GOOGLE_API_KEY: TEST_API_KEY, [name]: 'soon-ish' },
      });
      await expect(attempt).rejects.toThrow(name);
      await expect(attempt).rejects.not.toThrow('soon-ish');
    },
  );
});

describe('untrusted upstream responses', () => {
  it.each([
    ['a body that is not JSON', 'Service Unavailable<html>'],
    ['a record of the wrong shape', { record: { key: {}, metrics: { largest_contentful_paint: { histogram: 'x' } } } }],
    ['an empty object', {}],
  ])('maps %s on HTTP 200 to a non-retryable upstream_error', async (_label, body) => {
    const fetch = fakeFetch(() => ({ status: 200, body }));
    perfkit = await connectPerfkit({ fetch });

    const res = await callCruxCurrent(perfkit);

    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({
      status: 'error',
      error: { code: 'upstream_error', source: 'crux', retryable: false },
    });
    expect(fetch.calls).toHaveLength(1);
  });
});

describe('upstream logging', () => {
  it('logs each attempt’s latency, the rate limit, the retry and its delay with the correlation ID', async () => {
    perfkit = await connectPerfkit({
      fetch: script(() => googleError(429, 'RESOURCE_EXHAUSTED'), CRUX_OK),
      random: () => 0,
    });

    await callCruxCurrent(perfkit);

    const logs = perfkit.stderr.jsonLines();
    const id = logs.find((l) => l['msg'] === 'tool call started')?.['correlationId'];
    expect(id).toEqual(expect.any(String));
    const upstream = logs.filter((l) => l['endpoint'] === 'cruxCurrent');
    expect(upstream.every((l) => l['correlationId'] === id)).toBe(true);
    expect(upstream).toEqual([
      expect.objectContaining({
        msg: 'upstream rate limited',
        level: 'warn',
        attempt: 1,
        status: 429,
        googleStatus: 'RESOURCE_EXHAUSTED',
        latencyMs: expect.any(Number),
      }),
      expect.objectContaining({ msg: 'upstream retry scheduled', attempt: 1, reason: 'rate_limit', delayMs: 250 }),
      expect.objectContaining({ msg: 'upstream response', attempt: 2, status: 200, latencyMs: expect.any(Number) }),
    ]);
  });

  it('logs upstream errors and when retries run out', async () => {
    perfkit = await connectPerfkit({
      fetch: script(() => googleError(503, 'UNAVAILABLE')),
      env: { GOOGLE_API_KEY: TEST_API_KEY, PERFKIT_CRUX_RETRIES: '0' },
    });

    await callCruxCurrent(perfkit);

    const logs = perfkit.stderr.jsonLines();
    expect(logs).toContainEqual(
      expect.objectContaining({ msg: 'upstream error response', status: 503, googleStatus: 'UNAVAILABLE' }),
    );
    expect(logs).toContainEqual(expect.objectContaining({ msg: 'upstream retries exhausted', attempts: 1 }));
    expect(logs).toContainEqual(
      expect.objectContaining({ msg: 'tool call failed', code: 'upstream_error', source: 'crux' }),
    );
  });
});

describe('API key secrecy', () => {
  const echoedUrl = `https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=${TEST_API_KEY}`;
  const echo = (code: number): FakeReply => ({
    status: code,
    body: {
      error: {
        code,
        message: `Request to ${echoedUrl} failed; API key ${TEST_API_KEY} not valid.`,
        status: code === 429 ? 'RESOURCE_EXHAUSTED' : 'INVALID_ARGUMENT',
        details: [{ '@type': 'type.googleapis.com/google.rpc.Help', links: [{ url: echoedUrl }] }],
      },
    },
  });

  it.each([
    ['a 400 that echoes the key and request URL', () => echo(400)],
    ['a 429 that echoes them', () => echo(429)],
    ['a 503 that echoes them', () => echo(503)],
    ['a malformed 200 that echoes them', (): FakeReply => ({ status: 200, body: { echoedUrl, key: TEST_API_KEY } })],
  ])('never shows the key in the result or stderr for %s', async (_label, reply) => {
    const fetch = fakeFetch(reply);
    perfkit = await connectPerfkit({ fetch });

    const res = await callCruxCurrent(perfkit);

    expect(res.isError).toBe(true);
    expect(JSON.stringify(res)).not.toContain(TEST_API_KEY);
    expect(perfkit.stderr.text).not.toContain(TEST_API_KEY);
    for (const call of fetch.calls) expect(call.url.href).not.toContain(TEST_API_KEY);
  });

  it('never shows the key when fetch itself throws an error mentioning the URL and key', async () => {
    const fetch = (async () => {
      throw new TypeError(`fetch failed for ${echoedUrl} (key ${TEST_API_KEY})`);
    }) as unknown as typeof globalThis.fetch;
    perfkit = await connectPerfkit({ fetch });

    const res = await callCruxCurrent(perfkit);

    expect(res.structuredContent).toMatchObject({
      error: { code: 'upstream_error', source: 'crux', retryable: true },
    });
    expect(JSON.stringify(res)).not.toContain(TEST_API_KEY);
    expect(perfkit.stderr.text).not.toContain(TEST_API_KEY);
  });
});

describe('fixed destinations', () => {
  it('refuses to follow a redirect away from the Google endpoint', async () => {
    const seen: RequestInit[] = [];
    const fetch = (async (_input: unknown, init?: RequestInit) => {
      seen.push(init ?? {});
      if (init?.redirect === 'error') throw new TypeError('redirect mode is set to error');
      return new Response(JSON.stringify(fixture('crux/current-url-phone.json')), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    perfkit = await connectPerfkit({ fetch, env: { GOOGLE_API_KEY: TEST_API_KEY, PERFKIT_CRUX_RETRIES: '0' } });

    const res = await callCruxCurrent(perfkit);

    expect(seen[0]?.redirect).toBe('error');
    expect(res.structuredContent).toMatchObject({ error: { code: 'upstream_error', source: 'crux' } });
  });
});

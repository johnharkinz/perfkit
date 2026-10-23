import { afterEach, describe, expect, it } from 'vitest';
import { connectPerfkit, TEST_API_KEY, TEST_START_TIME, type Perfkit } from './support/harness.js';
import { fakeFetch, fixture } from './support/fake-google.js';

let perfkit: Perfkit | undefined;
afterEach(async () => {
  await perfkit?.close();
  perfkit = undefined;
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function cruxOk() {
  return fakeFetch(() => ({ status: 200, body: fixture('crux/current-url-phone.json') }));
}

async function cruxCurrent(p: Perfkit, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await p.client.callTool({ name: 'performance_crux_current', arguments: args });
  return res.structuredContent as Record<string, unknown>;
}

function withoutCacheFields(result: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(result).filter(([k]) => k !== 'cached' && k !== 'cachedAt'));
}

const ARGS = { url: 'https://developer.chrome.com/', device: 'PHONE' };

describe('provider result cache', () => {
  it('answers a repeat identical call from the cache without a second fetch, saying when it was cached', async () => {
    const fetch = cruxOk();
    perfkit = await connectPerfkit({ fetch });

    const first = await cruxCurrent(perfkit, ARGS);
    perfkit.clock.advance(5 * MINUTE);
    const second = await cruxCurrent(perfkit, ARGS);

    expect(fetch.calls).toHaveLength(1);
    expect(first['cached']).toBe(false);
    expect(first).not.toHaveProperty('cachedAt');
    expect(second['cached']).toBe(true);
    expect(second['cachedAt']).toBe(TEST_START_TIME);
    // collectedAt is when perfkit fetched the evidence from Google, not when it was served.
    expect(second['collectedAt']).toBe(TEST_START_TIME);
    expect(withoutCacheFields(second)).toEqual(withoutCacheFields(first));
  });

  it('misses when any part of the key changes, such as the device or the target', async () => {
    const fetch = cruxOk();
    perfkit = await connectPerfkit({ fetch });

    await cruxCurrent(perfkit, ARGS);
    const desktop = await cruxCurrent(perfkit, { ...ARGS, device: 'DESKTOP' });
    const otherUrl = await cruxCurrent(perfkit, { ...ARGS, url: 'https://developer.chrome.com/blog/' });

    expect(fetch.calls).toHaveLength(3);
    expect(desktop['cached']).toBe(false);
    expect(otherUrl['cached']).toBe(false);
  });

  it('treats URLs that normalise to the same target as the same key', async () => {
    const fetch = cruxOk();
    perfkit = await connectPerfkit({ fetch });

    await cruxCurrent(perfkit, { ...ARGS, url: 'https://developer.chrome.com/#top' });
    const second = await cruxCurrent(perfkit, ARGS);

    expect(fetch.calls).toHaveLength(1);
    expect(second['cached']).toBe(true);
  });

  it('keeps current field data for 12 hours by default', async () => {
    const fetch = cruxOk();
    perfkit = await connectPerfkit({ fetch });

    await cruxCurrent(perfkit, ARGS);
    perfkit.clock.advance(12 * HOUR - 1);
    expect((await cruxCurrent(perfkit, ARGS))['cached']).toBe(true);
    perfkit.clock.advance(1);
    const expired = await cruxCurrent(perfkit, ARGS);

    expect(expired['cached']).toBe(false);
    expect(expired['collectedAt']).toBe('2026-10-24T00:00:00.000Z');
    expect(fetch.calls).toHaveLength(2);
  });

  it('takes the current field data lifetime from PERFKIT_CACHE_TTL_CRUX_CURRENT_SECONDS', async () => {
    const fetch = cruxOk();
    perfkit = await connectPerfkit({
      fetch,
      env: { GOOGLE_API_KEY: TEST_API_KEY, PERFKIT_CACHE_TTL_CRUX_CURRENT_SECONDS: '60' },
    });

    await cruxCurrent(perfkit, ARGS);
    perfkit.clock.advance(59_999);
    expect((await cruxCurrent(perfkit, ARGS))['cached']).toBe(true);
    perfkit.clock.advance(1);
    expect((await cruxCurrent(perfkit, ARGS))['cached']).toBe(false);
    expect(fetch.calls).toHaveLength(2);
  });

  it('does not cache errors: the next identical call fetches again', async () => {
    let failing = true;
    const fetch = fakeFetch(() =>
      failing
        ? { status: 400, body: { error: { code: 400, message: 'bad', status: 'INVALID_ARGUMENT' } } }
        : { status: 200, body: fixture('crux/current-url-phone.json') },
    );
    perfkit = await connectPerfkit({ fetch });

    const first = await cruxCurrent(perfkit, ARGS);
    failing = false;
    const second = await cruxCurrent(perfkit, ARGS);

    expect(first['status']).toBe('error');
    expect(second['status']).toBe('ok');
    expect(second['cached']).toBe(false);
    expect(fetch.calls).toHaveLength(2);
  });

  it('is bounded: beyond PERFKIT_CACHE_MAX_ENTRIES the least recently used entry is evicted', async () => {
    const fetch = cruxOk();
    perfkit = await connectPerfkit({ fetch, env: { GOOGLE_API_KEY: TEST_API_KEY, PERFKIT_CACHE_MAX_ENTRIES: '2' } });
    const a = { ...ARGS, url: 'https://example.com/a' };
    const b = { ...ARGS, url: 'https://example.com/b' };
    const c = { ...ARGS, url: 'https://example.com/c' };

    await cruxCurrent(perfkit, a);
    await cruxCurrent(perfkit, b);
    await cruxCurrent(perfkit, a); // a is now more recently used than b
    await cruxCurrent(perfkit, c); // evicts b
    expect(fetch.calls).toHaveLength(3);

    expect((await cruxCurrent(perfkit, a))['cached']).toBe(true);
    expect((await cruxCurrent(perfkit, c))['cached']).toBe(true);
    expect((await cruxCurrent(perfkit, b))['cached']).toBe(false);
    expect(fetch.calls).toHaveLength(4);
  });

  it('logs cache misses and hits without logging the target', async () => {
    perfkit = await connectPerfkit({ fetch: cruxOk() });
    const args = { ...ARGS, url: 'https://example.com/private-path' };

    await cruxCurrent(perfkit, args);
    await cruxCurrent(perfkit, args);

    const cacheLogs = perfkit.stderr.jsonLines().filter((l) => String(l['msg']).startsWith('cache '));
    expect(cacheLogs.map((l) => l['msg'])).toEqual(['cache miss', 'cache hit']);
    for (const line of cacheLogs) {
      expect(line).toMatchObject({ cacheKind: 'cruxCurrent', provider: 'crux', device: 'PHONE' });
      expect(line['correlationId']).toEqual(expect.any(String));
    }
    expect(perfkit.stderr.text).not.toContain('private-path');
  });

  it('rejects a cache setting that is not a whole number at startup, naming the variable', async () => {
    await expect(
      connectPerfkit({ fetch: cruxOk(), env: { GOOGLE_API_KEY: TEST_API_KEY, PERFKIT_CACHE_MAX_ENTRIES: 'lots' } }),
    ).rejects.toThrow(/PERFKIT_CACHE_MAX_ENTRIES/);
  });
});

/**
 * Opt-in live test against the real CrUX API:
 *   LIVE=1 GOOGLE_API_KEY=... npm run test:live
 * Checks shape only, never specific values. Skips cleanly without LIVE=1.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { connectPerfkit, type Perfkit } from '../support/harness.js';

const live = process.env['LIVE'] === '1';
const apiKey = process.env['GOOGLE_API_KEY'] ?? '';

let perfkit: Perfkit | undefined;
afterEach(async () => {
  await perfkit?.close();
  perfkit = undefined;
});

describe.skipIf(!live)('live: performance_crux_current', () => {
  it('returns current field data for https://developer.chrome.com/ on PHONE', async () => {
    expect(apiKey, 'LIVE=1 needs GOOGLE_API_KEY').not.toBe('');
    perfkit = await connectPerfkit({ fetch: globalThis.fetch, env: { GOOGLE_API_KEY: apiKey } });

    const res = await perfkit.client.callTool({
      name: 'performance_crux_current',
      arguments: { url: 'https://developer.chrome.com/', device: 'PHONE' },
    });

    expect(res.isError ?? false).toBe(false);
    const out = res.structuredContent as Record<string, unknown>;
    expect(out).toMatchObject({
      schemaVersion: '1.0.0',
      provider: 'crux',
      dataType: 'field_current',
      scope: 'url',
      device: 'PHONE',
      status: 'ok',
      collectionPeriod: {
        start: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        end: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      },
    });
    const metrics = out['metrics'] as Record<string, { p75: unknown; rating: unknown; histogram: unknown[] }>;
    for (const name of ['INP', 'LCP', 'CLS']) {
      expect(metrics[name]?.p75).toEqual(expect.any(Number));
      expect(['good', 'needs_improvement', 'poor']).toContain(metrics[name]?.rating);
      expect(metrics[name]?.histogram.length).toBeGreaterThan(0);
    }
    expect(JSON.stringify(res)).not.toContain(apiKey);
    expect(perfkit.stderr.text).not.toContain(apiKey);
  });
});

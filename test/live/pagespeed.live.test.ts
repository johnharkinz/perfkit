/**
 * Opt-in live test against the real PageSpeed Insights API:
 *   LIVE=1 GOOGLE_API_KEY=... npm run test:live
 * Checks shape only, never specific values. Skips cleanly without LIVE=1.
 * A PSI run takes 10–30 s and sometimes over 60 s, hence the long timeout.
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

describe.skipIf(!live)('live: performance_pagespeed', () => {
  it('returns lab data for https://developer.chrome.com/ on PHONE', { timeout: 150_000 }, async () => {
    expect(apiKey, 'LIVE=1 needs GOOGLE_API_KEY').not.toBe('');
    perfkit = await connectPerfkit({ fetch: globalThis.fetch, env: { GOOGLE_API_KEY: apiKey } });

    const res = await perfkit.client.callTool(
      {
        name: 'performance_pagespeed',
        arguments: { url: 'https://developer.chrome.com/', device: 'PHONE', categories: ['performance', 'seo'] },
      },
      { timeout: 140_000 },
    );

    expect(res.isError ?? false).toBe(false);
    const out = res.structuredContent as Record<string, unknown>;
    expect(out).toMatchObject({
      schemaVersion: '1.0.0',
      provider: 'pagespeed',
      dataType: 'lab',
      device: 'PHONE',
      strategy: 'mobile',
      status: 'ok',
      performanceScore: expect.any(Number),
      lighthouseVersion: expect.stringMatching(/^\d+\.\d+\.\d+/),
      finalUrl: expect.stringMatching(/^https:\/\//),
      categoryScores: { seo: expect.any(Number) },
    });
    const labMetrics = out['labMetrics'] as Record<string, { value: unknown; unit: unknown }>;
    for (const name of ['FCP', 'LCP', 'CLS', 'TBT', 'SI']) {
      expect(labMetrics[name]?.value).toEqual(expect.any(Number));
    }
    const audits = out['audits'] as { id: string; title: string }[];
    expect(audits.length).toBeGreaterThan(0);
    expect(audits.length).toBeLessThanOrEqual(10);
    for (const a of audits) expect(a).toMatchObject({ id: expect.any(String), title: expect.any(String) });
    expect(JSON.stringify(res)).not.toMatch(/loadingExperience/);
    expect(JSON.stringify(res)).not.toContain(apiKey);
    expect(perfkit.stderr.text).not.toContain(apiKey);
  });
});

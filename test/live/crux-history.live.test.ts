/**
 * Opt-in live test against the real CrUX History API:
 *   LIVE=1 GOOGLE_API_KEY=... npm run test:live
 * Checks shape only, never specific values. Skips cleanly without LIVE=1.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { connectPerfkit, type Perfkit } from '../support/harness.js';

const live = process.env['LIVE'] === '1';
const apiKey = process.env['GOOGLE_API_KEY'] ?? '';
const DATE = /^\d{4}-\d{2}-\d{2}$/;

let perfkit: Perfkit | undefined;
afterEach(async () => {
  await perfkit?.close();
  perfkit = undefined;
});

describe.skipIf(!live)('live: performance_crux_history', () => {
  it('returns dated field history series for https://developer.chrome.com/ on PHONE', async () => {
    expect(apiKey, 'LIVE=1 needs GOOGLE_API_KEY').not.toBe('');
    perfkit = await connectPerfkit({ fetch: globalThis.fetch, env: { GOOGLE_API_KEY: apiKey } });

    const res = await perfkit.client.callTool({
      name: 'performance_crux_history',
      arguments: { url: 'https://developer.chrome.com/', device: 'PHONE', periods: 10 },
    });

    expect(res.isError ?? false).toBe(false);
    const out = res.structuredContent as Record<string, unknown> & {
      collectionPeriods: { start: string; end: string }[];
      metrics: Record<string, { start: string; end: string; p75: unknown; rating: unknown }[]>;
      warnings: string[];
    };
    expect(out).toMatchObject({
      schemaVersion: '1.0.0',
      provider: 'crux',
      dataType: 'field_history',
      scope: 'url',
      device: 'PHONE',
      status: 'ok',
      periods: 10,
    });
    expect(out.collectionPeriods).toHaveLength(10);
    for (const period of out.collectionPeriods) {
      expect(period.start).toMatch(DATE);
      expect(period.end).toMatch(DATE);
    }
    for (const name of ['INP', 'LCP', 'CLS']) {
      const series = out.metrics[name] ?? [];
      expect(series).toHaveLength(10);
      for (const point of series) {
        expect(point.p75 === null || typeof point.p75 === 'number').toBe(true);
        expect([null, 'good', 'needs_improvement', 'poor']).toContain(point.rating);
      }
    }
    expect(out.warnings.some((w) => /overlapping 28-day windows/.test(w))).toBe(true);
    expect(JSON.stringify(res)).not.toContain(apiKey);
    expect(perfkit.stderr.text).not.toContain(apiKey);
  });
});

/**
 * Opt-in live test of performance_overview against the real Google APIs:
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

describe.skipIf(!live)('live: performance_overview', () => {
  it('returns every section for https://developer.chrome.com/ on PHONE within the budget', async () => {
    expect(apiKey, 'LIVE=1 needs GOOGLE_API_KEY').not.toBe('');
    perfkit = await connectPerfkit({ fetch: globalThis.fetch, env: { GOOGLE_API_KEY: apiKey } });

    const res = await perfkit.client.callTool({
      name: 'performance_overview',
      arguments: { url: 'https://developer.chrome.com/', device: 'PHONE' },
    });

    const out = res.structuredContent as Record<string, unknown>;
    expect(out).toMatchObject({
      schemaVersion: '1.0.0',
      device: 'PHONE',
      includeHistory: true,
      lab: { dataType: 'lab', strategy: 'mobile' },
      field: {
        url: { current: { dataType: 'field_current', scope: 'url' }, history: { dataType: 'field_history' } },
        origin: { current: { scope: 'origin' }, history: { scope: 'origin' } },
      },
    });
    expect(['ok', 'partial']).toContain(out['status']);
    expect(JSON.stringify(res)).not.toContain(apiKey);
    expect(perfkit.stderr.text).not.toContain(apiKey);
  }, 90_000);
});

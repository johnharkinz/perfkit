import { afterEach, describe, expect, it } from 'vitest';
import { connectPerfkit, type Perfkit } from './support/harness.js';
import { fakeFetch, fixture } from './support/fake-google.js';

let perfkit: Perfkit | undefined;
afterEach(async () => {
  await perfkit?.close();
  perfkit = undefined;
});

async function callCurrent(args: Record<string, unknown>) {
  if (!perfkit) throw new Error('connect first');
  return perfkit.client.callTool({ name: 'performance_crux_current', arguments: args });
}

describe('performance_crux_current: origin scope', () => {
  it('queries the origin derived from the URL (scheme plus host) and reports origin-scoped field data', async () => {
    const fetch = fakeFetch(() => ({ status: 200, body: fixture('crux/current-origin-phone.json') }));
    perfkit = await connectPerfkit({ fetch });

    const res = await callCurrent({ url: 'https://developer.chrome.com/docs/crux?b=1#x', scope: 'origin' });

    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]?.body).toMatchObject({ origin: 'https://developer.chrome.com', formFactor: 'PHONE' });
    expect(fetch.calls[0]?.body).not.toHaveProperty('url');
    expect(res.isError ?? false).toBe(false);
    expect(res.structuredContent).toMatchObject({
      requestedUrl: 'https://developer.chrome.com/docs/crux?b=1',
      scope: 'origin',
      status: 'ok',
      requestedKey: { origin: 'https://developer.chrome.com', formFactor: 'PHONE' },
      returnedKey: { origin: 'https://developer.chrome.com', formFactor: 'PHONE' },
      warnings: [],
      metrics: { INP: { p75: 168, rating: 'good' }, LCP: { p75: 2318 } },
    });
  });

  it.each([
    ['https://www.example.com/a?b=1', 'https://www.example.com'],
    ['https://example.com/a?b=1', 'https://example.com'],
    ['http://example.com:8080/x', 'http://example.com:8080'],
  ])('derives the origin of %s as %s, keeping www. and bare hosts distinct', async (url, origin) => {
    const body = fixture<{ record: { key: Record<string, string> } }>('crux/current-origin-phone.json');
    body.record.key = { formFactor: 'PHONE', origin };
    const fetch = fakeFetch(() => ({ status: 200, body }));
    perfkit = await connectPerfkit({ fetch });

    const res = await callCurrent({ url, scope: 'origin' });

    expect(fetch.calls[0]?.body).toMatchObject({ origin });
    expect(res.structuredContent).toMatchObject({ requestedKey: { origin }, returnedKey: { origin }, warnings: [] });
  });
});

describe('performance_crux_current: no data', () => {
  it('reports a CrUX 404 for a URL as no_data (not an MCP error) with a hint, and never falls back to the origin', async () => {
    const fetch = fakeFetch(() => ({ status: 404, body: fixture('crux/current-not-found.json') }));
    perfkit = await connectPerfkit({ fetch });

    const res = await callCurrent({ url: 'https://developer.chrome.com/low-traffic', device: 'TABLET' });

    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]?.body).toMatchObject({ url: 'https://developer.chrome.com/low-traffic' });
    expect(res.isError ?? false).toBe(false);
    const result = res.structuredContent as Record<string, unknown> & { warnings: string[] };
    expect(result).toMatchObject({
      schemaVersion: '1.0.0',
      provider: 'crux',
      dataType: 'field_current',
      scope: 'url',
      device: 'TABLET',
      status: 'no_data',
      requestedUrl: 'https://developer.chrome.com/low-traffic',
      requestedKey: { url: 'https://developer.chrome.com/low-traffic', formFactor: 'TABLET' },
      metrics: {},
      omittedMetrics: ['INP', 'LCP', 'CLS', 'FCP', 'TTFB'],
    });
    expect(result).not.toHaveProperty('error');
    expect(result).not.toHaveProperty('returnedKey');
    expect(result).not.toHaveProperty('collectionPeriod');
    expect(result.warnings.join(' ')).toMatch(/scope.*origin/i);
  });

  it('reports a CrUX 404 for an origin as no_data without suggesting origin scope again', async () => {
    const fetch = fakeFetch(() => ({ status: 404, body: fixture('crux/current-not-found.json') }));
    perfkit = await connectPerfkit({ fetch });

    const res = await callCurrent({ url: 'https://tiny.example.org/', scope: 'origin' });

    expect(fetch.calls).toHaveLength(1);
    expect(res.isError ?? false).toBe(false);
    const result = res.structuredContent as { status: string; scope: string; warnings: string[] };
    expect(result).toMatchObject({
      status: 'no_data',
      scope: 'origin',
      requestedKey: { origin: 'https://tiny.example.org' },
    });
    expect(result.warnings.join(' ')).not.toMatch(/scope.*origin/i);
  });
});

describe('performance_crux_current: device', () => {
  it.each(['PHONE', 'DESKTOP', 'TABLET'])('sends formFactor %s to CrUX', async (device) => {
    const body = fixture<{ record: { key: Record<string, string> } }>('crux/current-url-phone.json');
    body.record.key = { formFactor: device, url: 'https://developer.chrome.com/' };
    const fetch = fakeFetch(() => ({ status: 200, body }));
    perfkit = await connectPerfkit({ fetch });

    const res = await callCurrent({ url: 'https://developer.chrome.com/', device });

    expect(fetch.calls[0]?.body).toMatchObject({ formFactor: device });
    expect(res.structuredContent).toMatchObject({ device, returnedKey: { formFactor: device }, warnings: [] });
  });

  it('sends no form factor for ALL and reports device ALL', async () => {
    const body = fixture<{ record: { key: Record<string, string> } }>('crux/current-url-phone.json');
    body.record.key = { url: 'https://developer.chrome.com/' };
    const fetch = fakeFetch(() => ({ status: 200, body }));
    perfkit = await connectPerfkit({ fetch });

    const res = await callCurrent({ url: 'https://developer.chrome.com/', device: 'ALL' });

    expect(fetch.calls[0]?.body).not.toHaveProperty('formFactor');
    expect(res.structuredContent).toMatchObject({
      device: 'ALL',
      status: 'ok',
      requestedKey: { url: 'https://developer.chrome.com/' },
      returnedKey: { url: 'https://developer.chrome.com/' },
    });
    const result = res.structuredContent as { requestedKey: object; returnedKey: object };
    expect(result.requestedKey).not.toHaveProperty('formFactor');
    expect(result.returnedKey).not.toHaveProperty('formFactor');
  });

  it('rejects an unknown device', async () => {
    const fetch = fakeFetch(() => ({ status: 200, body: fixture('crux/current-url-phone.json') }));
    perfkit = await connectPerfkit({ fetch });

    const res = await callCurrent({ url: 'https://developer.chrome.com/', device: 'WATCH' });

    expect(res.isError).toBe(true);
    expect(fetch.calls).toHaveLength(0);
  });
});

describe('performance_crux_current: omitted metrics', () => {
  it('lists metrics Google did not return in omittedMetrics and leaves them out of metrics', async () => {
    perfkit = await connectPerfkit({
      fetch: fakeFetch(() => ({ status: 200, body: fixture('crux/current-url-tablet-no-inp.json') })),
    });

    const res = await callCurrent({ url: 'https://developer.chrome.com/', device: 'TABLET' });

    const result = res.structuredContent as { metrics: Record<string, unknown>; omittedMetrics: string[] };
    expect(result.omittedMetrics).toEqual(['INP', 'TTFB']);
    expect(Object.keys(result.metrics).sort()).toEqual(['CLS', 'FCP', 'LCP']);
  });

  it('reports an empty omittedMetrics when every metric was returned', async () => {
    perfkit = await connectPerfkit({
      fetch: fakeFetch(() => ({ status: 200, body: fixture('crux/current-url-phone.json') })),
    });

    const res = await callCurrent({ url: 'https://developer.chrome.com/' });

    expect(res.structuredContent).toMatchObject({ omittedMetrics: [] });
  });
});

describe('performance_crux_current: returned key', () => {
  it('reports the key CrUX returned and warns, without changing scope, when it differs from the request', async () => {
    const body = fixture<{ record: { key: Record<string, string> }; urlNormalizationDetails?: unknown }>(
      'crux/current-url-phone.json',
    );
    body.record.key = { formFactor: 'PHONE', url: 'https://developer.chrome.com/docs/' };
    body.urlNormalizationDetails = {
      originalUrl: 'https://developer.chrome.com/docs',
      normalizedUrl: 'https://developer.chrome.com/docs/',
    };
    perfkit = await connectPerfkit({ fetch: fakeFetch(() => ({ status: 200, body })) });

    const res = await callCurrent({ url: 'https://developer.chrome.com/docs' });

    const result = res.structuredContent as { warnings: string[] };
    expect(result).toMatchObject({
      scope: 'url',
      status: 'ok',
      requestedKey: { url: 'https://developer.chrome.com/docs', formFactor: 'PHONE' },
      returnedKey: { url: 'https://developer.chrome.com/docs/', formFactor: 'PHONE' },
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('https://developer.chrome.com/docs/');
  });

  it('warns when an origin query comes back keyed to a different origin, keeping origin scope', async () => {
    const body = fixture<{ record: { key: Record<string, string> } }>('crux/current-origin-phone.json');
    body.record.key = { formFactor: 'PHONE', origin: 'https://example.com' };
    perfkit = await connectPerfkit({ fetch: fakeFetch(() => ({ status: 200, body })) });

    const res = await callCurrent({ url: 'https://www.example.com/a', scope: 'origin' });

    const result = res.structuredContent as { warnings: string[] };
    expect(result).toMatchObject({
      scope: 'origin',
      requestedKey: { origin: 'https://www.example.com' },
      returnedKey: { origin: 'https://example.com' },
    });
    expect(result.warnings).toHaveLength(1);
  });
});

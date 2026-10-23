import { afterEach, describe, expect, it } from 'vitest';
import { connectPerfkit, TEST_API_KEY, type Perfkit } from './support/harness.js';
import { fakeFetch, fixture } from './support/fake-google.js';

let perfkit: Perfkit | undefined;
afterEach(async () => {
  await perfkit?.close();
  perfkit = undefined;
});

async function callHistory(args: Record<string, unknown>) {
  if (!perfkit) throw new Error('connect first');
  return perfkit.client.callTool({ name: 'performance_crux_history', arguments: args });
}

describe('performance_crux_history: listing', () => {
  it('is listed with input and output schemas and says points are overlapping 28-day windows updated weekly', async () => {
    perfkit = await connectPerfkit({ fetch: fakeFetch(() => ({ status: 500, body: {} })) });

    const { tools } = await perfkit.client.listTools();
    const tool = tools.find((t) => t.name === 'performance_crux_history');

    expect(tool).toBeDefined();
    expect(tool?.inputSchema.properties).toHaveProperty('url');
    expect(tool?.inputSchema.properties).toHaveProperty('scope');
    expect(tool?.inputSchema.properties).toHaveProperty('device');
    expect(tool?.inputSchema.properties).toHaveProperty('periods');
    expect(tool?.outputSchema?.properties).toHaveProperty('metrics');
    expect(tool?.description).toMatch(/overlapping 28-day windows/i);
    expect(tool?.description).toMatch(/weekly/i);
  });

  it('says it is field data, not lab data, and points to performance_pagespeed for lab data', async () => {
    perfkit = await connectPerfkit({ fetch: fakeFetch(() => ({ status: 500, body: {} })) });

    const { tools } = await perfkit.client.listTools();
    const description = tools.find((t) => t.name === 'performance_crux_history')?.description ?? '';

    expect(description).toMatch(/field data, not lab data/i);
    expect(description).toMatch(/performance_pagespeed/);
  });
});

const OVERLAP_WARNING = /overlapping 28-day windows, not independent samples/i;

describe('performance_crux_history: URL history', () => {
  it('asks the History API for 40 windows by default and returns dated, rated series per metric with the overlap warning', async () => {
    const fetch = fakeFetch(() => ({ status: 200, body: fixture('crux/history-url-phone.json') }));
    perfkit = await connectPerfkit({ fetch });

    const res = await callHistory({ url: 'https://developer.chrome.com/' });

    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]?.url.href).toBe('https://chromeuxreport.googleapis.com/v1/records:queryHistoryRecord');
    expect(fetch.calls[0]?.method).toBe('POST');
    expect(fetch.calls[0]?.body).toEqual({
      url: 'https://developer.chrome.com/',
      formFactor: 'PHONE',
      collectionPeriodCount: 40,
      metrics: [
        'interaction_to_next_paint',
        'largest_contentful_paint',
        'cumulative_layout_shift',
        'first_contentful_paint',
        'experimental_time_to_first_byte',
      ],
    });
    expect(res.isError ?? false).toBe(false);
    const out = res.structuredContent as Record<string, unknown> & {
      warnings: string[];
      metrics: Record<string, unknown[]>;
      collectionPeriods: unknown[];
    };
    expect(out).toMatchObject({
      schemaVersion: '1.0.0',
      requestedUrl: 'https://developer.chrome.com/',
      provider: 'crux',
      dataType: 'field_history',
      scope: 'url',
      device: 'PHONE',
      status: 'ok',
      periods: 40,
      collectedAt: '2026-10-23T12:00:00.000Z',
      cached: false,
      requestedKey: { url: 'https://developer.chrome.com/', formFactor: 'PHONE' },
      returnedKey: { url: 'https://developer.chrome.com/', formFactor: 'PHONE' },
      units: { INP: 'ms', LCP: 'ms', CLS: 'unitless', FCP: 'ms', TTFB: 'ms' },
      omittedMetrics: [],
    });
    expect(out.collectionPeriods).toHaveLength(40);
    expect(out.collectionPeriods[0]).toEqual({ start: '2025-12-21', end: '2026-01-17' });
    expect(out.collectionPeriods[39]).toEqual({ start: '2026-09-20', end: '2026-10-17' });
    for (const name of ['INP', 'LCP', 'CLS', 'FCP', 'TTFB']) expect(out.metrics[name]).toHaveLength(40);
    expect(out.metrics['INP']?.[0]).toEqual({
      start: '2025-12-21',
      end: '2026-01-17',
      p75: 290,
      rating: 'needs_improvement',
    });
    expect(out.metrics['INP']?.[39]).toEqual({
      start: '2026-09-20',
      end: '2026-10-17',
      p75: 310,
      rating: 'needs_improvement',
    });
    expect(out.metrics['CLS']?.[39]).toEqual({ start: '2026-09-20', end: '2026-10-17', p75: 0.02, rating: 'good' });
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toMatch(OVERLAP_WARNING);
  });

  it('computes no deltas, percentage changes or sample counts', async () => {
    const fetch = fakeFetch(() => ({ status: 200, body: fixture('crux/history-url-phone.json') }));
    perfkit = await connectPerfkit({ fetch });

    const res = await callHistory({ url: 'https://developer.chrome.com/' });

    // The fixed overlap warning mentions "samples"; check the data, not the prose.
    const data = Object.entries(res.structuredContent as Record<string, unknown>).filter(([k]) => k !== 'warnings');
    expect(JSON.stringify(data)).not.toMatch(/delta|change|percent|sample|count|trend/i);
    const out = res.structuredContent as { metrics: Record<string, Record<string, unknown>[]> };
    for (const point of out.metrics['LCP'] ?? [])
      expect(Object.keys(point).sort()).toEqual(['end', 'p75', 'rating', 'start']);
  });
});

describe('performance_crux_history: periods', () => {
  it('sends the requested number of windows', async () => {
    const fetch = fakeFetch(() => ({ status: 200, body: fixture('crux/history-url-phone-gaps.json') }));
    perfkit = await connectPerfkit({ fetch });

    const res = await callHistory({ url: 'https://developer.chrome.com/', periods: 6 });

    expect(fetch.calls[0]?.body).toMatchObject({ collectionPeriodCount: 6 });
    expect(res.structuredContent).toMatchObject({ status: 'ok', periods: 6 });
  });

  it.each([1, 40])('accepts periods %d', async (periods) => {
    const fetch = fakeFetch(() => ({ status: 404, body: fixture('crux/current-not-found.json') }));
    perfkit = await connectPerfkit({ fetch });

    const res = await callHistory({ url: 'https://developer.chrome.com/', periods });

    expect(fetch.calls[0]?.body).toMatchObject({ collectionPeriodCount: periods });
    expect(res.isError ?? false).toBe(false);
  });

  it.each([0, 41, -1, 2.5, 1000])('rejects periods %d as invalid_input without calling Google', async (periods) => {
    const fetch = fakeFetch(() => ({ status: 200, body: fixture('crux/history-url-phone.json') }));
    perfkit = await connectPerfkit({ fetch });

    const res = await callHistory({ url: 'https://developer.chrome.com/', periods });

    expect(fetch.calls).toHaveLength(0);
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({
      provider: 'crux',
      dataType: 'field_history',
      status: 'error',
      periods,
      error: { code: 'invalid_input', source: 'perfkit', retryable: false },
    });
    expect((res.structuredContent as { error: { message: string } }).error.message).toMatch(/1.*40/);
  });
});

describe('performance_crux_history: gaps', () => {
  it('keeps missing windows as null p75 and rating, in place, with their real dates', async () => {
    const fetch = fakeFetch(() => ({ status: 200, body: fixture('crux/history-url-phone-gaps.json') }));
    perfkit = await connectPerfkit({ fetch });

    const res = await callHistory({ url: 'https://developer.chrome.com/', periods: 6 });

    expect(res.isError ?? false).toBe(false);
    const out = res.structuredContent as { metrics: Record<string, unknown[]>; warnings: string[] };
    expect(out.metrics['LCP']).toEqual([
      { start: '2026-08-16', end: '2026-09-12', p75: 3076, rating: 'needs_improvement' },
      { start: '2026-08-23', end: '2026-09-19', p75: null, rating: null },
      { start: '2026-08-30', end: '2026-09-26', p75: 3061, rating: 'needs_improvement' },
      { start: '2026-09-06', end: '2026-10-03', p75: 3081, rating: 'needs_improvement' },
      { start: '2026-09-13', end: '2026-10-10', p75: null, rating: null },
      { start: '2026-09-20', end: '2026-10-17', p75: 3120, rating: 'needs_improvement' },
    ]);
    expect(out.metrics['CLS']?.map((p) => (p as { p75: unknown }).p75)).toEqual([0.02, null, 0.02, 0.02, null, 0.02]);
    for (const series of Object.values(out.metrics)) expect(series).toHaveLength(6);
    expect(out.warnings.some((w) => OVERLAP_WARNING.test(w))).toBe(true);
  });

  it('treats a "NaN" p75 as missing, never as zero', async () => {
    const body = fixture<{ record: { metrics: Record<string, { percentilesTimeseries: { p75s: unknown[] } }> } }>(
      'crux/history-url-phone-gaps.json',
    );
    const inp = body.record.metrics['interaction_to_next_paint'];
    if (inp) inp.percentilesTimeseries.p75s[0] = 'NaN';
    const fetch = fakeFetch(() => ({ status: 200, body }));
    perfkit = await connectPerfkit({ fetch });

    const res = await callHistory({ url: 'https://developer.chrome.com/', periods: 6 });

    const out = res.structuredContent as { metrics: Record<string, { p75: unknown; rating: unknown }[]> };
    expect(out.metrics['INP']?.[0]).toMatchObject({ p75: null, rating: null });
  });

  it('lists metrics Google returned no history for under omittedMetrics', async () => {
    const body = fixture<{ record: { metrics: Record<string, unknown> } }>('crux/history-url-phone-gaps.json');
    delete body.record.metrics['interaction_to_next_paint'];
    const fetch = fakeFetch(() => ({ status: 200, body }));
    perfkit = await connectPerfkit({ fetch });

    const res = await callHistory({ url: 'https://developer.chrome.com/', periods: 6 });

    const out = res.structuredContent as Record<string, unknown> & { metrics: Record<string, unknown> };
    expect(out['omittedMetrics']).toEqual(['INP']);
    expect(out.metrics).not.toHaveProperty('INP');
  });

  it('reports a timeseries that does not line up with the collection periods as upstream_error', async () => {
    const body = fixture<{ record: { metrics: Record<string, { percentilesTimeseries: { p75s: unknown[] } }> } }>(
      'crux/history-url-phone-gaps.json',
    );
    body.record.metrics['largest_contentful_paint']?.percentilesTimeseries.p75s.pop();
    const fetch = fakeFetch(() => ({ status: 200, body }));
    perfkit = await connectPerfkit({ fetch });

    const res = await callHistory({ url: 'https://developer.chrome.com/', periods: 6 });

    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({ status: 'error', error: { code: 'upstream_error', source: 'crux' } });
  });
});

describe('performance_crux_history: scope, device and no data (as performance_crux_current)', () => {
  it('reports a 404 as no_data (not an MCP error) with the overlap warning and an origin hint, never falling back', async () => {
    const fetch = fakeFetch(() => ({ status: 404, body: fixture('crux/current-not-found.json') }));
    perfkit = await connectPerfkit({ fetch });

    const res = await callHistory({ url: 'https://developer.chrome.com/low-traffic', device: 'TABLET' });

    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]?.body).toMatchObject({ url: 'https://developer.chrome.com/low-traffic' });
    expect(res.isError ?? false).toBe(false);
    const out = res.structuredContent as Record<string, unknown> & { warnings: string[] };
    expect(out).toMatchObject({
      dataType: 'field_history',
      scope: 'url',
      device: 'TABLET',
      status: 'no_data',
      requestedKey: { url: 'https://developer.chrome.com/low-traffic', formFactor: 'TABLET' },
      metrics: {},
      omittedMetrics: ['INP', 'LCP', 'CLS', 'FCP', 'TTFB'],
    });
    expect(out).not.toHaveProperty('error');
    expect(out).not.toHaveProperty('returnedKey');
    expect(out).not.toHaveProperty('collectionPeriods');
    expect(out.warnings.some((w) => OVERLAP_WARNING.test(w))).toBe(true);
    expect(out.warnings.some((w) => /scope "origin"/.test(w))).toBe(true);
  });

  it('queries the origin (scheme plus host) for scope origin', async () => {
    const body = fixture<{ record: { key: Record<string, string> } }>('crux/history-url-phone.json');
    body.record.key = { formFactor: 'PHONE', origin: 'https://developer.chrome.com' };
    const fetch = fakeFetch(() => ({ status: 200, body }));
    perfkit = await connectPerfkit({ fetch });

    const res = await callHistory({ url: 'https://developer.chrome.com/docs/crux?b=1#x', scope: 'origin' });

    expect(fetch.calls[0]?.body).toMatchObject({ origin: 'https://developer.chrome.com', formFactor: 'PHONE' });
    expect(fetch.calls[0]?.body).not.toHaveProperty('url');
    expect(res.structuredContent).toMatchObject({
      scope: 'origin',
      status: 'ok',
      requestedKey: { origin: 'https://developer.chrome.com', formFactor: 'PHONE' },
      returnedKey: { origin: 'https://developer.chrome.com', formFactor: 'PHONE' },
    });
    expect((res.structuredContent as { warnings: string[] }).warnings).toHaveLength(1);
  });

  it('warns when CrUX returns a different key than requested', async () => {
    const body = fixture<{ record: { key: Record<string, string> } }>('crux/history-url-phone.json');
    body.record.key = { formFactor: 'PHONE', url: 'https://developer.chrome.com/' };
    const fetch = fakeFetch(() => ({ status: 200, body }));
    perfkit = await connectPerfkit({ fetch });

    const res = await callHistory({ url: 'https://developer.chrome.com' + '/index.html' });

    const out = res.structuredContent as { warnings: string[]; returnedKey: unknown };
    expect(out.returnedKey).toEqual({ url: 'https://developer.chrome.com/', formFactor: 'PHONE' });
    expect(out.warnings.some((w) => /normalised/.test(w))).toBe(true);
  });

  it.each([
    ['DESKTOP', 'DESKTOP'],
    ['TABLET', 'TABLET'],
    ['ALL', undefined],
  ])('maps device %s to form factor %s', async (device, formFactor) => {
    const fetch = fakeFetch(() => ({ status: 404, body: fixture('crux/current-not-found.json') }));
    perfkit = await connectPerfkit({ fetch });

    const res = await callHistory({ url: 'https://developer.chrome.com/', device });

    const sent = fetch.calls[0]?.body as Record<string, unknown>;
    if (formFactor) expect(sent['formFactor']).toBe(formFactor);
    else expect(sent).not.toHaveProperty('formFactor');
    expect(res.structuredContent).toMatchObject({ device });
  });

  it('rejects a non-http(s) URL as invalid_input without calling Google', async () => {
    const fetch = fakeFetch(() => ({ status: 200, body: fixture('crux/history-url-phone.json') }));
    perfkit = await connectPerfkit({ fetch });

    const res = await callHistory({ url: 'ftp://developer.chrome.com/' });

    expect(fetch.calls).toHaveLength(0);
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({ dataType: 'field_history', error: { code: 'invalid_input' } });
  });
});

describe('performance_crux_history: cache', () => {
  const DAY = 24 * 60 * 60 * 1000;

  it('serves a repeat call from the cache for up to 7 days, keyed on periods', async () => {
    const fetch = fakeFetch(() => ({ status: 200, body: fixture('crux/history-url-phone.json') }));
    perfkit = await connectPerfkit({ fetch });

    await callHistory({ url: 'https://developer.chrome.com/' });
    perfkit.clock.advance(7 * DAY - 1000);
    const hit = await callHistory({ url: 'https://developer.chrome.com/' });
    expect(fetch.calls).toHaveLength(1);
    expect(hit.structuredContent).toMatchObject({ cached: true, cachedAt: '2026-10-23T12:00:00.000Z' });

    await callHistory({ url: 'https://developer.chrome.com/', periods: 39 });
    expect(fetch.calls).toHaveLength(2);

    perfkit.clock.advance(2000);
    const expired = await callHistory({ url: 'https://developer.chrome.com/' });
    expect(fetch.calls).toHaveLength(3);
    expect(expired.structuredContent).toMatchObject({ cached: false });
  });

  it('keeps no_data only for the 12 hour current field data lifetime', async () => {
    const fetch = fakeFetch(() => ({ status: 404, body: fixture('crux/current-not-found.json') }));
    perfkit = await connectPerfkit({ fetch });

    await callHistory({ url: 'https://developer.chrome.com/low-traffic' });
    perfkit.clock.advance(12 * 60 * 60 * 1000 - 1000);
    const hit = await callHistory({ url: 'https://developer.chrome.com/low-traffic' });
    expect(hit.structuredContent).toMatchObject({ status: 'no_data', cached: true });
    perfkit.clock.advance(2000);
    await callHistory({ url: 'https://developer.chrome.com/low-traffic' });

    expect(fetch.calls).toHaveLength(2);
  });

  it('does not share entries with performance_crux_current', async () => {
    const fetch = fakeFetch((req) =>
      req.url.pathname.endsWith(':queryHistoryRecord')
        ? { status: 200, body: fixture('crux/history-url-phone.json') }
        : { status: 200, body: fixture('crux/current-url-phone.json') },
    );
    perfkit = await connectPerfkit({ fetch });

    await perfkit.client.callTool({
      name: 'performance_crux_current',
      arguments: { url: 'https://developer.chrome.com/' },
    });
    const res = await callHistory({ url: 'https://developer.chrome.com/' });

    expect(fetch.calls).toHaveLength(2);
    expect(res.structuredContent).toMatchObject({ dataType: 'field_history', status: 'ok', cached: false });
  });
});

describe('performance_crux_history: upstream errors', () => {
  it('reports a persistent 5xx as a retryable upstream_error and never leaks the API key', async () => {
    const fetch = fakeFetch(() => ({
      status: 503,
      body: { error: { code: 503, message: 'The service is currently unavailable.', status: 'UNAVAILABLE' } },
    }));
    perfkit = await connectPerfkit({ fetch });

    const res = await callHistory({ url: 'https://developer.chrome.com/' });

    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({
      dataType: 'field_history',
      status: 'error',
      error: { code: 'upstream_error', source: 'crux', retryable: true },
    });
    expect(JSON.stringify(res)).not.toContain(TEST_API_KEY);
    expect(perfkit.stderr.text).not.toContain(TEST_API_KEY);
  });
});

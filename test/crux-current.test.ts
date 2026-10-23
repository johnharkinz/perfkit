import { afterEach, describe, expect, it } from 'vitest';
import { connectPerfkit, TEST_API_KEY, type Perfkit } from './support/harness.js';
import { fakeFetch, fixture } from './support/fake-google.js';

let perfkit: Perfkit | undefined;
afterEach(async () => {
  await perfkit?.close();
  perfkit = undefined;
});

describe('performance_crux_current', () => {
  it('is listed with input and output schemas and a description explaining field vs. lab data', async () => {
    perfkit = await connectPerfkit({
      fetch: fakeFetch(() => ({ status: 200, body: fixture('crux/current-url-phone.json') })),
    });

    const { tools } = await perfkit.client.listTools();
    const tool = tools.find((t) => t.name === 'performance_crux_current');

    expect(tool).toBeDefined();
    expect(tool?.inputSchema.properties).toHaveProperty('url');
    expect(tool?.inputSchema.properties).toHaveProperty('device');
    expect(tool?.inputSchema.properties).toHaveProperty('scope');
    expect(tool?.outputSchema?.properties).toHaveProperty('metrics');
    expect(tool?.outputSchema?.properties).toHaveProperty('returnedKey');
    expect(tool?.outputSchema?.properties).toHaveProperty('omittedMetrics');
    expect(tool?.description).toMatch(/field data/i);
    expect(tool?.description).toMatch(/lab/i);
    expect((tool?.description ?? '').length).toBeLessThan(600);
  });

  it('returns rated current field data for a URL on PHONE', async () => {
    const fetch = fakeFetch(() => ({ status: 200, body: fixture('crux/current-url-phone.json') }));
    perfkit = await connectPerfkit({ fetch });

    const res = await perfkit.client.callTool({
      name: 'performance_crux_current',
      arguments: { url: 'https://developer.chrome.com/', device: 'PHONE' },
    });

    expect(res.isError ?? false).toBe(false);
    expect(res.structuredContent).toEqual({
      schemaVersion: '1.0.0',
      requestedUrl: 'https://developer.chrome.com/',
      provider: 'crux',
      dataType: 'field_current',
      scope: 'url',
      device: 'PHONE',
      status: 'ok',
      collectedAt: '2026-10-23T12:00:00.000Z',
      cached: false,
      warnings: [],
      requestedKey: { url: 'https://developer.chrome.com/', formFactor: 'PHONE' },
      returnedKey: { url: 'https://developer.chrome.com/', formFactor: 'PHONE' },
      collectionPeriod: { start: '2026-09-24', end: '2026-10-21' },
      metrics: {
        INP: {
          p75: 147,
          unit: 'ms',
          rating: 'good',
          group: 'core_web_vital',
          histogram: [
            { start: 0, end: 200, density: 0.8846 },
            { start: 200, end: 500, density: 0.0897 },
            { start: 500, end: null, density: 0.0257 },
          ],
          provenance: { source: 'crux', cruxMetric: 'interaction_to_next_paint' },
        },
        LCP: {
          p75: 2093,
          unit: 'ms',
          rating: 'good',
          group: 'core_web_vital',
          histogram: [
            { start: 0, end: 2500, density: 0.8433 },
            { start: 2500, end: 4000, density: 0.0987 },
            { start: 4000, end: null, density: 0.058 },
          ],
          provenance: { source: 'crux', cruxMetric: 'largest_contentful_paint' },
        },
        CLS: {
          p75: 0.02,
          unit: 'unitless',
          rating: 'good',
          group: 'core_web_vital',
          histogram: [
            { start: 0, end: 0.1, density: 0.9312 },
            { start: 0.1, end: 0.25, density: 0.0421 },
            { start: 0.25, end: null, density: 0.0267 },
          ],
          provenance: { source: 'crux', cruxMetric: 'cumulative_layout_shift' },
        },
        FCP: {
          p75: 1734,
          unit: 'ms',
          rating: 'good',
          group: 'supporting',
          histogram: [
            { start: 0, end: 1800, density: 0.7815 },
            { start: 1800, end: 3000, density: 0.1468 },
            { start: 3000, end: null, density: 0.0717 },
          ],
          provenance: { source: 'crux', cruxMetric: 'first_contentful_paint' },
        },
        TTFB: {
          p75: 912,
          unit: 'ms',
          rating: 'needs_improvement',
          group: 'supporting',
          histogram: [
            { start: 0, end: 800, density: 0.7124 },
            { start: 800, end: 1800, density: 0.2213 },
            { start: 1800, end: null, density: 0.0663 },
          ],
          provenance: { source: 'crux', cruxMetric: 'experimental_time_to_first_byte' },
        },
      },
      omittedMetrics: [],
    });
  });

  it('returns the same JSON as a text block', async () => {
    perfkit = await connectPerfkit({
      fetch: fakeFetch(() => ({ status: 200, body: fixture('crux/current-url-phone.json') })),
    });

    const res = await perfkit.client.callTool({
      name: 'performance_crux_current',
      arguments: { url: 'https://developer.chrome.com/' },
    });

    const content = res.content as { type: string; text: string }[];
    expect(content).toHaveLength(1);
    expect(content[0]?.type).toBe('text');
    expect(JSON.parse(content[0]?.text ?? '')).toEqual(res.structuredContent);
  });

  it('sends one CrUX current request for the URL with the PHONE form factor and canonical metric names', async () => {
    const fetch = fakeFetch(() => ({ status: 200, body: fixture('crux/current-url-phone.json') }));
    perfkit = await connectPerfkit({ fetch });

    await perfkit.client.callTool({
      name: 'performance_crux_current',
      arguments: { url: 'https://developer.chrome.com/#intro', device: 'PHONE' },
    });

    expect(fetch.calls).toHaveLength(1);
    const call = fetch.calls[0];
    expect(call?.method).toBe('POST');
    expect(`${call?.url.origin}${call?.url.pathname}`).toBe(
      'https://chromeuxreport.googleapis.com/v1/records:queryRecord',
    );
    expect(call?.body).toEqual({
      url: 'https://developer.chrome.com/',
      formFactor: 'PHONE',
      metrics: [
        'interaction_to_next_paint',
        'largest_contentful_paint',
        'cumulative_layout_shift',
        'first_contentful_paint',
        'experimental_time_to_first_byte',
      ],
    });
  });

  it('accepts CrUX metric-name aliases, including a renamed TTFB metric', async () => {
    const body = fixture<{ record: { metrics: Record<string, unknown> } }>('crux/current-url-phone.json');
    const m = body.record.metrics;
    m['time_to_first_byte'] = m['experimental_time_to_first_byte'];
    delete m['experimental_time_to_first_byte'];
    m['experimental_interaction_to_next_paint'] = m['interaction_to_next_paint'];
    delete m['interaction_to_next_paint'];
    perfkit = await connectPerfkit({ fetch: fakeFetch(() => ({ status: 200, body })) });

    const res = await perfkit.client.callTool({
      name: 'performance_crux_current',
      arguments: { url: 'https://developer.chrome.com/' },
    });

    const metrics = (res.structuredContent as { metrics: Record<string, { p75: number; provenance: unknown }> })
      .metrics;
    expect(metrics['TTFB']?.p75).toBe(912);
    expect(metrics['TTFB']?.provenance).toEqual({ source: 'crux', cruxMetric: 'time_to_first_byte' });
    expect(metrics['INP']?.p75).toBe(147);
  });

  it('converts string p75 values to numbers before rating', async () => {
    const body = fixture<{ record: { metrics: Record<string, { percentiles: { p75: unknown } }> } }>(
      'crux/current-url-phone.json',
    );
    const cls = body.record.metrics['cumulative_layout_shift'];
    if (cls) cls.percentiles.p75 = '0.26';
    perfkit = await connectPerfkit({ fetch: fakeFetch(() => ({ status: 200, body })) });

    const res = await perfkit.client.callTool({
      name: 'performance_crux_current',
      arguments: { url: 'https://developer.chrome.com/' },
    });

    const metrics = (res.structuredContent as { metrics: Record<string, { p75: unknown; rating: string }> }).metrics;
    expect(metrics['CLS']).toMatchObject({ p75: 0.26, rating: 'poor' });
  });

  it('logs JSON to stderr with a correlation ID, and keeps the API key out of requests URLs, results and logs', async () => {
    const fetch = fakeFetch(() => ({ status: 200, body: fixture('crux/current-url-phone.json') }));
    perfkit = await connectPerfkit({ fetch });

    const res = await perfkit.client.callTool({
      name: 'performance_crux_current',
      arguments: { url: 'https://developer.chrome.com/' },
    });

    const logs = perfkit.stderr.jsonLines();
    expect(logs.length).toBeGreaterThan(0);
    const toolLogs = logs.filter((l) => l['tool'] === 'performance_crux_current');
    expect(toolLogs.length).toBeGreaterThan(0);
    const ids = new Set(toolLogs.map((l) => l['correlationId']));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toEqual(expect.any(String));
    expect(logs.some((l) => l['endpoint'] === 'cruxCurrent' && typeof l['latencyMs'] === 'number')).toBe(true);

    expect(fetch.calls[0]?.url.href).not.toContain(TEST_API_KEY);
    expect(JSON.stringify(res)).not.toContain(TEST_API_KEY);
    expect(perfkit.stderr.text).not.toContain(TEST_API_KEY);
  });

  it('reports an upstream failure as an MCP error with perfkit’s error envelope', async () => {
    perfkit = await connectPerfkit({
      fetch: fakeFetch(() => ({ status: 500, body: { error: { code: 500, message: 'boom', status: 'INTERNAL' } } })),
    });

    const res = await perfkit.client.callTool({
      name: 'performance_crux_current',
      arguments: { url: 'https://developer.chrome.com/' },
    });

    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({
      schemaVersion: '1.0.0',
      provider: 'crux',
      dataType: 'field_current',
      status: 'error',
      error: { code: 'upstream_error', source: 'crux', retryable: true },
    });
    expect(JSON.stringify(res)).not.toContain(TEST_API_KEY);
  });

  it('reports an unparseable URL as invalid_input without calling Google', async () => {
    const fetch = fakeFetch(() => ({ status: 200, body: fixture('crux/current-url-phone.json') }));
    perfkit = await connectPerfkit({ fetch });

    const res = await perfkit.client.callTool({
      name: 'performance_crux_current',
      arguments: { url: 'not a url' },
    });

    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({
      status: 'error',
      error: { code: 'invalid_input', source: 'perfkit' },
    });
    expect(fetch.calls).toHaveLength(0);
  });
});

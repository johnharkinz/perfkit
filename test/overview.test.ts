import { afterEach, describe, expect, it } from 'vitest';
import { connectPerfkit, TEST_API_KEY, type Perfkit } from './support/harness.js';
import { fakeFetch, fixture, type FakeReply, type RecordedRequest } from './support/fake-google.js';

let perfkit: Perfkit | undefined;
afterEach(async () => {
  await perfkit?.close();
  perfkit = undefined;
});

const URL = 'https://developer.chrome.com/';

type Endpoint = 'pagespeed' | 'currentUrl' | 'currentOrigin' | 'historyUrl' | 'historyOrigin';

function endpointOf(req: RecordedRequest): Endpoint {
  if (req.url.pathname.endsWith('/runPagespeed')) return 'pagespeed';
  const body = req.body as { url?: string; origin?: string };
  const history = req.url.pathname.endsWith(':queryHistoryRecord');
  if (body.origin !== undefined) return history ? 'historyOrigin' : 'currentOrigin';
  return history ? 'historyUrl' : 'currentUrl';
}

const OK_REPLIES: Record<Endpoint, () => FakeReply> = {
  pagespeed: () => ({ status: 200, body: fixture('psi/runpagespeed-mobile.json') }),
  currentUrl: () => ({ status: 200, body: fixture('crux/current-url-phone.json') }),
  currentOrigin: () => ({ status: 200, body: fixture('crux/current-origin-phone.json') }),
  historyUrl: () => ({ status: 200, body: fixture('crux/history-url-phone.json') }),
  historyOrigin: () => {
    const body = fixture<{ record: { key: Record<string, unknown> } }>('crux/history-url-phone.json');
    body.record.key = { origin: 'https://developer.chrome.com', formFactor: 'PHONE' };
    return { status: 200, body };
  },
};

const NOT_FOUND = (): FakeReply => ({ status: 404, body: fixture('crux/current-not-found.json') });
const SERVER_ERROR = (): FakeReply => ({ status: 500, body: { error: { code: 500, status: 'INTERNAL' } } });

/** A fake Google answering each endpoint from `overrides`, else with a saved success. */
function google(overrides: Partial<Record<Endpoint, (req: RecordedRequest) => FakeReply | Promise<FakeReply>>> = {}) {
  return fakeFetch((req) => {
    const endpoint = endpointOf(req);
    return (overrides[endpoint] ?? OK_REPLIES[endpoint])(req);
  });
}

const NO_RETRIES = { GOOGLE_API_KEY: TEST_API_KEY, PERFKIT_PSI_RETRIES: '0', PERFKIT_CRUX_RETRIES: '0' };

interface Section {
  status: string;
  dataType: string;
  provider: string;
  scope?: string;
  error?: { code: string; source: string; retryable: boolean; message: string };
}
interface Overview {
  schemaVersion: string;
  requestedUrl: string;
  device: string;
  status: string;
  collectedAt: string;
  warnings: string[];
  includeHistory: boolean;
  error?: { code: string };
  lab?: Section;
  field?: {
    url: { current: Section; history?: Section };
    origin: { current: Section; history?: Section };
  };
}

async function callOverview(args: Record<string, unknown>) {
  if (!perfkit) throw new Error('connect first');
  const res = await perfkit.client.callTool({ name: 'performance_overview', arguments: args });
  return { res, out: res.structuredContent as unknown as Overview };
}

const endpoints = (fetch: { calls: RecordedRequest[] }) => fetch.calls.map(endpointOf).sort();

describe('performance_overview: listing', () => {
  it('is listed with PHONE/DESKTOP devices and includeHistory, and says sections carry their own status', async () => {
    perfkit = await connectPerfkit({ fetch: google() });

    const { tools } = await perfkit.client.listTools();
    const tool = tools.find((t) => t.name === 'performance_overview');

    expect(tool).toBeDefined();
    const props = tool?.inputSchema.properties as Record<string, { enum?: string[]; default?: unknown }>;
    expect(props['device']?.enum).toEqual(['PHONE', 'DESKTOP']);
    expect(props['device']?.default).toBe('PHONE');
    expect(props['includeHistory']?.default).toBe(true);
    expect(tool?.outputSchema?.properties).toHaveProperty('lab');
    expect(tool?.outputSchema?.properties).toHaveProperty('field');
    expect(tool?.description).toMatch(/partial/);
  });

  it('gives every tool a concise description that explains lab vs. field data and URL vs. origin', async () => {
    perfkit = await connectPerfkit({ fetch: google() });

    const { tools } = await perfkit.client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual([
      'performance_crux_current',
      'performance_crux_history',
      'performance_overview',
      'performance_pagespeed',
    ]);
    for (const { name, description = '' } of tools) {
      expect(description, name).toMatch(/lab data/i);
      expect(description, name).toMatch(/field data/i);
      expect(description, name).toMatch(/\bURL\b/);
      expect(description, name).toMatch(/origin/i);
      expect(description.length, name).toBeLessThan(600);
    }
  });

  it('rejects TABLET without calling Google', async () => {
    const fetch = google();
    perfkit = await connectPerfkit({ fetch });

    const { res } = await callOverview({ url: URL, device: 'TABLET' });

    expect(res.isError).toBe(true);
    expect(fetch.calls).toHaveLength(0);
  });
});

describe('performance_overview: all sections', () => {
  it('fetches lab, URL and origin current field data and both histories, each a complete result, status ok', async () => {
    const fetch = google();
    perfkit = await connectPerfkit({ fetch });

    const { res, out } = await callOverview({ url: URL });

    expect(endpoints(fetch)).toEqual(['currentOrigin', 'currentUrl', 'historyOrigin', 'historyUrl', 'pagespeed']);
    const psi = fetch.calls.find((c) => endpointOf(c) === 'pagespeed');
    expect(psi?.url.searchParams.get('strategy')).toBe('MOBILE');
    expect(psi?.url.searchParams.getAll('category')).toEqual(['PERFORMANCE']);
    for (const c of fetch.calls.filter((c) => endpointOf(c).startsWith('history'))) {
      expect(c.body).toMatchObject({ formFactor: 'PHONE', collectionPeriodCount: 40 });
    }
    expect(res.isError ?? false).toBe(false);
    expect(out).toMatchObject({
      schemaVersion: '1.0.0',
      requestedUrl: URL,
      device: 'PHONE',
      status: 'ok',
      includeHistory: true,
      collectedAt: '2026-10-23T12:00:00.000Z',
      lab: { provider: 'pagespeed', dataType: 'lab', status: 'ok', strategy: 'mobile', device: 'PHONE' },
      field: {
        url: {
          current: { dataType: 'field_current', scope: 'url', status: 'ok', requestedKey: { url: URL } },
          history: { dataType: 'field_history', scope: 'url', status: 'ok', periods: 40 },
        },
        origin: {
          current: {
            dataType: 'field_current',
            scope: 'origin',
            status: 'ok',
            requestedKey: { origin: 'https://developer.chrome.com' },
          },
          history: { dataType: 'field_history', scope: 'origin', status: 'ok', periods: 40 },
        },
      },
    });
    expect(out.lab).toHaveProperty('performanceScore');
    expect(out.field?.url.current).toHaveProperty('metrics.LCP.p75');
    expect(out.field?.origin.history).toHaveProperty('metrics.INP');
  });

  it('maps DESKTOP to the PSI desktop strategy and the DESKTOP form factor', async () => {
    const fetch = google();
    perfkit = await connectPerfkit({ fetch });

    const { out } = await callOverview({ url: URL, device: 'DESKTOP' });

    expect(fetch.calls.find((c) => endpointOf(c) === 'pagespeed')?.url.searchParams.get('strategy')).toBe('DESKTOP');
    for (const c of fetch.calls.filter((c) => endpointOf(c) !== 'pagespeed')) {
      expect(c.body).toMatchObject({ formFactor: 'DESKTOP' });
    }
    expect(out).toMatchObject({ device: 'DESKTOP', lab: { strategy: 'desktop' } });
  });

  it('makes no history calls and has no history sections with includeHistory false', async () => {
    const fetch = google();
    perfkit = await connectPerfkit({ fetch });

    const { out } = await callOverview({ url: URL, includeHistory: false });

    expect(endpoints(fetch)).toEqual(['currentOrigin', 'currentUrl', 'pagespeed']);
    expect(out.status).toBe('ok');
    expect(out.includeHistory).toBe(false);
    expect(out.field?.url).not.toHaveProperty('history');
    expect(out.field?.origin).not.toHaveProperty('history');
  });
});

describe('performance_overview: no data', () => {
  it('reports URL no_data beside origin ok without falling back, and the overall status stays ok', async () => {
    const fetch = google({ currentUrl: NOT_FOUND, historyUrl: NOT_FOUND });
    perfkit = await connectPerfkit({ fetch });

    const { res, out } = await callOverview({ url: URL });

    expect(endpoints(fetch)).toEqual(['currentOrigin', 'currentUrl', 'historyOrigin', 'historyUrl', 'pagespeed']);
    expect(res.isError ?? false).toBe(false);
    expect(out).toMatchObject({
      status: 'ok',
      field: {
        url: { current: { status: 'no_data', scope: 'url' }, history: { status: 'no_data', scope: 'url' } },
        origin: { current: { status: 'ok', scope: 'origin' }, history: { status: 'ok', scope: 'origin' } },
      },
    });
    expect(out.field?.url.current).not.toHaveProperty('error');
  });
});

describe('performance_overview: partial failures', () => {
  it('is partial when PSI returns 5xx, keeping every CrUX section', async () => {
    perfkit = await connectPerfkit({ fetch: google({ pagespeed: SERVER_ERROR }), env: NO_RETRIES });

    const { res, out } = await callOverview({ url: URL });

    expect(res.isError ?? false).toBe(false);
    expect(out).toMatchObject({
      status: 'partial',
      lab: { status: 'error', error: { code: 'upstream_error', source: 'pagespeed', retryable: true } },
      field: {
        url: { current: { status: 'ok' }, history: { status: 'ok' } },
        origin: { current: { status: 'ok' }, history: { status: 'ok' } },
      },
    });
  });

  it('is partial when CrUX returns 5xx, keeping the lab section', async () => {
    const fail = { currentUrl: SERVER_ERROR, currentOrigin: SERVER_ERROR, historyUrl: SERVER_ERROR };
    perfkit = await connectPerfkit({ fetch: google({ ...fail, historyOrigin: SERVER_ERROR }), env: NO_RETRIES });

    const { out } = await callOverview({ url: URL });

    expect(out).toMatchObject({
      status: 'partial',
      lab: { status: 'ok' },
      field: {
        url: { current: { status: 'error', error: { code: 'upstream_error', source: 'crux' } } },
        origin: { history: { status: 'error', error: { code: 'upstream_error', source: 'crux' } } },
      },
    });
  });

  it('is error, with isError, when every section failed', async () => {
    perfkit = await connectPerfkit({ fetch: fakeFetch(SERVER_ERROR), env: NO_RETRIES });

    const { res, out } = await callOverview({ url: URL });

    expect(res.isError).toBe(true);
    expect(out.status).toBe('error');
    expect(out.lab?.status).toBe('error');
    expect(out.field?.origin.history?.status).toBe('error');
  });
});

describe('performance_overview: time budget', () => {
  it('returns the CrUX sections and a PSI upstream_timeout when PSI runs past the budget', async () => {
    const fetch = google({ pagespeed: () => new Promise<FakeReply>(() => {}) });
    perfkit = await connectPerfkit({
      fetch,
      env: { GOOGLE_API_KEY: TEST_API_KEY, PERFKIT_OVERVIEW_BUDGET_MS: '100' },
    });

    const { res, out } = await callOverview({ url: URL });

    expect(res.isError ?? false).toBe(false);
    expect(out).toMatchObject({
      status: 'partial',
      lab: { status: 'error', error: { code: 'upstream_timeout', source: 'pagespeed', retryable: true } },
      field: {
        url: { current: { status: 'ok' }, history: { status: 'ok' } },
        origin: { current: { status: 'ok' }, history: { status: 'ok' } },
      },
    });
    expect(out.lab?.error?.message).toMatch(/0\.1 s time budget.*performance_pagespeed/);
    expect(endpoints(fetch).filter((e) => e === 'pagespeed')).toHaveLength(1);
  });

  it('rejects an invalid PERFKIT_OVERVIEW_BUDGET_MS at startup, naming the variable', async () => {
    await expect(
      connectPerfkit({ fetch: google(), env: { GOOGLE_API_KEY: TEST_API_KEY, PERFKIT_OVERVIEW_BUDGET_MS: 'soon' } }),
    ).rejects.toThrow(/PERFKIT_OVERVIEW_BUDGET_MS/);
  });
});

describe('performance_overview: shared cache', () => {
  it('reuses results cached by the narrow tools', async () => {
    const fetch = google();
    perfkit = await connectPerfkit({ fetch });
    await perfkit.client.callTool({ name: 'performance_crux_current', arguments: { url: URL, scope: 'origin' } });
    await perfkit.client.callTool({ name: 'performance_pagespeed', arguments: { url: URL } });
    fetch.calls.length = 0;

    const { out } = await callOverview({ url: URL });

    expect(endpoints(fetch)).toEqual(['currentUrl', 'historyOrigin', 'historyUrl']);
    expect(out).toMatchObject({
      status: 'ok',
      lab: { cached: true },
      field: { origin: { current: { cached: true } } },
    });
  });

  it('is reused by the narrow tools afterwards', async () => {
    const fetch = google();
    perfkit = await connectPerfkit({ fetch });
    await callOverview({ url: URL });
    fetch.calls.length = 0;

    const res = await perfkit.client.callTool({ name: 'performance_crux_history', arguments: { url: URL } });

    expect(fetch.calls).toHaveLength(0);
    expect(res.structuredContent).toMatchObject({ cached: true });
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { connectPerfkit, TEST_API_KEY, type Perfkit } from './support/harness.js';
import { fakeFetch, fixture } from './support/fake-google.js';

let perfkit: Perfkit | undefined;
afterEach(async () => {
  await perfkit?.close();
  perfkit = undefined;
});

const psiOk = () => fakeFetch(() => ({ status: 200, body: fixture('psi/runpagespeed-mobile.json') }));

describe('performance_pagespeed', () => {
  it('is listed with input and output schemas and a description saying it is a single simulated run, not field data', async () => {
    perfkit = await connectPerfkit({ fetch: psiOk() });

    const { tools } = await perfkit.client.listTools();
    const tool = tools.find((t) => t.name === 'performance_pagespeed');

    expect(tool).toBeDefined();
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(['url', 'device', 'categories']);
    expect(tool?.outputSchema?.properties).toHaveProperty('performanceScore');
    expect(tool?.outputSchema?.properties).toHaveProperty('labMetrics');
    expect(tool?.outputSchema?.properties).toHaveProperty('audits');
    expect(tool?.description).toMatch(/single simulated/i);
    expect(tool?.description).toMatch(/not field data/i);
    expect((tool?.description ?? '').length).toBeLessThan(600);
  });

  it('sends one PSI request with the mobile strategy and the performance category, sending the key only in a header', async () => {
    const fetch = psiOk();
    perfkit = await connectPerfkit({ fetch });

    await perfkit.client.callTool({
      name: 'performance_pagespeed',
      arguments: { url: 'https://developer.chrome.com/#top' },
    });

    expect(fetch.calls).toHaveLength(1);
    const call = fetch.calls[0];
    expect(call?.method).toBe('GET');
    expect(`${call?.url.origin}${call?.url.pathname}`).toBe(
      'https://www.googleapis.com/pagespeedonline/v5/runPagespeed',
    );
    expect(call?.url.searchParams.get('url')).toBe('https://developer.chrome.com/');
    expect(call?.url.searchParams.get('strategy')).toBe('MOBILE');
    expect(call?.url.searchParams.getAll('category')).toEqual(['PERFORMANCE']);
    expect(call?.url.href).not.toContain(TEST_API_KEY);
    expect(call?.headers.get('x-goog-api-key')).toBe(TEST_API_KEY);
  });

  it('maps DESKTOP to the desktop strategy and states it in the result', async () => {
    const fetch = psiOk();
    perfkit = await connectPerfkit({ fetch });

    const res = await perfkit.client.callTool({
      name: 'performance_pagespeed',
      arguments: { url: 'https://developer.chrome.com/', device: 'DESKTOP' },
    });

    expect(fetch.calls[0]?.url.searchParams.get('strategy')).toBe('DESKTOP');
    expect(res.structuredContent).toMatchObject({ device: 'DESKTOP', strategy: 'desktop' });
  });

  it('returns the 0–100 performance score and unrated lab metrics with Lighthouse’s per-metric scores', async () => {
    perfkit = await connectPerfkit({ fetch: psiOk() });

    const res = await perfkit.client.callTool({
      name: 'performance_pagespeed',
      arguments: { url: 'https://developer.chrome.com/', device: 'PHONE' },
    });

    expect(res.isError ?? false).toBe(false);
    const out = res.structuredContent as Record<string, unknown>;
    expect(out).toMatchObject({
      schemaVersion: '1.0.0',
      requestedUrl: 'https://developer.chrome.com/',
      provider: 'pagespeed',
      dataType: 'lab',
      device: 'PHONE',
      strategy: 'mobile',
      status: 'ok',
      collectedAt: '2026-10-23T12:00:00.000Z',
      cached: false,
      performanceScore: 62,
    });
    // Lighthouse puts a no-break space between number and unit in displayValue; it is passed through as sent.
    expect(out['labMetrics']).toEqual({
      FCP: {
        value: 3755.7245496953874,
        unit: 'ms',
        score: 0.28,
        displayValue: '3.8\u00a0s',
        auditId: 'first-contentful-paint',
      },
      LCP: {
        value: 3755.7245496953874,
        unit: 'ms',
        score: 0.56,
        displayValue: '3.8\u00a0s',
        auditId: 'largest-contentful-paint',
      },
      CLS: {
        value: 0.0035126120733915906,
        unit: 'unitless',
        score: 1,
        displayValue: '0.004',
        auditId: 'cumulative-layout-shift',
      },
      TBT: { value: 588, unit: 'ms', score: 0.5, displayValue: '590\u00a0ms', auditId: 'total-blocking-time' },
      SI: { value: 5496.02146283892, unit: 'ms', score: 0.55, displayValue: '5.5\u00a0s', auditId: 'speed-index' },
    });
    expect(JSON.stringify(out)).not.toMatch(/"rating"/);
    expect(out).not.toHaveProperty('categoryScores');
  });

  describe('audits', () => {
    type Audit = {
      id: string;
      title: string;
      description: string;
      displayValue: string | null;
      score: number | null;
      savings?: Record<string, unknown>;
      elements?: unknown[];
    };
    const auditsOf = (res: { structuredContent?: unknown }) => (res.structuredContent as { audits: Audit[] }).audits;
    const call = (body: unknown) => async () => {
      perfkit = await connectPerfkit({ fetch: fakeFetch(() => ({ status: 200, body })) });
      return perfkit.client.callTool({
        name: 'performance_pagespeed',
        arguments: { url: 'https://developer.chrome.com/' },
      });
    };
    type Lhr = {
      lighthouseResult: {
        audits: Record<string, Record<string, unknown>>;
        categories: { performance: { auditRefs: { id: string; weight: number; group?: string }[] } };
      };
    };
    const psi = () => fixture<Lhr>('psi/runpagespeed-mobile.json');

    it('lists failing performance audits (score < 0.9, no metric audits) by time savings, capped, then the pinned LCP and layout-shift audits', async () => {
      const res = await call(psi())();

      expect(auditsOf(res).map((a) => a.id)).toEqual([
        'render-blocking-insight', // LCP/FCP 2250 ms (metric savings only)
        'bootup-time', // TBT 700 ms
        'mainthread-work-breakdown', // TBT 600 ms
        'unused-css-rules', // 450 ms
        'unused-javascript', // 0 ms, 337 KB
        'font-display-insight', // 0 ms
        'image-delivery-insight', // 0 ms
        'network-dependency-tree-insight', // 0 ms
        // forced-reflow-insight (no estimate) and unsized-images (CLS only) lose their slots to the pinned audits
        'lcp-breakdown-insight', // passing, but always included
        'cls-culprits-insight', // passing, but always included
      ]);
    });

    it('reports savings only as Google supplied them', async () => {
      const audits = auditsOf(await call(psi())());
      const byId = Object.fromEntries(audits.map((a) => [a.id, a]));

      // Lighthouse 13 insights carry their estimate in metricSavings only (the "Est savings" text is not parsed).
      expect(byId['render-blocking-insight']?.savings).toEqual({ metrics: { LCP: 2250, FCP: 2250 } });
      expect(byId['unused-css-rules']?.savings).toEqual({ ms: 450, bytes: 133945, metrics: { LCP: 450, FCP: 450 } });
      expect(byId['unused-javascript']?.savings).toEqual({ ms: 0, bytes: 337465, metrics: { LCP: 0, FCP: 0 } });
      // A diagnostic's numericValue is a measurement (3.1 s of main-thread work), not a saving.
      expect(byId['mainthread-work-breakdown']?.savings).toEqual({ metrics: { TBT: 600 } });
      expect(byId['network-dependency-tree-insight']?.savings).toEqual({ metrics: { LCP: 0 } });
    });

    it('gives each audit its id, title, displayValue, score and a truncated description', async () => {
      const audits = auditsOf(await call(psi())());

      expect(audits.find((a) => a.id === 'bootup-time')).toEqual({
        id: 'bootup-time',
        title: 'Reduce JavaScript execution time',
        description: expect.any(String),
        displayValue: '1.4\u00a0s',
        score: 0,
        savings: { metrics: { TBT: 700 } },
      });
      expect(audits.find((a) => a.id === 'lcp-breakdown-insight')?.displayValue).toBeNull();
      for (const a of audits) expect(a.description.length).toBeLessThanOrEqual(200);
      const long = audits.find((a) => a.id === 'render-blocking-insight')?.description ?? '';
      expect(long).toMatch(/^Requests are blocking the page's initial render/);
      expect(long.endsWith('…')).toBe(true);
    });

    it('names the LCP element and the layout-shift culprits', async () => {
      const audits = auditsOf(await call(psi())());

      expect(audits.find((a) => a.id === 'lcp-breakdown-insight')?.elements).toEqual([
        {
          selector:
            'div.devsite-landing-row-inner > header.devsite-landing-row-header > div.devsite-landing-row-header-text > h2#a-powerful-web-span-classline2made-easierspan',
          nodeLabel: 'A Powerful Web.\nMade Easier.',
          snippet: expect.stringMatching(/^<h2 id="a-powerful-web-span-classline2made-easierspan"/),
        },
      ]);
      // The insight's "Total" row (a text value, not a page element) is skipped.
      const culprits = audits.find((a) => a.id === 'cls-culprits-insight')?.elements;
      expect(culprits).toHaveLength(3);
      expect(culprits?.[0]).toEqual({
        selector:
          'header.devsite-landing-row-header > div.devsite-landing-row-header-text > h2#a-powerful-web-span-classline2made-easierspan > span.line2',
        nodeLabel: 'Made Easier.',
        snippet: '<span class="line2">',
        score: 0.003014180821005272,
      });
      expect(culprits?.[1]).toMatchObject({
        snippet: '<div class="devsite-top-logo-row-middle">',
        score: 0.0003963025124659057,
      });
    });

    it('caps the list at 10 while keeping the LCP and layout-shift audits', async () => {
      const body = psi();
      const lhr = body.lighthouseResult;
      for (let i = 0; i < 15; i++) {
        const id = `extra-${i}`;
        lhr.audits[id] = {
          id,
          title: `Extra ${i}`,
          description: '',
          score: 0.5,
          scoreDisplayMode: 'metricSavings',
          metricSavings: { LCP: 3000 + i },
        };
        lhr.categories.performance.auditRefs.push({ id, weight: 0, group: 'diagnostics' });
      }

      const ids = auditsOf(await call(body)()).map((a) => a.id);

      expect(ids).toHaveLength(10);
      expect(ids.slice(0, 8)).toEqual([14, 13, 12, 11, 10, 9, 8, 7].map((i) => `extra-${i}`));
      expect(ids).toContain('lcp-breakdown-insight');
      expect(ids).toContain('cls-culprits-insight');
    });

    it('breaks ties on byte savings, then audit weight', async () => {
      const body = psi();
      const lhr = body.lighthouseResult;
      const add = (id: string, weight: number, bytes?: number) => {
        lhr.audits[id] = {
          id,
          title: id,
          description: '',
          score: 0,
          scoreDisplayMode: 'metricSavings',
          ...(bytes === undefined
            ? {}
            : { details: { type: 'opportunity', overallSavingsMs: 5000, overallSavingsBytes: bytes } }),
          ...(bytes === undefined ? { numericValue: 5000, numericUnit: 'millisecond' } : {}),
        };
        lhr.categories.performance.auditRefs.push({ id, weight, group: 'insights' });
      };
      add('light-insight', 0);
      add('heavy-insight', 3);
      add('bytes-small', 0, 10);
      add('bytes-big', 0, 5000);

      const ids = auditsOf(await call(body)()).map((a) => a.id);

      expect(ids.slice(0, 4)).toEqual(['bytes-big', 'bytes-small', 'heavy-insight', 'light-insight']);
    });

    it('falls back to the legacy layout-shift audit when the culprits insight is absent', async () => {
      const body = psi();
      delete body.lighthouseResult.audits['cls-culprits-insight'];
      body.lighthouseResult.categories.performance.auditRefs =
        body.lighthouseResult.categories.performance.auditRefs.filter((r) => r.id !== 'cls-culprits-insight');

      const audits = auditsOf(await call(body)());

      expect(audits.at(-1)).toMatchObject({
        id: 'layout-shifts',
        displayValue: '3 layout shifts found',
        savings: { metrics: { CLS: 0.004 } },
        elements: [
          { nodeLabel: 'Made Easier.', snippet: '<span class="line2">', score: 0.003014180821005272 },
          { snippet: '<div class="devsite-top-logo-row-middle">', score: 0.0003963025124659057 },
          { snippet: '<div class="devsite-top-logo-row-middle">', score: 0.000102128739920413 },
        ],
      });
    });

    it('reads a run whose audits carry details shapes perfkit does not use (a checklist’s keyed items)', async () => {
      const body = psi();
      const lhr = body.lighthouseResult;
      lhr.audits['checklist-insight'] = {
        id: 'checklist-insight',
        title: 'Checklist',
        description: '',
        score: 0,
        scoreDisplayMode: 'metricSavings',
        metricSavings: { LCP: 5 },
        details: { type: 'checklist', items: { noRedirects: { label: 'Avoids redirects', value: false } } },
      };
      lhr.categories.performance.auditRefs.push({ id: 'checklist-insight', weight: 0, group: 'insights' });

      const res = await call(body)();

      expect(res.structuredContent).toMatchObject({ status: 'ok' });
      expect(auditsOf(res).find((a) => a.id === 'checklist-insight')).toMatchObject({
        score: 0,
        savings: { metrics: { LCP: 5 } },
      });
    });

    it('drops an audit it cannot read instead of failing the whole run', async () => {
      const body = psi();
      const lhr = body.lighthouseResult;
      lhr.audits['odd-audit'] = { id: 'odd-audit', title: 42, score: 'low', details: 'not an object' };
      lhr.categories.performance.auditRefs.push({ id: 'odd-audit', weight: 0, group: 'diagnostics' });

      const res = await call(body)();

      expect(res.structuredContent).toMatchObject({ status: 'ok' });
      expect(Object.keys((res.structuredContent as { labMetrics: object }).labMetrics)).toHaveLength(5);
      expect(JSON.stringify(res)).not.toContain('odd-audit');
    });

    it('treats not-applicable, manual, errored and unscored audits as not failing', async () => {
      const body = psi();
      const lhr = body.lighthouseResult;
      const modes = ['notApplicable', 'manual', 'error', 'informative'];
      modes.forEach((mode, i) => {
        const id = `mode-${i}`;
        lhr.audits[id] = {
          id,
          title: id,
          description: '',
          score: mode === 'informative' ? null : 0,
          scoreDisplayMode: mode,
        };
        lhr.categories.performance.auditRefs.push({ id, weight: 0, group: 'diagnostics' });
      });

      const ids = auditsOf(await call(body)()).map((a) => a.id);

      expect(ids.filter((id) => id.startsWith('mode-'))).toEqual([]);
    });
  });

  it('requests extra categories and returns only their 0–100 scores', async () => {
    type Lhr = {
      lighthouseResult: { categories: Record<string, unknown>; audits: Record<string, unknown> };
    };
    const body = fixture<Lhr>('psi/runpagespeed-mobile.json');
    const lhr = body.lighthouseResult;
    lhr.categories['seo'] = { id: 'seo', title: 'SEO', score: 0.917, auditRefs: [{ id: 'document-title', weight: 1 }] };
    lhr.categories['accessibility'] = { id: 'accessibility', title: 'Accessibility', score: null, auditRefs: [] };
    lhr.audits['document-title'] = { id: 'document-title', title: 'Document has no title', description: '', score: 0 };
    const fetch = fakeFetch(() => ({ status: 200, body }));
    perfkit = await connectPerfkit({ fetch });

    const res = await perfkit.client.callTool({
      name: 'performance_pagespeed',
      arguments: { url: 'https://developer.chrome.com/', categories: ['seo', 'accessibility'] },
    });

    expect(fetch.calls[0]?.url.searchParams.getAll('category')).toEqual(['PERFORMANCE', 'SEO', 'ACCESSIBILITY']);
    const out = res.structuredContent as Record<string, unknown>;
    expect(out['categoryScores']).toEqual({ seo: 92, accessibility: null });
    expect(out['performanceScore']).toBe(62);
    expect(JSON.stringify(out)).not.toContain('document-title');
  });

  it('includes finalUrl, the Lighthouse version and run metadata, and ignores PSI’s embedded field data', async () => {
    perfkit = await connectPerfkit({ fetch: psiOk() });

    const res = await perfkit.client.callTool({
      name: 'performance_pagespeed',
      arguments: { url: 'https://developer.chrome.com/' },
    });

    const out = res.structuredContent as Record<string, unknown>;
    expect(out).toMatchObject({
      finalUrl: 'https://developer.chrome.com/',
      lighthouseVersion: '13.5.0',
      warnings: [],
      run: {
        fetchTime: '2026-10-23T15:36:41.490Z',
        analysisUTCTimestamp: '2026-10-23T15:36:41.490Z',
        formFactor: 'mobile',
        locale: 'en-US',
        benchmarkIndex: 365,
        totalTimeMs: 25719,
        runWarnings: [],
        networkUserAgent: expect.stringContaining('Android'),
      },
    });
    const text = JSON.stringify(res);
    expect(text).not.toMatch(/loadingExperience|LARGEST_CONTENTFUL_PAINT_MS|overall_category|FAST/);
  });

  it('warns when PSI tested a different URL than requested', async () => {
    type Lhr = { lighthouseResult: Record<string, unknown> };
    const body = fixture<Lhr>('psi/runpagespeed-mobile.json');
    const warning =
      'The page may not be loading as expected because your test URL (https://chrome.dev/) was redirected to ' +
      'https://developer.chrome.com/. Try testing the second URL directly.';
    Object.assign(body.lighthouseResult, { requestedUrl: 'https://chrome.dev/', runWarnings: [warning] });
    perfkit = await connectPerfkit({ fetch: fakeFetch(() => ({ status: 200, body })) });

    const res = await perfkit.client.callTool({
      name: 'performance_pagespeed',
      arguments: { url: 'https://chrome.dev/' },
    });

    const out = res.structuredContent as { finalUrl: string; warnings: string[]; run: { runWarnings: string[] } };
    expect(out.finalUrl).toBe('https://developer.chrome.com/');
    expect(out.warnings).toEqual([
      'PageSpeed Insights tested https://developer.chrome.com/, not the requested https://chrome.dev/ (redirect); this lab data describes the final URL.',
    ]);
    expect(out.run.runWarnings).toEqual([warning]);
  });

  describe('errors', () => {
    const lighthouseFailure = (status: number, lhMessage: string) => ({
      status,
      body: {
        error: {
          code: status,
          message: lhMessage,
          errors: [{ message: lhMessage, domain: 'lighthouse', reason: 'lighthouseUserError' }],
          ...(status >= 500 ? { status: 'INTERNAL' } : {}),
        },
      },
    });
    const FAILED_DOCUMENT =
      'Lighthouse returned error: FAILED_DOCUMENT_REQUEST. Lighthouse was unable to reliably load the page you ' +
      'requested. Make sure you are testing the correct URL and that the server is properly responding to all ' +
      'requests. (Details: net::ERR_TIMED_OUT)';

    const callWith = async (reply: { status: number; body: unknown }, url = 'https://staging.example.com/') => {
      const fetch = fakeFetch(() => reply);
      perfkit = await connectPerfkit({ fetch });
      const res = await perfkit.client.callTool({ name: 'performance_pagespeed', arguments: { url } });
      return { res, fetch, out: res.structuredContent as Record<string, unknown> };
    };

    it('reports an unreachable URL as upstream_error with the error PSI gave, and no metrics', async () => {
      const { res, out } = await callWith(lighthouseFailure(400, FAILED_DOCUMENT));

      expect(res.isError).toBe(true);
      expect(out).toMatchObject({
        schemaVersion: '1.0.0',
        requestedUrl: 'https://staging.example.com/',
        provider: 'pagespeed',
        dataType: 'lab',
        device: 'PHONE',
        strategy: 'mobile',
        status: 'error',
        error: { code: 'upstream_error', source: 'pagespeed', retryable: false },
      });
      const message = (out['error'] as { message: string }).message;
      expect(message).toContain('FAILED_DOCUMENT_REQUEST');
      expect(message).toContain('net::ERR_TIMED_OUT');
      for (const key of ['performanceScore', 'labMetrics', 'audits', 'finalUrl']) expect(out).not.toHaveProperty(key);
    });

    it('classifies a Lighthouse error sent as HTTP 500 by its body, not its status', async () => {
      const { out } = await callWith(
        lighthouseFailure(
          500,
          'Lighthouse returned error: ERRORED_DOCUMENT_REQUEST. Lighthouse was unable to reliably load the page you requested. (Status code: 401)',
        ),
      );

      expect(out['error']).toMatchObject({ code: 'upstream_error', source: 'pagespeed', retryable: false });
      expect((out['error'] as { message: string }).message).toContain('(Status code: 401)');
    });

    it('strips URLs from PSI’s error text', async () => {
      const { out } = await callWith(
        lighthouseFailure(
          400,
          'Lighthouse returned error: FAILED_DOCUMENT_REQUEST. Could not load https://staging.example.com/?token=s3cret (Details: net::ERR_CONNECTION_REFUSED)',
        ),
      );

      expect(JSON.stringify(out)).not.toContain('s3cret');
      expect((out['error'] as { message: string }).message).toContain('net::ERR_CONNECTION_REFUSED');
    });

    it('treats a Lighthouse runtimeError in a 200 response as upstream_error', async () => {
      type Lhr = { lighthouseResult: Record<string, unknown> };
      const body = fixture<Lhr>('psi/runpagespeed-mobile.json');
      body.lighthouseResult['runtimeError'] = {
        code: 'NO_FCP',
        message:
          'The page did not paint any content. Please ensure you keep the browser window in the foreground during the load and try again. (NO_FCP)',
      };

      const { res, out } = await callWith({ status: 200, body });

      expect(res.isError).toBe(true);
      expect(out['error']).toMatchObject({ code: 'upstream_error', source: 'pagespeed', retryable: true });
      expect((out['error'] as { message: string }).message).toContain('NO_FCP');
      expect(out).not.toHaveProperty('labMetrics');
    });

    it('maps a PSI 429 to upstream_rate_limit', async () => {
      const { out } = await callWith({
        status: 429,
        body: {
          error: {
            code: 429,
            message: "Quota exceeded for quota metric 'Queries' and limit 'Queries per day'.",
            errors: [{ domain: 'global', reason: 'rateLimitExceeded' }],
            status: 'RESOURCE_EXHAUSTED',
          },
        },
      });

      expect(out['error']).toMatchObject({ code: 'upstream_rate_limit', source: 'pagespeed' });
    });

    it('reports an unreadable 200 response as upstream_error', async () => {
      const { out } = await callWith({ status: 200, body: { kind: 'pagespeedonline#result' } });

      expect(out['error']).toMatchObject({ code: 'upstream_error', source: 'pagespeed', retryable: false });
    });

    it('rejects an invalid URL as invalid_input without calling Google', async () => {
      const { res, fetch, out } = await callWith(
        { status: 200, body: fixture('psi/runpagespeed-mobile.json') },
        'ftp://x/',
      );

      expect(res.isError).toBe(true);
      expect(out).toMatchObject({ status: 'error', error: { code: 'invalid_input', source: 'perfkit' } });
      expect(fetch.calls).toHaveLength(0);
    });

    it('never puts the API key in results or logs', async () => {
      const { res } = await callWith(lighthouseFailure(400, FAILED_DOCUMENT));

      expect(JSON.stringify(res)).not.toContain(TEST_API_KEY);
      expect(perfkit?.stderr.text).not.toContain(TEST_API_KEY);
    });
  });

  it('returns the same JSON as a text block', async () => {
    perfkit = await connectPerfkit({ fetch: psiOk() });

    const res = await perfkit.client.callTool({
      name: 'performance_pagespeed',
      arguments: { url: 'https://developer.chrome.com/' },
    });

    const content = res.content as { type: string; text: string }[];
    expect(content).toHaveLength(1);
    expect(JSON.parse(content[0]?.text ?? '')).toEqual(res.structuredContent);
  });

  it('redacts sensitive parameters in the finalUrl PSI reports and in its run warnings', async () => {
    type Lhr = { lighthouseResult: Record<string, unknown> };
    const body = fixture<Lhr>('psi/runpagespeed-mobile.json');
    const final = 'https://developer.chrome.com/?session=ses-456';
    Object.assign(body.lighthouseResult, {
      finalDisplayedUrl: final,
      mainDocumentUrl: final,
      runWarnings: [`Your test URL (https://chrome.dev/?token=tok-123) was redirected to ${final}. Try it directly.`],
    });
    perfkit = await connectPerfkit({ fetch: fakeFetch(() => ({ status: 200, body })) });

    const res = await perfkit.client.callTool({
      name: 'performance_pagespeed',
      arguments: { url: 'https://chrome.dev/?token=tok-123' },
    });

    const out = res.structuredContent as { finalUrl: string; warnings: string[]; run: { runWarnings: string[] } };
    expect(out.finalUrl).toBe('https://developer.chrome.com/?session=[REDACTED]');
    expect(out.run.runWarnings).toEqual([
      'Your test URL (https://chrome.dev/?token=[REDACTED]) was redirected to https://developer.chrome.com/?session=[REDACTED]. Try it directly.',
    ]);
    const text = JSON.stringify(res) + (perfkit.stderr.text ?? '');
    expect(text).not.toContain('tok-123');
    expect(text).not.toContain('ses-456');
  });

  it('serves a repeat call from the cache, keyed on device and categories', async () => {
    const fetch = psiOk();
    const pk = await connectPerfkit({ fetch });
    perfkit = pk;
    const call = (args: Record<string, unknown>) =>
      pk.client.callTool({
        name: 'performance_pagespeed',
        arguments: { url: 'https://developer.chrome.com/', ...args },
      });

    const first = await call({});
    pk.clock.advance(60_000);
    const second = await call({ categories: ['performance'] });

    expect(fetch.calls).toHaveLength(1);
    expect(first.structuredContent).toMatchObject({ cached: false });
    expect(second.structuredContent).toMatchObject({
      cached: true,
      cachedAt: '2026-10-23T12:00:00.000Z',
      performanceScore: 62,
    });

    await call({ device: 'DESKTOP' });
    await call({ categories: ['performance', 'seo'] });
    expect(fetch.calls).toHaveLength(3);
  });

  it('does not cache PSI errors', async () => {
    let n = 0;
    const fetch = fakeFetch(() =>
      n++ === 0
        ? {
            status: 400,
            body: {
              error: {
                code: 400,
                message: 'Lighthouse returned error: DNS_FAILURE. DNS servers could not resolve the provided domain.',
              },
            },
          }
        : { status: 200, body: fixture('psi/runpagespeed-mobile.json') },
    );
    perfkit = await connectPerfkit({ fetch });

    const first = await perfkit.client.callTool({
      name: 'performance_pagespeed',
      arguments: { url: 'https://developer.chrome.com/' },
    });
    const second = await perfkit.client.callTool({
      name: 'performance_pagespeed',
      arguments: { url: 'https://developer.chrome.com/' },
    });

    expect(first.isError).toBe(true);
    expect(second.structuredContent).toMatchObject({ status: 'ok', cached: false });
    expect(fetch.calls).toHaveLength(2);
  });

  it('applies the opt-in DNS check before calling PSI', async () => {
    const fetch = psiOk();
    perfkit = await connectPerfkit({
      fetch,
      env: { GOOGLE_API_KEY: TEST_API_KEY, PERFKIT_DNS_CHECK: '1' },
      lookup: async () => ['10.0.0.5'],
    });

    const res = await perfkit.client.callTool({
      name: 'performance_pagespeed',
      arguments: { url: 'https://internal-app.example.com/' },
    });

    expect(res.structuredContent).toMatchObject({ status: 'error', error: { code: 'invalid_input' } });
    expect(fetch.calls).toHaveLength(0);
  });
});

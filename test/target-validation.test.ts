import { afterEach, describe, expect, it } from 'vitest';
import { connectPerfkit, TEST_API_KEY, type Perfkit } from './support/harness.js';
import { fakeFetch, fixture } from './support/fake-google.js';

let perfkit: Perfkit | undefined;
afterEach(async () => {
  await perfkit?.close();
  perfkit = undefined;
});

const okFetch = () => fakeFetch(() => ({ status: 200, body: fixture('crux/current-url-phone.json') }));

/** Every tool that takes a URL. Later tools are added here as they land. */
const URL_TOOLS = ['performance_crux_current'];

describe.each(URL_TOOLS)('%s target validation', (tool) => {
  it.each([
    'ftp://example.com/',
    'https://alice:s3cr3t@example.com/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::ffff:127.0.0.1]/',
    'http://localhost:3000/',
    'http://metadata.google.internal/',
    'https://example.com/' + 'a'.repeat(3000),
  ])('rejects %s as invalid_input, not retryable, without calling Google', async (url) => {
    const fetch = okFetch();
    perfkit = await connectPerfkit({ fetch });

    const res = await perfkit.client.callTool({ name: tool, arguments: { url } });

    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({
      schemaVersion: '1.0.0',
      status: 'error',
      error: { code: 'invalid_input', source: 'perfkit', retryable: false },
    });
    expect(fetch.calls).toHaveLength(0);
    expect(JSON.stringify(res)).not.toContain('s3cr3t');
  });

  it('redacts sensitive query parameters in requestedUrl and logs, but sends them to Google', async () => {
    const fetch = okFetch();
    perfkit = await connectPerfkit({ fetch });

    const res = await perfkit.client.callTool({
      name: tool,
      arguments: { url: 'https://developer.chrome.com/?utm_source=x&token=tok-123&session=ses-456#top' },
    });

    expect(res.structuredContent).toMatchObject({
      requestedUrl: 'https://developer.chrome.com/?utm_source=x&token=[REDACTED]&session=[REDACTED]',
    });
    const output = JSON.stringify(res) + perfkit.stderr.text;
    expect(output).not.toContain('tok-123');
    expect(output).not.toContain('ses-456');
    expect(JSON.stringify(fetch.calls[0]?.body)).toContain('token=tok-123');
    expect(JSON.stringify(fetch.calls[0]?.body)).not.toContain('#top');
  });

  it('redacts credentials and sensitive parameters in requestedUrl of a rejected URL', async () => {
    perfkit = await connectPerfkit({ fetch: okFetch() });

    const res = await perfkit.client.callTool({
      name: tool,
      arguments: { url: 'https://alice:s3cr3t@example.com/?api_key=k-789' },
    });

    expect(res.structuredContent).toMatchObject({
      requestedUrl: 'https://[REDACTED]@example.com/?api_key=[REDACTED]',
    });
    const output = JSON.stringify(res) + perfkit.stderr.text;
    expect(output).not.toContain('s3cr3t');
    expect(output).not.toContain('k-789');
  });
});

describe('PERFKIT_DNS_CHECK', () => {
  const env = (dns?: string) => ({
    GOOGLE_API_KEY: TEST_API_KEY,
    ...(dns === undefined ? {} : { PERFKIT_DNS_CHECK: dns }),
  });

  it('is off by default: hosts are not resolved', async () => {
    const lookups: string[] = [];
    const fetch = okFetch();
    perfkit = await connectPerfkit({
      fetch,
      env: env(),
      lookup: async (host) => {
        lookups.push(host);
        return ['10.0.0.5'];
      },
    });

    const res = await perfkit.client.callTool({
      name: 'performance_crux_current',
      arguments: { url: 'https://developer.chrome.com/' },
    });

    expect(res.isError ?? false).toBe(false);
    expect(lookups).toEqual([]);
    expect(fetch.calls).toHaveLength(1);
  });

  it.each([[['10.0.0.5']], [['93.184.215.14', '127.0.0.1']], [['::1']], [['::ffff:169.254.169.254']]])(
    'when on, rejects a host resolving to %j as invalid_input without calling Google',
    async (addresses) => {
      const fetch = okFetch();
      perfkit = await connectPerfkit({ fetch, env: env('1'), lookup: async () => addresses });

      const res = await perfkit.client.callTool({
        name: 'performance_crux_current',
        arguments: { url: 'https://internal-app.example.com/' },
      });

      expect(res.isError).toBe(true);
      expect(res.structuredContent).toMatchObject({
        status: 'error',
        error: { code: 'invalid_input', source: 'perfkit', retryable: false },
      });
      expect(fetch.calls).toHaveLength(0);
    },
  );

  it('when on, accepts a host resolving only to public addresses', async () => {
    const lookups: string[] = [];
    const fetch = okFetch();
    perfkit = await connectPerfkit({
      fetch,
      env: env('1'),
      lookup: async (host) => {
        lookups.push(host);
        return ['142.250.180.14', '2a00:1450:4009:81f::200e'];
      },
    });

    const res = await perfkit.client.callTool({
      name: 'performance_crux_current',
      arguments: { url: 'https://developer.chrome.com/' },
    });

    expect(res.isError ?? false).toBe(false);
    expect(lookups).toEqual(['developer.chrome.com']);
    expect(fetch.calls).toHaveLength(1);
  });

  it('when on, rejects a host that does not resolve', async () => {
    const fetch = okFetch();
    perfkit = await connectPerfkit({
      fetch,
      env: env('1'),
      lookup: async () => {
        throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
      },
    });

    const res = await perfkit.client.callTool({
      name: 'performance_crux_current',
      arguments: { url: 'https://no-such-host.example.com/' },
    });

    expect(res.structuredContent).toMatchObject({ error: { code: 'invalid_input', retryable: false } });
    expect(fetch.calls).toHaveLength(0);
  });

  it('rejects an unrecognised value at startup, naming the variable', async () => {
    await expect(connectPerfkit({ fetch: okFetch(), env: env('yes') })).rejects.toThrow(/PERFKIT_DNS_CHECK/);
  });
});

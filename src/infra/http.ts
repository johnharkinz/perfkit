/**
 * HTTP client over an injected `fetch`, restricted to Google's fixed endpoints.
 *
 * This is the one place perfkit talks to the network. It sends the API key in
 * the `X-Goog-Api-Key` header so the key never appears in a URL, and it never
 * puts the key, request URLs or upstream text into errors.
 *
 * Extension point (#5): per-attempt timeouts via AbortController, retries with
 * exponential backoff and jitter on 429/5xx/timeouts, and per-endpoint
 * defaults all belong inside `request`. Callers already receive every HTTP
 * response (`{status, body}`) and decide what a status means for them.
 */
import { PerfkitError, type ErrorSource } from '../domain/errors.js';
import type { Logger } from './logger.js';

export const GOOGLE_ENDPOINTS = {
  cruxCurrent: { url: 'https://chromeuxreport.googleapis.com/v1/records:queryRecord', source: 'crux' },
  cruxHistory: { url: 'https://chromeuxreport.googleapis.com/v1/records:queryHistoryRecord', source: 'crux' },
  pagespeed: { url: 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed', source: 'pagespeed' },
} as const satisfies Record<string, { url: string; source: ErrorSource }>;

export type Endpoint = keyof typeof GOOGLE_ENDPOINTS;

export interface HttpRequest {
  endpoint: Endpoint;
  method: 'GET' | 'POST';
  /** Query parameters; arrays repeat the parameter (PSI `category`). */
  query?: Record<string, string | readonly string[]>;
  /** JSON request body (POST). */
  body?: unknown;
  /** Cancellation from the caller (e.g. the MCP client cancelling the tool call). */
  signal?: AbortSignal;
  logger: Logger;
}

export interface HttpResponse {
  status: number;
  /** Parsed JSON body; untrusted, validate before use. */
  body: unknown;
}

export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
}

export interface HttpClientOptions {
  fetch: typeof fetch;
  apiKey: string;
  now?: () => number;
}

export function createHttpClient(options: HttpClientOptions): HttpClient {
  const now = options.now ?? (() => performance.now());
  return {
    async request(req) {
      const { url: base, source } = GOOGLE_ENDPOINTS[req.endpoint];
      const url = new URL(base);
      for (const [name, value] of Object.entries(req.query ?? {})) {
        for (const v of typeof value === 'string' ? [value] : value) url.searchParams.append(name, v);
      }
      const headers: Record<string, string> = { Accept: 'application/json', 'X-Goog-Api-Key': options.apiKey };
      if (req.body !== undefined) headers['Content-Type'] = 'application/json';

      const started = now();
      let response: Response;
      try {
        response = await options.fetch(url, {
          method: req.method,
          headers,
          body: req.body === undefined ? undefined : JSON.stringify(req.body),
          signal: req.signal,
        });
      } catch {
        req.logger.warn('upstream request failed', { endpoint: req.endpoint, latencyMs: Math.round(now() - started) });
        throw new PerfkitError({
          code: 'upstream_error',
          source,
          retryable: true,
          message: `Could not reach ${source === 'crux' ? 'the CrUX API' : 'PageSpeed Insights'}.`,
        });
      }

      const text = await response.text();
      let body: unknown;
      try {
        body = text === '' ? undefined : JSON.parse(text);
      } catch {
        body = undefined;
      }
      req.logger.info('upstream response', {
        endpoint: req.endpoint,
        status: response.status,
        latencyMs: Math.round(now() - started),
      });
      return { status: response.status, body };
    },
  };
}

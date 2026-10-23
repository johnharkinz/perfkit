/**
 * HTTP client over an injected `fetch`, restricted to Google's fixed endpoints.
 *
 * This is the one place perfkit talks to the network. It:
 * - refuses any destination other than the three `GOOGLE_ENDPOINTS` (and
 *   refuses to follow redirects away from them);
 * - sends the API key in the `X-Goog-Api-Key` header so it never appears in
 *   a URL, and never puts the key, request URLs or upstream text into errors
 *   or logs;
 * - applies a per-attempt timeout and retries 429, 5xx, timeouts and network
 *   failures with exponential backoff and jitter, using the policy of the
 *   endpoint's source (PSI and CrUX have separate defaults in config).
 *
 * Callers receive the final HTTP response (`{status, body}`) and classify
 * non-2xx statuses with `upstreamErrorFromStatus`. Timeouts, cancellation and
 * network failures that outlast the retries are thrown as `PerfkitError`.
 */
import { PerfkitError, type ErrorSource } from '../domain/errors.js';
import type { UpstreamPolicy, UpstreamSource } from './config.js';
import type { Logger } from './logger.js';

export const GOOGLE_ENDPOINTS = {
  cruxCurrent: { url: 'https://chromeuxreport.googleapis.com/v1/records:queryRecord', source: 'crux' },
  cruxHistory: { url: 'https://chromeuxreport.googleapis.com/v1/records:queryHistoryRecord', source: 'crux' },
  pagespeed: { url: 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed', source: 'pagespeed' },
} as const satisfies Record<string, { url: string; source: UpstreamSource & ErrorSource }>;

export type Endpoint = keyof typeof GOOGLE_ENDPOINTS;

const ALLOWED_URLS: ReadonlySet<string> = new Set(Object.values(GOOGLE_ENDPOINTS).map((e) => e.url));

export interface HttpRequest {
  endpoint: Endpoint;
  method: 'GET' | 'POST';
  /** Query parameters; arrays repeat the parameter (PSI `category`). */
  query?: Record<string, string | readonly string[]>;
  /** JSON request body (POST). */
  body?: unknown;
  /**
   * Cancellation from the caller (the MCP client cancelling, or an overall
   * budget such as the overview's). Aborting stops retries and throws
   * `upstream_timeout`.
   */
  signal?: AbortSignal;
  logger: Logger;
}

export interface HttpResponse {
  status: number;
  /** Parsed JSON body; untrusted, validate before use. `undefined` when empty or not JSON. */
  body: unknown;
}

export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
}

/** Waits `ms`, rejecting early if `signal` aborts. Injected so tests never wait for real backoff. */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface HttpClientOptions {
  fetch: typeof fetch;
  apiKey: string;
  /** Per-source timeout and retry policy (see `loadConfig`). */
  policies: Readonly<Record<UpstreamSource, UpstreamPolicy>>;
  sleep?: Sleep;
  /** Jitter source in [0, 1). */
  random?: () => number;
  /** Monotonic clock in ms, for latency logging. */
  now?: () => number;
}

/** First backoff delay; each retry doubles it, up to `BACKOFF_MAX_MS`. Jitter picks 50–100% of that. */
export const BACKOFF_BASE_MS = 500;
export const BACKOFF_MAX_MS = 8_000;

export function backoffDelayMs(retry: number, random: () => number): number {
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** retry);
  return Math.round(ceiling * (0.5 + 0.5 * random()));
}

export const realSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason as Error);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason as Error);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

const LABEL: Record<UpstreamSource, string> = { crux: 'The CrUX API', pagespeed: 'PageSpeed Insights' };

function refused(): PerfkitError {
  return new PerfkitError({
    code: 'internal_error',
    source: 'perfkit',
    retryable: false,
    message: 'perfkit refused to call a destination outside its fixed Google endpoints.',
  });
}

/** Builds the request URL and checks it against the allow-list. */
function endpointUrl(req: HttpRequest): { url: URL; source: UpstreamSource } {
  if (!Object.hasOwn(GOOGLE_ENDPOINTS, req.endpoint)) throw refused();
  const { url: base, source } = GOOGLE_ENDPOINTS[req.endpoint];
  const url = new URL(base);
  for (const [name, value] of Object.entries(req.query ?? {})) {
    for (const v of typeof value === 'string' ? [value] : value) url.searchParams.append(name, v);
  }
  if (!ALLOWED_URLS.has(`${url.origin}${url.pathname}`)) throw refused();
  return { url, source };
}

/** Google's machine-readable error status (e.g. "UNAVAILABLE"); never the free-text message. */
function googleStatus(body: unknown): string | undefined {
  const status = (body as { error?: { status?: unknown } } | undefined)?.error?.status;
  return typeof status === 'string' && /^[A-Z_]{1,64}$/.test(status) ? status : undefined;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Rejects when `signal` aborts, so a `fetch` that ignores its signal still can't hang an attempt. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason as Error);
    const onAbort = (): void => reject(signal.reason as Error);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e as Error);
      },
    );
  });
}

type Attempt =
  | { kind: 'response'; response: HttpResponse; googleStatus?: string }
  | { kind: 'timeout' }
  | { kind: 'network' }
  | { kind: 'cancelled' };

export function createHttpClient(options: HttpClientOptions): HttpClient {
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? realSleep;
  const random = options.random ?? Math.random;

  async function attempt(url: URL, req: HttpRequest, timeoutMs: number): Promise<Attempt> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error('timeout')), timeoutMs);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout.signal]) : timeout.signal;
    const headers: Record<string, string> = { Accept: 'application/json', 'X-Goog-Api-Key': options.apiKey };
    if (req.body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      const response = await untilAborted(
        options.fetch(url, {
          method: req.method,
          headers,
          body: req.body === undefined ? undefined : JSON.stringify(req.body),
          redirect: 'error',
          signal,
        }),
        signal,
      );
      const text = await untilAborted(response.text(), signal);
      let body: unknown;
      try {
        body = text === '' ? undefined : JSON.parse(text);
      } catch {
        body = undefined;
      }
      const status = googleStatus(body);
      return {
        kind: 'response',
        response: { status: response.status, body },
        ...(status ? { googleStatus: status } : {}),
      };
    } catch {
      if (req.signal?.aborted) return { kind: 'cancelled' };
      if (timeout.signal.aborted) return { kind: 'timeout' };
      return { kind: 'network' };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async request(req) {
      const { url, source } = endpointUrl(req);
      const policy = options.policies[source];
      const log = req.logger.child({ endpoint: req.endpoint });
      const timedOut = (): PerfkitError =>
        new PerfkitError({
          code: 'upstream_timeout',
          source,
          retryable: true,
          message: `${LABEL[source]} did not respond in time.`,
        });

      for (let n = 0; ; n++) {
        const attemptNo = n + 1;
        const started = now();
        const result = await attempt(url, req, policy.timeoutMs);
        const latencyMs = Math.round(now() - started);

        let reason: string;
        if (result.kind === 'cancelled') {
          log.warn('upstream request cancelled', { attempt: attemptNo, latencyMs });
          throw timedOut();
        } else if (result.kind === 'response') {
          const { status } = result.response;
          const fields = {
            attempt: attemptNo,
            status,
            latencyMs,
            ...(result.googleStatus ? { googleStatus: result.googleStatus } : {}),
          };
          if (status === 429) log.warn('upstream rate limited', fields);
          else if (status >= 400) log.warn('upstream error response', fields);
          else log.info('upstream response', fields);
          if (!isRetryableStatus(status)) return result.response;
          if (n >= policy.retries) {
            log.warn('upstream retries exhausted', { attempts: attemptNo, status });
            return result.response;
          }
          reason = status === 429 ? 'rate_limit' : 'server_error';
        } else {
          const timeout = result.kind === 'timeout';
          log.warn(timeout ? 'upstream timeout' : 'upstream request failed', {
            attempt: attemptNo,
            latencyMs,
            ...(timeout ? { timeoutMs: policy.timeoutMs } : {}),
          });
          if (n >= policy.retries) {
            log.warn('upstream retries exhausted', { attempts: attemptNo, reason: result.kind });
            if (timeout) throw timedOut();
            throw new PerfkitError({
              code: 'upstream_error',
              source,
              retryable: true,
              message: `${LABEL[source]} could not be reached.`,
            });
          }
          reason = result.kind;
        }

        const delayMs = backoffDelayMs(n, random);
        log.info('upstream retry scheduled', { attempt: attemptNo, reason, delayMs });
        try {
          await sleep(delayMs, req.signal);
        } catch {
          log.warn('upstream request cancelled', { attempt: attemptNo });
          throw timedOut();
        }
      }
    },
  };
}

/**
 * perfkit's error vocabulary. Messages on PerfkitError are written by perfkit
 * and are safe to show to clients: never build one from upstream text, request
 * URLs or anything that could contain the API key.
 */

export const ERROR_CODES = [
  'invalid_input',
  'upstream_rate_limit',
  'upstream_timeout',
  'upstream_error',
  'internal_error',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_SOURCES = ['perfkit', 'crux', 'pagespeed'] as const;
export type ErrorSource = (typeof ERROR_SOURCES)[number];

export interface ErrorInfo {
  code: ErrorCode;
  source: ErrorSource;
  retryable: boolean;
  message: string;
}

export class PerfkitError extends Error implements ErrorInfo {
  readonly code: ErrorCode;
  readonly source: ErrorSource;
  readonly retryable: boolean;

  constructor(info: ErrorInfo) {
    super(info.message);
    this.name = 'PerfkitError';
    this.code = info.code;
    this.source = info.source;
    this.retryable = info.retryable;
  }

  toInfo(): ErrorInfo {
    return { code: this.code, source: this.source, retryable: this.retryable, message: this.message };
  }
}

const SOURCE_LABEL: Record<ErrorSource, string> = {
  perfkit: 'perfkit',
  crux: 'CrUX API',
  pagespeed: 'PageSpeed Insights',
};

/** Classifies a non-success upstream HTTP status. Retries and timeouts are layered on in the HTTP client. */
export function upstreamErrorFromStatus(source: ErrorSource, status: number): PerfkitError {
  const label = SOURCE_LABEL[source];
  if (status === 429) {
    return new PerfkitError({
      code: 'upstream_rate_limit',
      source,
      retryable: true,
      message: `${label} rate limit exceeded (HTTP 429).`,
    });
  }
  return new PerfkitError({
    code: 'upstream_error',
    source,
    retryable: status >= 500,
    message: `${label} returned HTTP ${status}.`,
  });
}

/** Maps anything thrown to a client-safe error. Unknown errors never expose their message. */
export function toErrorInfo(err: unknown): ErrorInfo {
  if (err instanceof PerfkitError) return err.toInfo();
  return { code: 'internal_error', source: 'perfkit', retryable: false, message: 'perfkit hit an unexpected error.' };
}

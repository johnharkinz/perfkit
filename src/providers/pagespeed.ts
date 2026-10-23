/**
 * PageSpeed Insights provider: builds runPagespeed requests, validates
 * Google's raw response as untrusted data, and returns the typed subset of the
 * Lighthouse result perfkit uses. No selection or presentation logic lives
 * here (see domain/normalize-lab.ts).
 *
 * PSI's embedded CrUX copy (`loadingExperience`, `originLoadingExperience`)
 * is deliberately not read: field data comes only from the CrUX APIs.
 *
 * Failures: PSI reports an unreachable or failing page as an HTTP error
 * (usually 400, sometimes 500) whose body says "Lighthouse returned error:
 * <CODE>", or as HTTP 200 with `lighthouseResult.runtimeError`. Both become
 * `upstream_error` carrying Lighthouse's message (URLs stripped), so perfkit
 * never reports metrics for a page PSI could not load.
 */
import * as z from 'zod';
import { PerfkitError, upstreamErrorFromStatus } from '../domain/errors.js';
import type { HttpClient } from '../infra/http.js';
import type { Logger } from '../infra/logger.js';

export type PsiStrategy = 'MOBILE' | 'DESKTOP';
export type PsiCategory = 'PERFORMANCE' | 'ACCESSIBILITY' | 'BEST_PRACTICES' | 'SEO';

export interface PagespeedQuery {
  /** The URL to test, already validated. */
  url: string;
  strategy: PsiStrategy;
  /** PERFORMANCE is always sent, whether listed or not. */
  categories: readonly PsiCategory[];
  signal?: AbortSignal;
  logger: Logger;
}

const AuditSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().default(''),
  score: z.number().nullable().optional(),
  scoreDisplayMode: z.string().optional(),
  displayValue: z.string().optional(),
  numericValue: z.number().optional(),
  numericUnit: z.string().optional(),
  metricSavings: z.record(z.string(), z.number()).optional(),
  details: z
    .looseObject({
      type: z.string().optional(),
      overallSavingsMs: z.number().optional(),
      overallSavingsBytes: z.number().optional(),
      // Element extraction walks table/list items only; other shapes (a checklist's keyed object) are ignored.
      items: z
        .unknown()
        .optional()
        .transform((items) => (Array.isArray(items) ? (items as unknown[]) : undefined)),
    })
    .optional(),
});
export type PsiAudit = z.infer<typeof AuditSchema>;

/**
 * Audits are read one by one: an audit perfkit cannot read is dropped rather than rejecting the run, since
 * Lighthouse adds and reshapes audits between versions and most of them are never shown.
 */
const AuditsSchema = z.record(z.string(), z.unknown()).transform((raw) => {
  const audits: Record<string, PsiAudit> = {};
  for (const [id, value] of Object.entries(raw)) {
    const parsed = AuditSchema.safeParse(value);
    if (parsed.success) audits[id] = parsed.data;
  }
  return audits;
});

const AuditRefSchema = z.object({ id: z.string(), weight: z.number().default(0), group: z.string().optional() });
export type PsiAuditRef = z.infer<typeof AuditRefSchema>;

const CategorySchema = z.object({
  score: z.number().nullable().optional(),
  auditRefs: z.array(AuditRefSchema).default([]),
});
export type PsiCategoryResult = z.infer<typeof CategorySchema>;

const LighthouseResultSchema = z.object({
  requestedUrl: z.string().optional(),
  finalUrl: z.string().optional(),
  finalDisplayedUrl: z.string().optional(),
  mainDocumentUrl: z.string().optional(),
  lighthouseVersion: z.string(),
  fetchTime: z.string().optional(),
  userAgent: z.string().optional(),
  runtimeError: z.object({ code: z.string().optional(), message: z.string().optional() }).nullable().optional(),
  runWarnings: z.array(z.string()).default([]),
  configSettings: z.object({ formFactor: z.string().optional(), locale: z.string().optional() }).optional(),
  environment: z.object({ networkUserAgent: z.string().optional(), benchmarkIndex: z.number().optional() }).optional(),
  timing: z.object({ total: z.number().optional() }).optional(),
  categories: z.record(z.string(), CategorySchema).default({}),
  audits: AuditsSchema.default({}),
});

const ResponseSchema = z.object({
  analysisUTCTimestamp: z.string().optional(),
  lighthouseResult: LighthouseResultSchema,
});

export interface PagespeedRecord {
  analysisUTCTimestamp?: string;
  lighthouse: Omit<z.infer<typeof LighthouseResultSchema>, 'runtimeError'>;
}

export interface PagespeedClient {
  run(query: PagespeedQuery): Promise<PagespeedRecord>;
}

const ErrorBodySchema = z.object({
  error: z.object({
    code: z.number().optional(),
    message: z.string().optional(),
    status: z.string().optional(),
    errors: z
      .array(z.object({ message: z.string().optional(), domain: z.string().optional(), reason: z.string().optional() }))
      .optional(),
  }),
});

/** Lighthouse errors worth retrying later: the page loaded but did not paint or hung. */
const TRANSIENT_LIGHTHOUSE_ERRORS = new Set(['NO_FCP', 'PAGE_HUNG']);
const LIGHTHOUSE_ERROR = /Lighthouse returned error: ([A-Z_]+)/;
const MAX_MESSAGE = 400;

/** Upstream text is untrusted: strip anything URL-like (could carry tokens) and cap the length. */
function sanitizeUpstreamMessage(text: string): string {
  const cleaned = text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > MAX_MESSAGE ? `${cleaned.slice(0, MAX_MESSAGE - 1)}…` : cleaned;
}

function lighthouseError(code: string, message: string): PerfkitError {
  return new PerfkitError({
    code: 'upstream_error',
    source: 'pagespeed',
    retryable: TRANSIENT_LIGHTHOUSE_ERRORS.has(code),
    message: `PageSpeed Insights could not test the page: ${sanitizeUpstreamMessage(message)}`,
  });
}

function errorFromResponse(status: number, body: unknown): PerfkitError {
  const parsed = ErrorBodySchema.safeParse(body);
  if (parsed.success) {
    const { message = '', errors = [] } = parsed.data.error;
    const code = LIGHTHOUSE_ERROR.exec(message)?.[1];
    const isLighthouse = code !== undefined || errors.some((e) => e.domain === 'lighthouse');
    if (isLighthouse && status !== 429) return lighthouseError(code ?? '', message || 'Lighthouse returned an error.');
  }
  return upstreamErrorFromStatus('pagespeed', status);
}

function malformed(): PerfkitError {
  return new PerfkitError({
    code: 'upstream_error',
    source: 'pagespeed',
    retryable: false,
    message: 'PageSpeed Insights returned a response perfkit could not read.',
  });
}

export function createPagespeedClient(http: HttpClient): PagespeedClient {
  return {
    async run(query) {
      const categories = ['PERFORMANCE', ...query.categories.filter((c) => c !== 'PERFORMANCE')];
      const response = await http.request({
        endpoint: 'pagespeed',
        method: 'GET',
        query: { url: query.url, strategy: query.strategy, category: categories },
        signal: query.signal,
        logger: query.logger,
      });
      if (response.status < 200 || response.status >= 300) throw errorFromResponse(response.status, response.body);

      const parsed = ResponseSchema.safeParse(response.body);
      if (!parsed.success) throw malformed();
      const { runtimeError, ...lighthouse } = parsed.data.lighthouseResult;
      // Older Lighthouse versions send `{code: "NO_ERROR"}` on success.
      if (runtimeError && runtimeError.code !== 'NO_ERROR') {
        const code = runtimeError.code ?? '';
        throw lighthouseError(code, runtimeError.message ?? `Lighthouse returned error: ${code}.`);
      }
      return {
        ...(parsed.data.analysisUTCTimestamp ? { analysisUTCTimestamp: parsed.data.analysisUTCTimestamp } : {}),
        lighthouse,
      };
    },
  };
}

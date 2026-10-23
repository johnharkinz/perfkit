/**
 * CrUX provider: builds CrUX API requests, validates Google's raw responses
 * as untrusted data, and returns typed raw records keyed by canonical metric
 * name. No rating or presentation logic lives here.
 *
 * Extension points:
 * - #3 (done): a 404 becomes `{ kind: 'no_data' }` (not an error); `origin`
 *   scope and omitted form factor (ALL) are already expressed by `CruxQuery`.
 * - #8: add `queryHistory` beside `queryCurrent`, reusing `parseMetricName`
 *   and the bin schema (history densities may be "NaN", p75s may be null).
 */
import * as z from 'zod';
import { PerfkitError, upstreamErrorFromStatus } from '../domain/errors.js';
import { CRUX_REQUEST_METRICS, METRICS, metricFromCruxName, type MetricName } from '../domain/metrics.js';
import type { HttpClient } from '../infra/http.js';
import type { Logger } from '../infra/logger.js';

export type CruxFormFactor = 'PHONE' | 'DESKTOP' | 'TABLET';

export interface CruxQuery {
  scope: 'url' | 'origin';
  /** The URL or origin to query, already validated. */
  target: string;
  /** Omit for all form factors combined. */
  formFactor?: CruxFormFactor;
  signal?: AbortSignal;
  logger: Logger;
}

const NumOrString = z.union([z.number(), z.string()]);

const DateSchema = z.object({ year: z.number().int(), month: z.number().int(), day: z.number().int() });
export type CruxDate = z.infer<typeof DateSchema>;

const CurrentMetricSchema = z.object({
  histogram: z.array(z.object({ start: NumOrString, end: NumOrString.optional(), density: z.number() })).default([]),
  percentiles: z.object({ p75: NumOrString.nullable().optional() }).optional(),
});

const CurrentResponseSchema = z.object({
  record: z.object({
    key: z.object({
      url: z.string().optional(),
      origin: z.string().optional(),
      formFactor: z.string().optional(),
    }),
    metrics: z.record(z.string(), z.unknown()).default({}),
    collectionPeriod: z.object({ firstDate: DateSchema, lastDate: DateSchema }),
  }),
  urlNormalizationDetails: z.object({ originalUrl: z.string(), normalizedUrl: z.string() }).optional(),
});

export interface CruxRawMetric {
  /** The CrUX metric name the data was read from (canonical or alias). */
  cruxName: string;
  /** Bin edges and p75 as Google sent them (CLS values are strings). */
  histogram: { start: number | string; end?: number | string; density: number }[];
  p75: number | string | null;
}

export interface CruxCurrentRecord {
  key: { url?: string; origin?: string; formFactor?: string };
  metrics: Partial<Record<MetricName, CruxRawMetric>>;
  collectionPeriod: { firstDate: CruxDate; lastDate: CruxDate };
  urlNormalizationDetails?: { originalUrl: string; normalizedUrl: string };
}

/** `no_data`: CrUX answered 404, i.e. it publishes no data for this key. A valid finding, not an error. */
export type CruxCurrentOutcome = { kind: 'record'; record: CruxCurrentRecord } | { kind: 'no_data' };

export interface CruxClient {
  queryCurrent(query: CruxQuery): Promise<CruxCurrentOutcome>;
}

function malformed(): PerfkitError {
  return new PerfkitError({
    code: 'upstream_error',
    source: 'crux',
    retryable: false,
    message: 'The CrUX API returned a response perfkit could not read.',
  });
}

/** Reads known metrics (accepting aliases), skipping unknown ones; canonical names win over aliases. */
function readMetrics(raw: Record<string, unknown>): Partial<Record<MetricName, CruxRawMetric>> {
  const found: Partial<Record<MetricName, CruxRawMetric>> = {};
  for (const [cruxName, value] of Object.entries(raw)) {
    const name = metricFromCruxName(cruxName);
    if (!name) continue;
    const parsed = CurrentMetricSchema.safeParse(value);
    if (!parsed.success) throw malformed();
    const existing = found[name];
    if (existing && existing.cruxName === METRICS[name].cruxName) continue;
    found[name] = { cruxName, histogram: parsed.data.histogram, p75: parsed.data.percentiles?.p75 ?? null };
  }
  return found;
}

export function createCruxClient(http: HttpClient): CruxClient {
  return {
    async queryCurrent(query) {
      const body: Record<string, unknown> = {
        [query.scope]: query.target,
        metrics: CRUX_REQUEST_METRICS,
      };
      if (query.formFactor) body['formFactor'] = query.formFactor;

      const response = await http.request({
        endpoint: 'cruxCurrent',
        method: 'POST',
        body,
        signal: query.signal,
        logger: query.logger,
      });
      if (response.status === 404) return { kind: 'no_data' };
      if (response.status < 200 || response.status >= 300) throw upstreamErrorFromStatus('crux', response.status);

      const parsed = CurrentResponseSchema.safeParse(response.body);
      if (!parsed.success) throw malformed();
      const { record, urlNormalizationDetails } = parsed.data;
      return {
        kind: 'record',
        record: {
          key: record.key,
          metrics: readMetrics(record.metrics),
          collectionPeriod: record.collectionPeriod,
          ...(urlNormalizationDetails ? { urlNormalizationDetails } : {}),
        },
      };
    },
  };
}

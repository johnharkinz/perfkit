/**
 * CrUX provider: builds CrUX API requests, validates Google's raw responses
 * as untrusted data, and returns typed raw records keyed by canonical metric
 * name. No rating or presentation logic lives here.
 *
 * Extension points:
 * - #3 (done): a 404 becomes `{ kind: 'no_data' }` (not an error); `origin`
 *   scope and omitted form factor (ALL) are already expressed by `CruxQuery`.
 * - #8 (done): `queryHistory` reads only the p75 timeseries (null or "NaN"
 *   where CrUX had no data); a 404 is `no_data`, as for current.
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

// History histograms are not reported (each point is {start, end, p75, rating}), so they are not read.
const HistoryMetricSchema = z.object({
  percentilesTimeseries: z.object({ p75s: z.array(z.union([z.number(), z.string(), z.null()])) }).optional(),
});

const HistoryResponseSchema = z.object({
  record: z.object({
    key: z.object({
      url: z.string().optional(),
      origin: z.string().optional(),
      formFactor: z.string().optional(),
    }),
    metrics: z.record(z.string(), z.unknown()).default({}),
    collectionPeriods: z.array(z.object({ firstDate: DateSchema, lastDate: DateSchema })),
  }),
  urlNormalizationDetails: z.object({ originalUrl: z.string(), normalizedUrl: z.string() }).optional(),
});

export interface CruxHistoryQuery extends CruxQuery {
  /** Number of weekly windows to request (1–40). */
  periods: number;
}

export interface CruxRawHistoryMetric {
  /** The CrUX metric name the data was read from (canonical or alias). */
  cruxName: string;
  /** One p75 per collection period, same order; null (or "NaN") where CrUX had no data. CLS values are strings. */
  p75s: (number | string | null)[];
}

export interface CruxHistoryRecord {
  key: { url?: string; origin?: string; formFactor?: string };
  metrics: Partial<Record<MetricName, CruxRawHistoryMetric>>;
  /** Oldest first. */
  collectionPeriods: { firstDate: CruxDate; lastDate: CruxDate }[];
  urlNormalizationDetails?: { originalUrl: string; normalizedUrl: string };
}

export type CruxHistoryOutcome = { kind: 'record'; record: CruxHistoryRecord } | { kind: 'no_data' };

export interface CruxClient {
  queryCurrent(query: CruxQuery): Promise<CruxCurrentOutcome>;
  queryHistory(query: CruxHistoryQuery): Promise<CruxHistoryOutcome>;
}

function malformed(): PerfkitError {
  return new PerfkitError({
    code: 'upstream_error',
    source: 'crux',
    retryable: false,
    message: 'The CrUX API returned a response perfkit could not read.',
  });
}

/**
 * Reads known metrics (accepting aliases) with `read`, skipping unknown ones;
 * canonical names win over aliases. `read` returns undefined for malformed data.
 */
function readMetrics<T extends { cruxName: string }>(
  raw: Record<string, unknown>,
  read: (cruxName: string, value: unknown) => T | undefined,
): Partial<Record<MetricName, T>> {
  const found: Partial<Record<MetricName, T>> = {};
  for (const [cruxName, value] of Object.entries(raw)) {
    const name = metricFromCruxName(cruxName);
    if (!name) continue;
    const metric = read(cruxName, value);
    if (!metric) throw malformed();
    const existing = found[name];
    if (existing && existing.cruxName === METRICS[name].cruxName) continue;
    found[name] = metric;
  }
  return found;
}

function readCurrentMetric(cruxName: string, value: unknown): CruxRawMetric | undefined {
  const parsed = CurrentMetricSchema.safeParse(value);
  if (!parsed.success) return undefined;
  return { cruxName, histogram: parsed.data.histogram, p75: parsed.data.percentiles?.p75 ?? null };
}

/** Each timeseries must line up with the collection periods; anything else is unreadable. */
function historyMetricReader(periodCount: number) {
  return (cruxName: string, value: unknown): CruxRawHistoryMetric | undefined => {
    const parsed = HistoryMetricSchema.safeParse(value);
    if (!parsed.success) return undefined;
    const p75s = parsed.data.percentilesTimeseries?.p75s ?? Array<null>(periodCount).fill(null);
    if (p75s.length !== periodCount) return undefined;
    return { cruxName, p75s };
  };
}

function requestBody(query: CruxQuery): Record<string, unknown> {
  const body: Record<string, unknown> = {
    [query.scope]: query.target,
    metrics: CRUX_REQUEST_METRICS,
  };
  if (query.formFactor) body['formFactor'] = query.formFactor;
  return body;
}

export function createCruxClient(http: HttpClient): CruxClient {
  return {
    async queryHistory(query) {
      const response = await http.request({
        endpoint: 'cruxHistory',
        method: 'POST',
        // Always sent: Google's default (25) differs from perfkit's (40).
        body: { ...requestBody(query), collectionPeriodCount: query.periods },
        signal: query.signal,
        logger: query.logger,
      });
      if (response.status === 404) return { kind: 'no_data' };
      if (response.status < 200 || response.status >= 300) throw upstreamErrorFromStatus('crux', response.status);

      const parsed = HistoryResponseSchema.safeParse(response.body);
      if (!parsed.success) throw malformed();
      const { record, urlNormalizationDetails } = parsed.data;
      return {
        kind: 'record',
        record: {
          key: record.key,
          metrics: readMetrics(record.metrics, historyMetricReader(record.collectionPeriods.length)),
          collectionPeriods: record.collectionPeriods,
          ...(urlNormalizationDetails ? { urlNormalizationDetails } : {}),
        },
      };
    },

    async queryCurrent(query) {
      const response = await http.request({
        endpoint: 'cruxCurrent',
        method: 'POST',
        body: requestBody(query),
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
          metrics: readMetrics(record.metrics, readCurrentMetric),
          collectionPeriod: record.collectionPeriod,
          ...(urlNormalizationDetails ? { urlNormalizationDetails } : {}),
        },
      };
    },
  };
}

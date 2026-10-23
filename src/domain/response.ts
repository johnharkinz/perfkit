/**
 * The shared response format (schemaVersion 1.0.0).
 *
 * These Zod schemas are the contract every tool's structuredContent must
 * match. They are transport-independent; the tool layer hands them to MCP as
 * output schemas. Each tool's result is a single object (MCP requires an
 * object output schema), so source-specific fields are optional and present
 * only when status is "ok".
 */
import * as z from 'zod';
import { ERROR_CODES, ERROR_SOURCES, type ErrorInfo } from './errors.js';
import { METRIC_NAMES, type MetricName } from './metrics.js';

export const SCHEMA_VERSION = '1.0.0';

export const ProviderSchema = z.enum(['pagespeed', 'crux']);
export const DataTypeSchema = z.enum(['lab', 'field_current', 'field_history']);
export const ScopeSchema = z.enum(['url', 'origin']);
export const StatusSchema = z.enum(['ok', 'no_data', 'error']);
/** Every device perfkit can report on. Each tool's input narrows this. */
export const DeviceSchema = z.enum(['PHONE', 'DESKTOP', 'TABLET', 'ALL']);
export type Device = z.infer<typeof DeviceSchema>;
export type Scope = z.infer<typeof ScopeSchema>;
export type Status = z.infer<typeof StatusSchema>;

export const ErrorSchema = z.object({
  code: z.enum(ERROR_CODES),
  source: z.enum(ERROR_SOURCES),
  retryable: z.boolean(),
  message: z.string(),
});

/** Fields every result carries, whatever its provider and status. */
export const baseResultShape = {
  schemaVersion: z.literal(SCHEMA_VERSION),
  requestedUrl: z.string().describe('The URL as requested, with sensitive parts redacted.'),
  provider: ProviderSchema,
  dataType: DataTypeSchema,
  device: DeviceSchema,
  status: StatusSchema,
  collectedAt: z.string().describe('ISO 8601 time perfkit fetched this evidence from Google.'),
  cached: z.boolean(),
  cachedAt: z.string().optional().describe('ISO 8601 time the cache entry was filled; present only when cached.'),
  warnings: z.array(z.string()),
  error: ErrorSchema.optional(),
};

export const MetricNameSchema = z.enum(METRIC_NAMES);

export const HistogramBinSchema = z.object({
  start: z.number(),
  end: z.number().nullable().describe('null for the open-ended last bin.'),
  density: z.number().describe('Fraction of page loads in this bin (0–1).'),
});

export const FieldMetricSchema = z.object({
  p75: z.number().nullable(),
  unit: z.enum(['ms', 'unitless']),
  rating: z.enum(['good', 'needs_improvement', 'poor']).nullable(),
  histogram: z.array(HistogramBinSchema),
  group: z.enum(['core_web_vital', 'supporting']),
  provenance: z.object({
    source: z.literal('crux'),
    cruxMetric: z.string().describe('The CrUX metric name this value was read from.'),
  }),
});
export type FieldMetric = z.infer<typeof FieldMetricSchema>;

/** Metrics keyed by canonical name; a metric Google did not return is absent. */
export const FieldMetricsSchema = z.object(
  Object.fromEntries(METRIC_NAMES.map((name) => [name, FieldMetricSchema.optional()])) as Record<
    MetricName,
    z.ZodOptional<typeof FieldMetricSchema>
  >,
);
export type FieldMetrics = z.infer<typeof FieldMetricsSchema>;

export const CollectionPeriodSchema = z.object({
  start: z.string().describe('First day of the 28-day window, YYYY-MM-DD (inclusive).'),
  end: z.string().describe('Last day of the 28-day window, YYYY-MM-DD (inclusive).'),
});

/** A CrUX record key: exactly one of url/origin, plus the form factor (absent for all devices). */
export const CruxKeySchema = z.object({
  url: z.string().optional(),
  origin: z.string().optional(),
  formFactor: z.enum(['PHONE', 'DESKTOP', 'TABLET']).optional().describe('Absent when device is ALL.'),
});
export type CruxKey = z.infer<typeof CruxKeySchema>;

export const FieldCurrentResultSchema = z.object({
  ...baseResultShape,
  provider: z.literal('crux'),
  dataType: z.literal('field_current'),
  scope: ScopeSchema,
  requestedKey: CruxKeySchema.optional().describe('The URL or origin perfkit asked CrUX for.'),
  returnedKey: CruxKeySchema.optional().describe('The key CrUX reported for the returned record.'),
  collectionPeriod: CollectionPeriodSchema.optional(),
  metrics: FieldMetricsSchema.optional(),
  omittedMetrics: z
    .array(MetricNameSchema)
    .optional()
    .describe('Metrics perfkit requested that Google returned no data for. Absent data, not zero.'),
});
export type FieldCurrentResult = z.infer<typeof FieldCurrentResultSchema>;

/** Context every result is built from, whatever its outcome. */
export interface ResultContext {
  requestedUrl: string;
  device: Device;
  collectedAt: string;
}

export function errorFieldCurrentResult(ctx: ResultContext & { scope: Scope }, error: ErrorInfo): FieldCurrentResult {
  return {
    schemaVersion: SCHEMA_VERSION,
    requestedUrl: ctx.requestedUrl,
    provider: 'crux',
    dataType: 'field_current',
    scope: ctx.scope,
    device: ctx.device,
    status: 'error',
    collectedAt: ctx.collectedAt,
    cached: false,
    warnings: [],
    error,
  };
}

/** One field history window: real CrUX collection dates, and null p75/rating when CrUX had no data that week. */
export const HistoryPointSchema = z.object({
  start: z.string().describe('First day of this 28-day window, YYYY-MM-DD (inclusive).'),
  end: z.string().describe('Last day of this 28-day window, YYYY-MM-DD (inclusive).'),
  p75: z.number().nullable().describe('null when CrUX has no data for this window (never zero).'),
  rating: z.enum(['good', 'needs_improvement', 'poor']).nullable().describe('null when p75 is null.'),
});
export type HistoryPoint = z.infer<typeof HistoryPointSchema>;

/** History series keyed by canonical metric name, oldest window first; a metric Google did not return is absent. */
export const FieldHistoryMetricsSchema = z.object(
  Object.fromEntries(METRIC_NAMES.map((name) => [name, z.array(HistoryPointSchema).optional()])) as Record<
    MetricName,
    z.ZodOptional<z.ZodArray<typeof HistoryPointSchema>>
  >,
);
export type FieldHistoryMetrics = z.infer<typeof FieldHistoryMetricsSchema>;

const MetricUnitSchema = z.enum(['ms', 'unitless']);

/** The unit of each returned metric's p75 values. */
export const MetricUnitsSchema = z.object(
  Object.fromEntries(METRIC_NAMES.map((name) => [name, MetricUnitSchema.optional()])) as Record<
    MetricName,
    z.ZodOptional<typeof MetricUnitSchema>
  >,
);
export type MetricUnits = z.infer<typeof MetricUnitsSchema>;

export const FieldHistoryResultSchema = z.object({
  ...baseResultShape,
  provider: z.literal('crux'),
  dataType: z.literal('field_history'),
  scope: ScopeSchema,
  periods: z.number().int().describe('How many weekly windows perfkit requested (1–40).'),
  requestedKey: CruxKeySchema.optional().describe('The URL or origin perfkit asked CrUX for.'),
  returnedKey: CruxKeySchema.optional().describe('The key CrUX reported for the returned record.'),
  collectionPeriods: z
    .array(CollectionPeriodSchema)
    .optional()
    .describe('Every overlapping 28-day window, oldest first; each metric series uses the same order.'),
  metrics: FieldHistoryMetricsSchema.optional().describe(
    'Per metric, one {start, end, p75, rating} point per window, oldest first. Gaps are null, never dropped.',
  ),
  units: MetricUnitsSchema.optional().describe('Unit of each returned metric p75.'),
  omittedMetrics: z
    .array(MetricNameSchema)
    .optional()
    .describe('Metrics perfkit requested that Google returned no data for. Absent data, not zero.'),
});
export type FieldHistoryResult = z.infer<typeof FieldHistoryResultSchema>;

export function errorFieldHistoryResult(
  ctx: ResultContext & { scope: Scope; periods: number },
  error: ErrorInfo,
): FieldHistoryResult {
  return {
    schemaVersion: SCHEMA_VERSION,
    requestedUrl: ctx.requestedUrl,
    provider: 'crux',
    dataType: 'field_history',
    scope: ctx.scope,
    device: ctx.device,
    status: 'error',
    collectedAt: ctx.collectedAt,
    cached: false,
    warnings: [],
    periods: ctx.periods,
    error,
  };
}

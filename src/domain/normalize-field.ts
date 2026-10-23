/**
 * Normalisation of CrUX records into the shared response format.
 * Ratings are applied here (field data only); nothing is invented: no
 * deltas, no sample counts, and missing values stay null.
 */
import { METRIC_NAMES, METRICS, rate, toNumber, type MetricName } from './metrics.js';
import {
  SCHEMA_VERSION,
  type CruxKey,
  type FieldCurrentResult,
  type FieldMetric,
  type FieldMetrics,
  type ResultContext,
  type Scope,
} from './response.js';
import type { CruxCurrentRecord, CruxDate, CruxFormFactor, CruxRawMetric } from '../providers/crux.js';

/** CrUX dates are Pacific-time calendar dates; format them directly, never via Date/UTC. */
export function formatCruxDate(d: CruxDate): string {
  return `${String(d.year).padStart(4, '0')}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}

function normalizeMetric(name: MetricName, raw: CruxRawMetric): FieldMetric {
  const def = METRICS[name];
  const p75 = toNumber(raw.p75);
  const histogram = raw.histogram.flatMap((bin) => {
    const start = toNumber(bin.start);
    if (start === null) return [];
    return [{ start, end: toNumber(bin.end), density: bin.density }];
  });
  return {
    p75,
    unit: def.unit,
    rating: rate(name, p75),
    histogram,
    group: def.group,
    provenance: { source: 'crux', cruxMetric: raw.cruxName },
  };
}

/** What perfkit asked CrUX for, raw (for comparison) and with a redactor for output. */
export interface CruxRequestContext extends ResultContext {
  scope: Scope;
  /** The raw URL or origin sent upstream. */
  target: string;
  formFactor?: CruxFormFactor;
  /** Makes a URL safe for output (redacts sensitive parts). */
  redact: (url: string) => string;
}

const FORM_FACTORS: readonly string[] = ['PHONE', 'DESKTOP', 'TABLET'] satisfies CruxFormFactor[];

function keyFor(
  scope: Scope,
  target: string | undefined,
  formFactor: string | undefined,
  redact: (u: string) => string,
): CruxKey {
  const key: CruxKey = {};
  if (target !== undefined) key[scope] = scope === 'url' ? redact(target) : target;
  if (formFactor !== undefined && FORM_FACTORS.includes(formFactor)) key.formFactor = formFactor as CruxFormFactor;
  return key;
}

/** The key perfkit requested, in output form. */
export function requestedCruxKey(ctx: CruxRequestContext): CruxKey {
  return keyFor(ctx.scope, ctx.target, ctx.formFactor, ctx.redact);
}

/** The key CrUX returned, in output form, plus a warning when its target differs from the requested one. */
function returnedCruxKey(record: CruxCurrentRecord, ctx: CruxRequestContext): { key: CruxKey; warnings: string[] } {
  const returnedScope: Scope = record.key.origin !== undefined && record.key.url === undefined ? 'origin' : 'url';
  const returnedTarget = record.key[returnedScope];
  const key = keyFor(returnedScope, returnedTarget, record.key.formFactor, ctx.redact);
  const warnings =
    returnedScope === ctx.scope && returnedTarget === ctx.target
      ? []
      : [
          `CrUX returned data for ${returnedScope} "${returnedTarget === undefined ? '(none)' : key[returnedScope]}" ` +
            `rather than the requested ${ctx.scope} "${requestedCruxKey(ctx)[ctx.scope]}" (Google normalised the key). ` +
            `The result is still reported as ${ctx.scope} scope.`,
        ];
  return { key, warnings };
}

/**
 * CrUX publishes no field data for this key: a valid finding, not an error.
 * For URL scope it hints that origin data exists as a separate request; it
 * never fetches it (origin data must never stand in for URL data).
 */
export function noDataCruxCurrent(ctx: CruxRequestContext): FieldCurrentResult {
  const what = ctx.scope === 'url' ? 'this URL' : 'this origin';
  const device = ctx.device === 'ALL' ? 'all devices' : `device ${ctx.device}`;
  const warnings = [`CrUX has no current field data for ${what} on ${device} (too little traffic in the window).`];
  if (ctx.scope === 'url') {
    warnings.push(
      'Origin-level field data may exist: request it separately with scope "origin". It describes the whole site, not this URL.',
    );
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    requestedUrl: ctx.requestedUrl,
    provider: 'crux',
    dataType: 'field_current',
    scope: ctx.scope,
    device: ctx.device,
    status: 'no_data',
    collectedAt: ctx.collectedAt,
    cached: false,
    warnings,
    requestedKey: requestedCruxKey(ctx),
    metrics: {},
    omittedMetrics: [...METRIC_NAMES],
  };
}

export function normalizeCruxCurrent(record: CruxCurrentRecord, ctx: CruxRequestContext): FieldCurrentResult {
  const metrics: FieldMetrics = {};
  const omittedMetrics: MetricName[] = [];
  for (const name of METRIC_NAMES) {
    const raw = record.metrics[name];
    if (raw) metrics[name] = normalizeMetric(name, raw);
    else omittedMetrics.push(name);
  }
  const returned = returnedCruxKey(record, ctx);
  return {
    schemaVersion: SCHEMA_VERSION,
    requestedUrl: ctx.requestedUrl,
    provider: 'crux',
    dataType: 'field_current',
    scope: ctx.scope,
    device: ctx.device,
    status: 'ok',
    collectedAt: ctx.collectedAt,
    cached: false,
    warnings: returned.warnings,
    requestedKey: requestedCruxKey(ctx),
    returnedKey: returned.key,
    collectionPeriod: {
      start: formatCruxDate(record.collectionPeriod.firstDate),
      end: formatCruxDate(record.collectionPeriod.lastDate),
    },
    metrics,
    omittedMetrics,
  };
}

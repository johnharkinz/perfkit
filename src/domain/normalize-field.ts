/**
 * Normalisation of CrUX records into the shared response format.
 * Ratings are applied here (field data only); nothing is invented: no
 * deltas, no sample counts, and missing values stay null.
 */
import { METRIC_NAMES, METRICS, rate, toNumber, type MetricName } from './metrics.js';
import {
  SCHEMA_VERSION,
  type FieldCurrentResult,
  type FieldMetric,
  type FieldMetrics,
  type ResultContext,
  type Scope,
} from './response.js';
import type { CruxCurrentRecord, CruxDate, CruxRawMetric } from '../providers/crux.js';

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

export function normalizeCruxCurrent(
  record: CruxCurrentRecord,
  ctx: ResultContext & { scope: Scope },
): FieldCurrentResult {
  const metrics: FieldMetrics = {};
  for (const name of METRIC_NAMES) {
    const raw = record.metrics[name];
    if (raw) metrics[name] = normalizeMetric(name, raw);
  }
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
    warnings: [],
    collectionPeriod: {
      start: formatCruxDate(record.collectionPeriod.firstDate),
      end: formatCruxDate(record.collectionPeriod.lastDate),
    },
    metrics,
  };
}

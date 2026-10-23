/**
 * Metrics domain: the single source of field metric definitions.
 *
 * Canonical names, the CrUX API names (and tolerated aliases), units, the
 * Core Web Vitals vs. supporting split, and Google's rating thresholds all
 * live here. Nothing else in perfkit should hard-code any of them.
 */

export const METRIC_NAMES = ['INP', 'LCP', 'CLS', 'FCP', 'TTFB'] as const;
export type MetricName = (typeof METRIC_NAMES)[number];

export type MetricUnit = 'ms' | 'unitless';
export type MetricGroup = 'core_web_vital' | 'supporting';
export type Rating = 'good' | 'needs_improvement' | 'poor';

export interface MetricDefinition {
  readonly name: MetricName;
  /** Name to send in CrUX requests. */
  readonly cruxName: string;
  /** Other names tolerated when reading CrUX responses (renames, pre-GA names). */
  readonly cruxAliases: readonly string[];
  readonly unit: MetricUnit;
  readonly group: MetricGroup;
  /** p75 <= good is good; p75 > poor is poor; anything between is needs_improvement. */
  readonly thresholds: { readonly good: number; readonly poor: number };
}

export const METRICS: Readonly<Record<MetricName, MetricDefinition>> = {
  INP: {
    name: 'INP',
    cruxName: 'interaction_to_next_paint',
    cruxAliases: ['experimental_interaction_to_next_paint'],
    unit: 'ms',
    group: 'core_web_vital',
    thresholds: { good: 200, poor: 500 },
  },
  LCP: {
    name: 'LCP',
    cruxName: 'largest_contentful_paint',
    cruxAliases: [],
    unit: 'ms',
    group: 'core_web_vital',
    thresholds: { good: 2500, poor: 4000 },
  },
  CLS: {
    name: 'CLS',
    cruxName: 'cumulative_layout_shift',
    cruxAliases: [],
    unit: 'unitless',
    group: 'core_web_vital',
    thresholds: { good: 0.1, poor: 0.25 },
  },
  FCP: {
    name: 'FCP',
    cruxName: 'first_contentful_paint',
    cruxAliases: [],
    unit: 'ms',
    group: 'supporting',
    thresholds: { good: 1800, poor: 3000 },
  },
  TTFB: {
    name: 'TTFB',
    cruxName: 'experimental_time_to_first_byte',
    cruxAliases: ['time_to_first_byte'],
    unit: 'ms',
    group: 'supporting',
    thresholds: { good: 800, poor: 1800 },
  },
};

/** The CrUX metric names perfkit sends in requests (canonical names only). */
export const CRUX_REQUEST_METRICS: readonly string[] = METRIC_NAMES.map((m) => METRICS[m].cruxName);

/** Maps a CrUX response metric name (canonical or alias) to perfkit's canonical name. */
export function metricFromCruxName(cruxName: string): MetricName | undefined {
  for (const name of METRIC_NAMES) {
    const def = METRICS[name];
    if (def.cruxName === cruxName || def.cruxAliases.includes(cruxName)) return name;
  }
  return undefined;
}

/**
 * Converts a CrUX numeric value (number, or a numeric string such as CLS's "0.05")
 * to a finite number, or null when there is no usable value ("NaN", null, "").
 */
export function toNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Rates a field p75 against Google's thresholds. Lab data must never be rated. */
export function rate(metric: MetricName, p75: number | string | null | undefined): Rating | null {
  const value = toNumber(p75);
  if (value === null) return null;
  const { good, poor } = METRICS[metric].thresholds;
  if (value <= good) return 'good';
  if (value > poor) return 'poor';
  return 'needs_improvement';
}

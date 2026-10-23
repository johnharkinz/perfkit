/**
 * Normalisation of a PageSpeed Insights record into the lab result format.
 * Lab data is never rated; savings appear only when Lighthouse supplied them.
 */
import type { PagespeedRecord, PsiAudit } from '../providers/pagespeed.js';
import { selectAudits } from './audits.js';
import {
  LAB_METRIC_NAMES,
  SCHEMA_VERSION,
  type LabCategory,
  type LabMetricName,
  type LabMetrics,
  type LabResult,
  type LabStrategy,
  type ResultContext,
} from './response.js';
import { parseTarget, redactUrl, type Target } from '../security/target.js';

export interface LabContext extends ResultContext {
  /** The validated target, compared with the URL PSI finally tested. */
  target: Target;
  strategy: LabStrategy;
  categories: readonly LabCategory[];
}

/** Lighthouse metric audits (group "metrics"), by perfkit lab metric name. */
export const LAB_METRIC_AUDITS: Record<LabMetricName, { auditId: string; unit: 'ms' | 'unitless' }> = {
  FCP: { auditId: 'first-contentful-paint', unit: 'ms' },
  LCP: { auditId: 'largest-contentful-paint', unit: 'ms' },
  CLS: { auditId: 'cumulative-layout-shift', unit: 'unitless' },
  TBT: { auditId: 'total-blocking-time', unit: 'ms' },
  SI: { auditId: 'speed-index', unit: 'ms' },
};

const MAX_RUN_WARNING = 400;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function dropUndefined<T extends Record<string, unknown>>(obj: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

/**
 * Lighthouse warnings quote URLs inside prose ("(https://a/?token=x) was redirected to https://b/."). Redact
 * each URL on its own so `redactUrl` does not swallow the surrounding punctuation along with a parameter value.
 */
function redactUrlsInText(text: string): string {
  return text.replace(/https?:\/\/[^\s)"'<>]+/gi, (match) => {
    const [, url = match, tail = ''] = /^(.*?)([.,;:!?]*)$/.exec(match) ?? [];
    return `${redactUrl(url)}${tail}`;
  });
}

function toScore100(score: number | null | undefined): number | null {
  return typeof score === 'number' ? Math.round(score * 100) : null;
}

function labMetrics(audits: Record<string, PsiAudit>): LabMetrics {
  const out: LabMetrics = {};
  for (const name of LAB_METRIC_NAMES) {
    const { auditId, unit } = LAB_METRIC_AUDITS[name];
    const audit = audits[auditId];
    if (!audit) continue;
    out[name] = {
      value: audit.numericValue ?? null,
      unit,
      score: audit.score ?? null,
      displayValue: audit.displayValue ?? null,
      auditId,
    };
  }
  return out;
}

function categoryScores(
  categories: PagespeedRecord['lighthouse']['categories'],
  requested: readonly LabCategory[],
): LabResult['categoryScores'] {
  const extra = requested.filter((c): c is Exclude<LabCategory, 'performance'> => c !== 'performance');
  if (extra.length === 0) return undefined;
  return Object.fromEntries(extra.map((c) => [c, toScore100(categories[c]?.score)]));
}

/** `url` as parseTarget normalises a requested URL (fragment dropped, etc.), so it compares with `target.url`. */
function normalizedLikeTarget(url: string): string {
  const parsed = parseTarget(url);
  return parsed.ok ? parsed.target.url : url;
}

export function normalizePagespeed(record: PagespeedRecord, ctx: LabContext): LabResult {
  const lh = record.lighthouse;
  const warnings: string[] = [];
  const shownFinal = lh.finalDisplayedUrl ?? lh.mainDocumentUrl ?? lh.finalUrl;
  const testedFinal = lh.mainDocumentUrl ?? shownFinal;
  const finalUrl = shownFinal === undefined ? undefined : redactUrl(shownFinal);
  if (testedFinal !== undefined && normalizedLikeTarget(testedFinal) !== ctx.target.url) {
    warnings.push(
      `PageSpeed Insights tested ${redactUrl(testedFinal)}, not the requested ${ctx.target.display} ` +
        '(redirect); this lab data describes the final URL.',
    );
  }
  const scores = categoryScores(lh.categories, ctx.categories);
  return {
    schemaVersion: SCHEMA_VERSION,
    requestedUrl: ctx.requestedUrl,
    provider: 'pagespeed',
    dataType: 'lab',
    device: ctx.device,
    strategy: ctx.strategy,
    status: 'ok',
    collectedAt: ctx.collectedAt,
    cached: false,
    warnings,
    performanceScore: toScore100(lh.categories['performance']?.score),
    labMetrics: labMetrics(lh.audits),
    audits: selectAudits(lh.audits, lh.categories['performance']?.auditRefs ?? []),
    ...(scores ? { categoryScores: scores } : {}),
    ...(finalUrl === undefined ? {} : { finalUrl }),
    lighthouseVersion: lh.lighthouseVersion,
    run: {
      ...dropUndefined({
        fetchTime: lh.fetchTime,
        analysisUTCTimestamp: record.analysisUTCTimestamp,
        formFactor: lh.configSettings?.formFactor,
        locale: lh.configSettings?.locale,
        userAgent: lh.userAgent,
        networkUserAgent: lh.environment?.networkUserAgent,
        benchmarkIndex: lh.environment?.benchmarkIndex,
        totalTimeMs: lh.timing?.total,
      }),
      runWarnings: lh.runWarnings.map((w) => truncate(redactUrlsInText(w), MAX_RUN_WARNING)),
    },
  };
}

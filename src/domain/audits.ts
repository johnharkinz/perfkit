/**
 * Lighthouse audit selection for lab results.
 *
 * Candidates are performance-category audits that are failing (numeric score
 * below 0.9, excluding notApplicable/manual/error modes), excluding the
 * metric audits and the hidden group. They are ranked by estimated time
 * savings, then byte savings, then audit weight, and capped at MAX_AUDITS.
 * The LCP element and layout-shift elements audits are always included when
 * present (Lighthouse 13 ids first, legacy ids as fallbacks), taking reserved
 * slots within the cap.
 *
 * Savings are reported only as Lighthouse supplied them: `ms`/`bytes` from an
 * opportunity's `overallSavings*` or an insight's `numericValue` (insights
 * express their estimate that way), and `metrics` from `metricSavings`. A
 * diagnostic's `numericValue` is a measurement, not a saving.
 */
import type { PsiAudit, PsiAuditRef } from '../providers/pagespeed.js';
import type { Audit } from './response.js';

export const MAX_AUDITS = 10;
const PASSING_SCORE = 0.9;
const MAX_DESCRIPTION = 200;
const MAX_ELEMENTS = 5;
const MAX_SNIPPET = 200;

/** Always-included audits; the first id present in each group wins. */
const PINNED_AUDITS: readonly (readonly string[])[] = [
  ['lcp-breakdown-insight', 'lcp-phases-insight', 'largest-contentful-paint-element'],
  ['cls-culprits-insight', 'layout-shift-elements', 'layout-shifts'],
];

/** Metric audits are reported as lab metrics, never as failing audits. */
const METRIC_AUDIT_IDS = new Set([
  'first-contentful-paint',
  'largest-contentful-paint',
  'cumulative-layout-shift',
  'total-blocking-time',
  'speed-index',
  'interactive',
  'max-potential-fid',
]);
const EXCLUDED_GROUPS = new Set(['metrics', 'hidden']);
const NOT_FAILING_MODES = new Set(['notApplicable', 'manual', 'error']);

type Savings = NonNullable<Audit['savings']>;

function savingsOf(audit: PsiAudit): Savings | undefined {
  const insight = audit.id.endsWith('-insight') && audit.scoreDisplayMode === 'metricSavings';
  const fromValue = (unit: string) => (insight && audit.numericUnit === unit ? audit.numericValue : undefined);
  const ms = audit.details?.overallSavingsMs ?? fromValue('millisecond');
  const bytes = audit.details?.overallSavingsBytes ?? fromValue('byte');
  const metrics = audit.metricSavings && Object.keys(audit.metricSavings).length > 0 ? audit.metricSavings : undefined;
  if (ms === undefined && bytes === undefined && metrics === undefined) return undefined;
  return {
    ...(ms === undefined ? {} : { ms }),
    ...(bytes === undefined ? {} : { bytes }),
    ...(metrics === undefined ? {} : { metrics }),
  };
}

/** Time savings used for ranking: the overall estimate, else the largest per-metric time estimate. */
function rankingMs(s: Savings | undefined): number {
  if (s?.ms !== undefined) return s.ms;
  const times = Object.entries(s?.metrics ?? {})
    .filter(([metric]) => metric !== 'CLS')
    .map(([, v]) => v);
  return times.length > 0 ? Math.max(...times) : -1;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

function toElement(node: Rec, score: unknown): NonNullable<Audit['elements']>[number] {
  const selector = str(node['selector']);
  const nodeLabel = str(node['nodeLabel']);
  const snippet = str(node['snippet']);
  return {
    ...(selector === undefined ? {} : { selector }),
    ...(nodeLabel === undefined ? {} : { nodeLabel }),
    ...(snippet === undefined ? {} : { snippet: truncate(snippet, MAX_SNIPPET) }),
    ...(typeof score === 'number' ? { score } : {}),
  };
}

/** Collects page elements (Lighthouse "node" values) from an audit's details, walking nested tables/lists. */
function elementsOf(audit: PsiAudit): Audit['elements'] {
  const found: NonNullable<Audit['elements']> = [];
  const walk = (items: unknown): void => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (found.length >= MAX_ELEMENTS || !isRec(item)) continue;
      if (item['type'] === 'node') found.push(toElement(item, undefined));
      else if (isRec(item['node']) && item['node']['type'] === 'node')
        found.push(toElement(item['node'], item['score']));
      else walk(item['items']);
    }
  };
  walk(audit.details?.items);
  return found.length > 0 ? found : undefined;
}

function toAudit(audit: PsiAudit, withElements: boolean): Audit {
  const savings = savingsOf(audit);
  const elements = withElements ? elementsOf(audit) : undefined;
  return {
    id: audit.id,
    title: audit.title,
    description: truncate(audit.description, MAX_DESCRIPTION),
    displayValue: audit.displayValue ?? null,
    score: audit.score ?? null,
    ...(savings ? { savings } : {}),
    ...(elements ? { elements } : {}),
  };
}

function isFailing(audit: PsiAudit): boolean {
  if (audit.scoreDisplayMode !== undefined && NOT_FAILING_MODES.has(audit.scoreDisplayMode)) return false;
  return typeof audit.score === 'number' && audit.score < PASSING_SCORE;
}

export function selectAudits(audits: Record<string, PsiAudit>, performanceRefs: readonly PsiAuditRef[]): Audit[] {
  const pinned = PINNED_AUDITS.flatMap((ids) => {
    const id = ids.find((candidate) => audits[candidate]);
    return id ? [id] : [];
  });
  const pinnedSet = new Set(pinned);

  const seen = new Set<string>();
  const ranked = performanceRefs
    .flatMap((ref) => {
      const audit = audits[ref.id];
      if (!audit || seen.has(ref.id)) return [];
      seen.add(ref.id);
      if (METRIC_AUDIT_IDS.has(ref.id) || (ref.group && EXCLUDED_GROUPS.has(ref.group)) || !isFailing(audit)) {
        return [];
      }
      const savings = savingsOf(audit);
      return [{ audit, weight: ref.weight, ms: rankingMs(savings), bytes: savings?.bytes ?? -1 }];
    })
    .sort((a, b) => b.ms - a.ms || b.bytes - a.bytes || b.weight - a.weight);

  const selected: PsiAudit[] = [];
  const pendingPinned = new Set(pinned);
  for (const { audit } of ranked) {
    const isPinned = pendingPinned.has(audit.id);
    if (!isPinned && selected.length + pendingPinned.size >= MAX_AUDITS) continue;
    selected.push(audit);
    pendingPinned.delete(audit.id);
  }
  for (const id of pinned) {
    const audit = audits[id];
    if (audit && pendingPinned.has(id)) selected.push(audit);
  }
  return selected.map((audit) => toAudit(audit, pinnedSet.has(audit.id)));
}

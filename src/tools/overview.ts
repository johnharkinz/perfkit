/**
 * performance_overview: lab data plus URL and origin field data (current and,
 * by default, history) in one call.
 *
 * The URL is validated once; then every section runs in parallel through the
 * same core functions (and so the same shared cache) as the narrow tools.
 * Each section is a complete standard result with its own status: one failing
 * source never hides the others. An overall time budget bounds the call; a
 * section still running when it expires becomes upstream_timeout.
 */
import * as z from 'zod';
import { toErrorInfo, type ErrorInfo } from '../domain/errors.js';
import {
  errorFieldCurrentResult,
  errorFieldHistoryResult,
  errorLabResult,
  OverviewResultSchema,
  overviewStatus,
  SCHEMA_VERSION,
  type OverviewResult,
  type Scope,
  type Status,
} from '../domain/response.js';
import { displayForInvalid } from '../security/target.js';
import { cruxCurrentFor } from './crux-current.js';
import { cruxHistoryFor, MAX_HISTORY_PERIODS } from './crux-history.js';
import { pagespeedFor } from './pagespeed.js';
import type { ToolContext, ToolDefinition } from './tool.js';

const InputSchema = z.object({
  url: z.string().describe('Public http(s) URL to report on, e.g. "https://example.com/page".'),
  device: z
    .enum(['PHONE', 'DESKTOP'])
    .default('PHONE')
    .describe('PHONE (PSI "mobile", CrUX PHONE) or DESKTOP (PSI "desktop", CrUX DESKTOP).'),
  includeHistory: z
    .boolean()
    .default(true)
    .describe('Also fetch up to 40 weeks of field history for the URL and its origin.'),
});
type Input = z.infer<typeof InputSchema>;

const STRATEGY = { PHONE: 'mobile', DESKTOP: 'desktop' } as const;

export const overviewTool: ToolDefinition<typeof InputSchema, typeof OverviewResultSchema> = {
  name: 'performance_overview',
  title: 'Performance overview (lab and field)',
  description:
    'All the evidence for a URL in one call: lab data from one PageSpeed Insights run (section "lab"), and ' +
    'Chrome UX Report field data for the exact URL and for its whole origin, current and (unless includeHistory ' +
    'is false) up to 40 weeks of history (sections field.url.current, field.url.history, field.origin.current, ' +
    'field.origin.history). Lab and field data, and URL and origin scopes, are kept separate; nothing is merged ' +
    'or substituted. Each section has its own status: "no_data" is a valid finding, not a failure. The overall ' +
    'status is "ok" when no section failed, "partial" when some failed, "error" when all failed. If PageSpeed ' +
    'Insights is too slow, the lab section times out and field data is still returned.',
  inputSchema: InputSchema,
  outputSchema: OverviewResultSchema,

  async run(args: Input, ctx): Promise<OverviewResult> {
    const parsed = await ctx.deps.targets.validate(args.url);
    if (!parsed.ok) return rejected(args, parsed.error.toInfo(), ctx);
    const { target } = parsed;

    const budgetMs = ctx.deps.config.overviewBudgetMs;
    const budget = AbortSignal.timeout(budgetMs);
    const sectionCtx: ToolContext = { ...ctx, signal: ctx.signal ? AbortSignal.any([ctx.signal, budget]) : budget };
    const collectedAt = ctx.startedAt.toISOString();
    const device = args.device;
    const requestedUrl = target.display;

    const section = async <T extends { status: Status }>(
      name: string,
      load: () => Promise<T>,
      onError: (error: ErrorInfo) => T,
    ): Promise<T> => {
      try {
        return await load();
      } catch (err) {
        const info = withBudgetMessage(toErrorInfo(err), budget.aborted, budgetMs);
        ctx.logger.warn('overview section failed', { section: name, code: info.code, source: info.source });
        return onError(info);
      }
    };
    const current = (scope: Scope) =>
      section(
        `field.${scope}.current`,
        () => cruxCurrentFor(target, { scope, device }, sectionCtx),
        (error) => errorFieldCurrentResult({ requestedUrl, device, collectedAt, scope }, error),
      );
    const history = (scope: Scope) =>
      args.includeHistory
        ? section(
            `field.${scope}.history`,
            () => cruxHistoryFor(target, { scope, device, periods: MAX_HISTORY_PERIODS }, sectionCtx),
            (error) =>
              errorFieldHistoryResult(
                { requestedUrl, device, collectedAt, scope, periods: MAX_HISTORY_PERIODS },
                error,
              ),
          )
        : Promise.resolve(undefined);

    const [lab, urlCurrent, originCurrent, urlHistory, originHistory] = await Promise.all([
      section(
        'lab',
        () => pagespeedFor(target, { device, categories: ['performance'] }, sectionCtx),
        (error) => errorLabResult({ requestedUrl, device, strategy: STRATEGY[device], collectedAt }, error),
      ),
      current('url'),
      current('origin'),
      history('url'),
      history('origin'),
    ]);

    const sections = [lab, urlCurrent, originCurrent, urlHistory, originHistory].filter((s) => s !== undefined);
    return {
      schemaVersion: SCHEMA_VERSION,
      requestedUrl,
      device,
      status: overviewStatus(sections.map((s) => s.status)),
      collectedAt,
      includeHistory: args.includeHistory,
      warnings: [],
      lab,
      field: {
        url: { current: urlCurrent, ...(urlHistory ? { history: urlHistory } : {}) },
        origin: { current: originCurrent, ...(originHistory ? { history: originHistory } : {}) },
      },
    };
  },

  errorResult(args, error, ctx) {
    return rejected(args, error, ctx);
  },
};

/** The overview envelope when nothing could be fetched at all (e.g. invalid input). */
function rejected(args: Input, error: ErrorInfo, ctx: ToolContext): OverviewResult {
  return {
    schemaVersion: SCHEMA_VERSION,
    requestedUrl: displayForInvalid(args.url),
    device: args.device,
    status: 'error',
    collectedAt: ctx.startedAt.toISOString(),
    includeHistory: args.includeHistory,
    warnings: [],
    error,
  };
}

/** A timeout caused by the overview budget says so, and points to the narrow tool, which has no budget. */
function withBudgetMessage(info: ErrorInfo, budgetExpired: boolean, budgetMs: number): ErrorInfo {
  if (!budgetExpired || info.code !== 'upstream_timeout') return info;
  const label = info.source === 'pagespeed' ? 'PageSpeed Insights' : 'The CrUX API';
  const tool =
    info.source === 'pagespeed' ? 'performance_pagespeed' : 'performance_crux_current or performance_crux_history';
  return {
    ...info,
    message: `${label} did not finish within the overview's ${formatSeconds(budgetMs)} time budget. Call ${tool} on its own to wait longer.`,
  };
}

function formatSeconds(ms: number): string {
  return `${Math.round(ms / 100) / 10} s`;
}

/**
 * performance_crux_history: field history from the CrUX History API.
 *
 * Scope, device and no_data behave exactly as in performance_crux_current
 * (one upstream call, no origin fallback). `periods` 1–40 (default 40) is
 * checked here so out-of-range values get perfkit's invalid_input envelope.
 * Each metric is an ordered series of {start, end, p75, rating}; gaps stay
 * null and nothing is compared across points.
 */
import * as z from 'zod';
import type { ErrorInfo } from '../domain/errors.js';
import { noDataCruxHistory, normalizeCruxHistory } from '../domain/normalize-field.js';
import { errorFieldHistoryResult, FieldHistoryResultSchema, type FieldHistoryResult } from '../domain/response.js';
import { withCacheFields } from '../infra/cache.js';
import type { Target } from '../security/target.js';
import { cruxCacheKey, cruxInputShape, cruxQuery, cruxRequestFor } from './crux-request.js';
import { inputResultContext, type ToolContext, type ToolDefinition } from './tool.js';

export const MAX_HISTORY_PERIODS = 40;

const InputSchema = z.object({
  ...cruxInputShape,
  periods: z
    .number()
    .default(MAX_HISTORY_PERIODS)
    .describe('How many weekly windows to return, 1–40 (most recent last).'),
});
type Input = z.infer<typeof InputSchema>;

function errorResult(args: Input, error: ErrorInfo, ctx: ToolContext): FieldHistoryResult {
  return errorFieldHistoryResult({ ...inputResultContext(args, ctx), scope: args.scope, periods: args.periods }, error);
}

export const cruxHistoryTool: ToolDefinition<typeof InputSchema, typeof FieldHistoryResultSchema> = {
  name: 'performance_crux_history',
  title: 'CrUX field history',
  description:
    'Field history from the Chrome UX Report for a URL (scope "url") or its whole origin (scope "origin"): up to ' +
    '40 rated p75 points of INP, LCP, CLS (Core Web Vitals), FCP and TTFB (supporting), with real dates. Points ' +
    'are overlapping 28-day windows updated weekly, not independent samples; missing weeks are null, never zero. ' +
    'status "no_data" (too little traffic) is a valid finding. This is field data, not lab data; for one ' +
    'simulated Lighthouse run use performance_pagespeed. For the latest window with histograms use ' +
    'performance_crux_current.',
  inputSchema: InputSchema,
  outputSchema: FieldHistoryResultSchema,

  async run(args: Input, ctx): Promise<FieldHistoryResult> {
    // Checked before the URL so a bad periods value never triggers the optional DNS check.
    if (!Number.isInteger(args.periods) || args.periods < 1 || args.periods > MAX_HISTORY_PERIODS) {
      return errorResult(
        args,
        {
          code: 'invalid_input',
          source: 'perfkit',
          retryable: false,
          message: `periods must be a whole number from 1 to ${MAX_HISTORY_PERIODS}.`,
        },
        ctx,
      );
    }
    const parsed = await ctx.deps.targets.validate(args.url);
    if (!parsed.ok) return errorResult(args, parsed.error.toInfo(), ctx);
    return cruxHistoryFor(parsed.target, args, ctx);
  },

  errorResult,
};

/**
 * The core of performance_crux_history for an already validated target and
 * checked `periods`, shared with performance_overview. Returns ok/no_data;
 * throws PerfkitError on upstream failure.
 */
export async function cruxHistoryFor(
  target: Target,
  args: Pick<Input, 'scope' | 'device' | 'periods'>,
  ctx: ToolContext,
): Promise<FieldHistoryResult> {
  const request = { ...cruxRequestFor(target, args, ctx), periods: args.periods };
  const lookup = await ctx.deps.cache.getOrLoad({
    kind: 'cruxHistory',
    key: { ...cruxCacheKey(request), periods: args.periods },
    // no_data uses the current-field-data lifetime: coverage can appear sooner than a week.
    lifetime: (outcome) => (outcome.kind === 'no_data' ? 'cruxCurrent' : 'cruxHistory'),
    logger: ctx.logger,
    load: () => ctx.deps.crux.queryHistory({ ...cruxQuery(request, ctx), periods: args.periods }),
  });
  const outcome = lookup.value;
  if (outcome.kind === 'no_data') return withCacheFields(noDataCruxHistory(request), lookup);
  return withCacheFields(normalizeCruxHistory(outcome.record, request), lookup);
}

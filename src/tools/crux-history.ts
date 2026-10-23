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
import { CRUX_REQUEST_METRICS } from '../domain/metrics.js';
import { noDataCruxHistory, normalizeCruxHistory } from '../domain/normalize-field.js';
import { errorFieldHistoryResult, FieldHistoryResultSchema, type FieldHistoryResult } from '../domain/response.js';
import { withCacheFields } from '../infra/cache.js';
import { displayForInvalid, redactUrl, type Target } from '../security/target.js';
import type { ToolContext, ToolDefinition } from './tool.js';

export const MAX_HISTORY_PERIODS = 40;

const InputSchema = z.object({
  url: z.string().describe('Public http(s) URL to look up, e.g. "https://example.com/page".'),
  scope: z
    .enum(['url', 'origin'])
    .default('url')
    .describe(
      'url: this exact page. origin: the whole site at scheme plus host of url (www. and bare hosts differ). ' +
        'perfkit never falls back from url to origin on its own.',
    ),
  device: z
    .enum(['PHONE', 'DESKTOP', 'TABLET', 'ALL'])
    .default('PHONE')
    .describe('Device class of the Chrome users to report on; ALL combines every device.'),
  periods: z
    .number()
    .default(MAX_HISTORY_PERIODS)
    .describe('How many weekly windows to return, 1–40 (most recent last).'),
});
type Input = z.infer<typeof InputSchema>;

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
    const base = {
      device: args.device,
      collectedAt: ctx.startedAt.toISOString(),
      scope: args.scope,
      periods: args.periods,
    };
    // Checked before the URL so a bad periods value never triggers the optional DNS check.
    if (!Number.isInteger(args.periods) || args.periods < 1 || args.periods > MAX_HISTORY_PERIODS) {
      return errorFieldHistoryResult(
        { ...base, requestedUrl: displayForInvalid(args.url) },
        {
          code: 'invalid_input',
          source: 'perfkit',
          retryable: false,
          message: `periods must be a whole number from 1 to ${MAX_HISTORY_PERIODS}.`,
        },
      );
    }
    const parsed = await ctx.deps.targets.validate(args.url);
    if (!parsed.ok) {
      return errorFieldHistoryResult({ ...base, requestedUrl: displayForInvalid(args.url) }, parsed.error.toInfo());
    }
    return cruxHistoryFor(parsed.target, args, ctx);
  },

  errorResult(args: Input, error, ctx) {
    return errorFieldHistoryResult(
      {
        requestedUrl: displayForInvalid(args.url),
        device: args.device,
        collectedAt: ctx.startedAt.toISOString(),
        scope: args.scope,
        periods: args.periods,
      },
      error,
    );
  },
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
  const base = {
    device: args.device,
    collectedAt: ctx.startedAt.toISOString(),
    scope: args.scope,
    periods: args.periods,
  };
  const request = {
    ...base,
    requestedUrl: target.display,
    target: args.scope === 'origin' ? target.origin : target.url,
    formFactor: args.device === 'ALL' ? undefined : args.device,
    redact: redactUrl,
  };
  const lookup = await ctx.deps.cache.getOrLoad({
    kind: 'cruxHistory',
    key: {
      provider: 'crux',
      target: request.target,
      scope: request.scope,
      device: args.device,
      metrics: CRUX_REQUEST_METRICS,
      periods: args.periods,
    },
    // no_data uses the current-field-data lifetime: coverage can appear sooner than a week.
    lifetime: (outcome) => (outcome.kind === 'no_data' ? 'cruxCurrent' : 'cruxHistory'),
    logger: ctx.logger,
    load: () =>
      ctx.deps.crux.queryHistory({
        scope: request.scope,
        target: request.target,
        formFactor: request.formFactor,
        periods: args.periods,
        signal: ctx.signal,
        logger: ctx.logger,
      }),
  });
  const outcome = lookup.value;
  if (outcome.kind === 'no_data') return withCacheFields(noDataCruxHistory(request), lookup);
  return withCacheFields(normalizeCruxHistory(outcome.record, request), lookup);
}

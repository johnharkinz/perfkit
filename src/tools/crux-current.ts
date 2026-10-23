/**
 * performance_crux_current: current field data from the CrUX API.
 *
 * Scope url|origin (origin = scheme plus host from parseTarget), devices
 * PHONE/DESKTOP/TABLET/ALL (ALL sends no form factor), 404 → no_data with an
 * origin hint, `requestedKey`/`returnedKey` + mismatch warning, and
 * `omittedMetrics`. Exactly one upstream call per invocation: never an
 * automatic origin fallback.
 */
import * as z from 'zod';
import type { ErrorInfo } from '../domain/errors.js';
import { noDataCruxCurrent, normalizeCruxCurrent } from '../domain/normalize-field.js';
import { errorFieldCurrentResult, FieldCurrentResultSchema, type FieldCurrentResult } from '../domain/response.js';
import { withCacheFields } from '../infra/cache.js';
import type { Target } from '../security/target.js';
import { cruxCacheKey, cruxInputShape, cruxQuery, cruxRequestFor } from './crux-request.js';
import { inputResultContext, type ToolContext, type ToolDefinition } from './tool.js';

const InputSchema = z.object(cruxInputShape);
type Input = z.infer<typeof InputSchema>;

function errorResult(args: Input, error: ErrorInfo, ctx: ToolContext): FieldCurrentResult {
  return errorFieldCurrentResult({ ...inputResultContext(args, ctx), scope: args.scope }, error);
}

export const cruxCurrentTool: ToolDefinition<typeof InputSchema, typeof FieldCurrentResultSchema> = {
  name: 'performance_crux_current',
  title: 'CrUX current field data',
  description:
    'Current field data from the Chrome UX Report: how real Chrome users experienced a URL (scope "url") or its ' +
    'whole origin (scope "origin") over the latest 28-day window. Returns p75 INP, LCP, CLS (Core Web Vitals), ' +
    'FCP and TTFB (supporting), each rated, with histograms and dates. status "no_data" (too little traffic) is a ' +
    'valid finding. This is field data, not lab data; for one simulated Lighthouse run use performance_pagespeed.',
  inputSchema: InputSchema,
  outputSchema: FieldCurrentResultSchema,

  async run(args: Input, ctx): Promise<FieldCurrentResult> {
    const parsed = await ctx.deps.targets.validate(args.url);
    if (!parsed.ok) return errorResult(args, parsed.error.toInfo(), ctx);
    return cruxCurrentFor(parsed.target, args, ctx);
  },

  errorResult,
};

/**
 * The core of performance_crux_current for an already validated target, shared
 * with performance_overview. Returns ok/no_data; throws PerfkitError on upstream failure.
 */
export async function cruxCurrentFor(
  target: Target,
  args: Pick<Input, 'scope' | 'device'>,
  ctx: ToolContext,
): Promise<FieldCurrentResult> {
  const request = cruxRequestFor(target, args, ctx);
  const lookup = await ctx.deps.cache.getOrLoad({
    kind: 'cruxCurrent',
    key: cruxCacheKey(request),
    logger: ctx.logger,
    load: () => ctx.deps.crux.queryCurrent(cruxQuery(request, ctx)),
  });
  const outcome = lookup.value;
  // Exactly one upstream call: no_data is reported as is, never retried at origin scope.
  if (outcome.kind === 'no_data') return withCacheFields(noDataCruxCurrent(request), lookup);
  return withCacheFields(normalizeCruxCurrent(outcome.record, request), lookup);
}

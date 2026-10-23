/**
 * performance_crux_current: current field data from the CrUX API.
 *
 * #3 extends this tool: `scope` (url|origin) input, TABLET and ALL devices,
 * 404 → no_data with an origin hint, `returnedKey` + mismatch warning, and
 * `omittedMetrics`.
 */
import * as z from 'zod';
import { CRUX_REQUEST_METRICS } from '../domain/metrics.js';
import { normalizeCruxCurrent } from '../domain/normalize-field.js';
import { withCacheFields } from '../infra/cache.js';
import { errorFieldCurrentResult, FieldCurrentResultSchema, type FieldCurrentResult } from '../domain/response.js';
import { displayForInvalid } from '../security/target.js';
import type { ToolDefinition } from './tool.js';

const InputSchema = z.object({
  url: z.string().describe('Public http(s) URL to look up, e.g. "https://example.com/page".'),
  device: z.enum(['PHONE', 'DESKTOP']).default('PHONE').describe('Device class of the Chrome users to report on.'),
});
type Input = z.infer<typeof InputSchema>;

export const cruxCurrentTool: ToolDefinition<typeof InputSchema, typeof FieldCurrentResultSchema> = {
  name: 'performance_crux_current',
  title: 'CrUX current field data',
  description:
    'Current field data for a URL from the Chrome UX Report: how real Chrome users experienced the page over the ' +
    'latest 28-day window. Returns p75 INP, LCP and CLS (Core Web Vitals) plus FCP and TTFB (supporting), each ' +
    'rated good/needs_improvement/poor, with histograms and collection dates. This is field data, not lab data; ' +
    'for a single simulated Lighthouse run use performance_pagespeed.',
  inputSchema: InputSchema,
  outputSchema: FieldCurrentResultSchema,

  async run(args: Input, ctx): Promise<FieldCurrentResult> {
    const base = { device: args.device, collectedAt: ctx.startedAt.toISOString(), scope: 'url' as const };
    const parsed = await ctx.deps.targets.validate(args.url);
    if (!parsed.ok) {
      return errorFieldCurrentResult({ ...base, requestedUrl: displayForInvalid(args.url) }, parsed.error.toInfo());
    }
    const { target } = parsed;
    const lookup = await ctx.deps.cache.getOrLoad({
      kind: 'cruxCurrent',
      key: { provider: 'crux', target: target.url, scope: 'url', device: args.device, metrics: CRUX_REQUEST_METRICS },
      logger: ctx.logger,
      load: () =>
        ctx.deps.crux.queryCurrent({
          scope: 'url',
          target: target.url,
          formFactor: args.device,
          signal: ctx.signal,
          logger: ctx.logger,
        }),
    });
    const outcome = lookup.value;
    return withCacheFields(normalizeCruxCurrent(outcome.record, { ...base, requestedUrl: target.display }), lookup);
  },

  errorResult(args, error, ctx) {
    return errorFieldCurrentResult(
      {
        requestedUrl: displayForInvalid(args.url),
        device: args.device,
        collectedAt: ctx.startedAt.toISOString(),
        scope: 'url',
      },
      error,
    );
  },
};

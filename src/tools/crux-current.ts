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
import { CRUX_REQUEST_METRICS } from '../domain/metrics.js';
import { noDataCruxCurrent, normalizeCruxCurrent } from '../domain/normalize-field.js';
import { withCacheFields } from '../infra/cache.js';
import { errorFieldCurrentResult, FieldCurrentResultSchema, type FieldCurrentResult } from '../domain/response.js';
import { displayForInvalid, redactUrl } from '../security/target.js';
import type { ToolDefinition } from './tool.js';

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
});
type Input = z.infer<typeof InputSchema>;

export const cruxCurrentTool: ToolDefinition<typeof InputSchema, typeof FieldCurrentResultSchema> = {
  name: 'performance_crux_current',
  title: 'CrUX current field data',
  description:
    'Current field data from the Chrome UX Report: how real Chrome users experienced a URL (scope "url") or its ' +
    'whole origin (scope "origin") over the latest 28-day window. Returns p75 INP, LCP, CLS (Core Web Vitals), ' +
    'FCP and TTFB (supporting), each rated, with histograms and dates. status "no_data" means CrUX has too little ' +
    'traffic for the target; it is a valid finding. This is field data, not lab data; for one simulated ' +
    'Lighthouse run use performance_pagespeed.',
  inputSchema: InputSchema,
  outputSchema: FieldCurrentResultSchema,

  async run(args: Input, ctx): Promise<FieldCurrentResult> {
    const base = { device: args.device, collectedAt: ctx.startedAt.toISOString(), scope: args.scope };
    const parsed = await ctx.deps.targets.validate(args.url);
    if (!parsed.ok) {
      return errorFieldCurrentResult({ ...base, requestedUrl: displayForInvalid(args.url) }, parsed.error.toInfo());
    }
    const { target } = parsed;
    const request = {
      ...base,
      requestedUrl: target.display,
      target: args.scope === 'origin' ? target.origin : target.url,
      formFactor: args.device === 'ALL' ? undefined : args.device,
      redact: redactUrl,
    };
    const lookup = await ctx.deps.cache.getOrLoad({
      kind: 'cruxCurrent',
      key: {
        provider: 'crux',
        target: request.target,
        scope: request.scope,
        device: args.device,
        metrics: CRUX_REQUEST_METRICS,
      },
      logger: ctx.logger,
      load: () =>
        ctx.deps.crux.queryCurrent({
          scope: request.scope,
          target: request.target,
          formFactor: request.formFactor,
          signal: ctx.signal,
          logger: ctx.logger,
        }),
    });
    const outcome = lookup.value;
    // Exactly one upstream call: no_data is reported as is, never retried at origin scope.
    if (outcome.kind === 'no_data') return withCacheFields(noDataCruxCurrent(request), lookup);
    return withCacheFields(normalizeCruxCurrent(outcome.record, request), lookup);
  },

  errorResult(args, error, ctx) {
    return errorFieldCurrentResult(
      {
        requestedUrl: displayForInvalid(args.url),
        device: args.device,
        collectedAt: ctx.startedAt.toISOString(),
        scope: args.scope,
      },
      error,
    );
  },
};

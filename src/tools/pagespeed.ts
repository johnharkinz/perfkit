/**
 * performance_pagespeed: lab data from one PageSpeed Insights (Lighthouse) run.
 */
import * as z from 'zod';
import { normalizePagespeed } from '../domain/normalize-lab.js';
import { errorLabResult, LAB_CATEGORIES, LabResultSchema, type LabResult } from '../domain/response.js';
import { withCacheFields } from '../infra/cache.js';
import type { PsiCategory, PsiStrategy } from '../providers/pagespeed.js';
import { displayForInvalid, type Target } from '../security/target.js';
import type { ToolContext, ToolDefinition } from './tool.js';

const InputSchema = z.object({
  url: z.string().describe('Public http(s) URL to test, e.g. "https://example.com/page".'),
  device: z
    .enum(['PHONE', 'DESKTOP'])
    .default('PHONE')
    .describe('Device to emulate: PHONE uses the PSI "mobile" strategy, DESKTOP uses "desktop".'),
  categories: z
    .array(z.enum(LAB_CATEGORIES))
    .min(1)
    .default(['performance'])
    .describe('Lighthouse categories. Performance always runs; accessibility, best-practices and seo add scores only.'),
});
type Input = z.infer<typeof InputSchema>;

const STRATEGY = { PHONE: 'mobile', DESKTOP: 'desktop' } as const;
const PSI_STRATEGY: Record<Input['device'], PsiStrategy> = { PHONE: 'MOBILE', DESKTOP: 'DESKTOP' };
const PSI_CATEGORY: Record<Input['categories'][number], PsiCategory> = {
  performance: 'PERFORMANCE',
  accessibility: 'ACCESSIBILITY',
  'best-practices': 'BEST_PRACTICES',
  seo: 'SEO',
};

export const pagespeedTool: ToolDefinition<typeof InputSchema, typeof LabResultSchema> = {
  name: 'performance_pagespeed',
  title: 'PageSpeed Insights lab data',
  description:
    'Lab data from PageSpeed Insights: a single simulated Lighthouse run of one URL on an emulated phone or ' +
    'desktop, not field data from real Chrome users. URL only: there is no origin option; for field data on a URL ' +
    'or its whole origin use performance_crux_current or performance_crux_history. Returns the 0–100 performance ' +
    'score, unrated lab FCP, LCP, CLS, TBT and Speed Index with Lighthouse’s per-metric scores, and up to 10 failing ' +
    'performance audits (always including the LCP breakdown and layout-shift culprits). TBT is not INP.',
  inputSchema: InputSchema,
  outputSchema: LabResultSchema,

  async run(args: Input, ctx): Promise<LabResult> {
    const base = { device: args.device, strategy: STRATEGY[args.device], collectedAt: ctx.startedAt.toISOString() };
    const parsed = await ctx.deps.targets.validate(args.url);
    if (!parsed.ok) {
      return errorLabResult({ ...base, requestedUrl: displayForInvalid(args.url) }, parsed.error.toInfo());
    }
    return pagespeedFor(parsed.target, args, ctx);
  },

  errorResult(args, error, ctx) {
    return errorLabResult(
      {
        requestedUrl: displayForInvalid(args.url),
        device: args.device,
        strategy: STRATEGY[args.device],
        collectedAt: ctx.startedAt.toISOString(),
      },
      error,
    );
  },
};

/**
 * The core of performance_pagespeed for an already validated target, shared
 * with performance_overview. Throws PerfkitError on every upstream failure.
 */
export async function pagespeedFor(
  target: Target,
  args: Pick<Input, 'device' | 'categories'>,
  ctx: ToolContext,
): Promise<LabResult> {
  const base = { device: args.device, strategy: STRATEGY[args.device], collectedAt: ctx.startedAt.toISOString() };
  // Performance always runs, so ['seo'] and ['performance', 'seo'] are the same PSI request.
  const categories = [...new Set<Input['categories'][number]>(['performance', ...args.categories])];
  // The provider throws on every failure, so errors are never cached.
  const lookup = await ctx.deps.cache.getOrLoad({
    kind: 'pagespeed',
    key: { provider: 'pagespeed', target: target.url, device: args.device, categories },
    logger: ctx.logger,
    load: () =>
      ctx.deps.pagespeed.run({
        url: target.url,
        strategy: PSI_STRATEGY[args.device],
        categories: categories.map((c) => PSI_CATEGORY[c]),
        signal: ctx.signal,
        logger: ctx.logger,
      }),
  });
  return withCacheFields(normalizePagespeed(lookup.value, { ...base, target, categories: args.categories }), lookup);
}

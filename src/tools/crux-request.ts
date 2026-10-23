/**
 * What performance_crux_current and performance_crux_history share: their
 * url/scope/device inputs, and how a validated target becomes a CrUX request
 * (the URL or origin by scope, no form factor for ALL, outputs redacted).
 */
import * as z from 'zod';
import { CRUX_REQUEST_METRICS } from '../domain/metrics.js';
import type { CruxRequestContext } from '../domain/normalize-field.js';
import type { CacheKeyParts } from '../infra/cache.js';
import type { CruxQuery } from '../providers/crux.js';
import { redactUrl, type Target } from '../security/target.js';
import { targetResultContext, type ToolContext } from './tool.js';

/** The url, scope and device inputs of both CrUX tools. */
export const cruxInputShape = {
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
};

export type CruxInput = z.infer<z.ZodObject<typeof cruxInputShape>>;

/** The CrUX request for a validated target: the URL or its origin by scope, and no form factor for ALL. */
export function cruxRequestFor(
  target: Target,
  args: Pick<CruxInput, 'scope' | 'device'>,
  ctx: ToolContext,
): CruxRequestContext {
  return {
    ...targetResultContext(target, args.device, ctx),
    scope: args.scope,
    target: args.scope === 'origin' ? target.origin : target.url,
    formFactor: args.device === 'ALL' ? undefined : args.device,
    redact: redactUrl,
  };
}

/** The cache key of a CrUX request: keyed on the requested device (ALL included), not the form factor. */
export function cruxCacheKey(request: CruxRequestContext): CacheKeyParts {
  return {
    provider: 'crux',
    target: request.target,
    scope: request.scope,
    device: request.device,
    metrics: CRUX_REQUEST_METRICS,
  };
}

/** The provider query for a CrUX request, cancelled with the call. */
export function cruxQuery(request: CruxRequestContext, ctx: ToolContext): CruxQuery {
  return {
    scope: request.scope,
    target: request.target,
    formFactor: request.formFactor,
    signal: ctx.signal,
    logger: ctx.logger,
  };
}

/**
 * Config: parses environment variables into a typed config.
 *
 * Only GOOGLE_API_KEY is required. Later options (timeouts, retries, cache
 * lifetimes, overview budget, PERFKIT_DNS_CHECK) are added to `Config` and
 * parsed here, each with a default. Error messages name variables and never
 * echo their values.
 */
import type { CacheConfig, CacheKind } from './cache.js';

export interface Config {
  readonly googleApiKey: string;
  /** PERFKIT_DNS_CHECK=1: also reject hosts that resolve to non-public addresses (ADR 0001). Off by default. */
  readonly dnsCheck: boolean;
  readonly cache: CacheConfig;
}

/** Cache lifetime defaults (seconds) and their override variables. */
export const CACHE_TTL_DEFAULTS: Readonly<Record<CacheKind, { env: string; seconds: number }>> = {
  pagespeed: { env: 'PERFKIT_CACHE_TTL_PAGESPEED_SECONDS', seconds: 30 * 60 },
  cruxCurrent: { env: 'PERFKIT_CACHE_TTL_CRUX_CURRENT_SECONDS', seconds: 12 * 60 * 60 },
  cruxHistory: { env: 'PERFKIT_CACHE_TTL_CRUX_HISTORY_SECONDS', seconds: 7 * 24 * 60 * 60 },
};
export const CACHE_MAX_ENTRIES_ENV = 'PERFKIT_CACHE_MAX_ENTRIES';
export const CACHE_MAX_ENTRIES_DEFAULT = 500;

export type Env = Readonly<Record<string, string | undefined>>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: Env): Config {
  const googleApiKey = env['GOOGLE_API_KEY']?.trim();
  if (!googleApiKey) {
    throw new ConfigError(
      'GOOGLE_API_KEY is not set. perfkit needs a Google API key with the PageSpeed Insights API and ' +
        'Chrome UX Report API enabled. Set GOOGLE_API_KEY in the MCP server environment and restart.',
    );
  }
  return { googleApiKey, dnsCheck: parseFlag(env, 'PERFKIT_DNS_CHECK'), cache: loadCacheConfig(env) };
}

/** A non-negative integer from `env[name]`, or `fallback` when unset. 0 disables. */
function nonNegativeInt(env: Env, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new ConfigError(`${name} must be a non-negative whole number.`);
  return Number(raw);
}

function loadCacheConfig(env: Env): CacheConfig {
  const ttlMs = {} as Record<CacheKind, number>;
  for (const [kind, { env: name, seconds }] of Object.entries(CACHE_TTL_DEFAULTS) as [
    CacheKind,
    { env: string; seconds: number },
  ][]) {
    ttlMs[kind] = nonNegativeInt(env, name, seconds) * 1000;
  }
  return { ttlMs, maxEntries: nonNegativeInt(env, CACHE_MAX_ENTRIES_ENV, CACHE_MAX_ENTRIES_DEFAULT) };
}

/** Unset, "", "0" or "false" → false; "1" or "true" → true; anything else is a ConfigError. */
function parseFlag(env: Env, name: string): boolean {
  const value = env[name]?.trim().toLowerCase();
  if (value === undefined || value === '' || value === '0' || value === 'false') return false;
  if (value === '1' || value === 'true') return true;
  throw new ConfigError(`${name} must be 1 (on) or 0 (off).`);
}

/**
 * Config: parses environment variables into a typed config.
 *
 * Only GOOGLE_API_KEY is required. Every other option (timeouts, retries,
 * cache lifetimes, the overview budget, PERFKIT_DNS_CHECK) has a default. Error messages name variables and never echo their values.
 */
import type { CacheConfig, CacheKind } from './cache.js';

/** The upstream services perfkit calls; each has its own timeout and retry policy. */
export type UpstreamSource = 'pagespeed' | 'crux';

export interface UpstreamPolicy {
  /** Per-attempt timeout in milliseconds. */
  readonly timeoutMs: number;
  /** Retries after the first attempt (on 429, 5xx, timeouts and network failures). */
  readonly retries: number;
}

export interface Config {
  readonly googleApiKey: string;
  /** PERFKIT_DNS_CHECK=1: also reject hosts that resolve to non-public addresses (ADR 0001). Off by default. */
  readonly dnsCheck: boolean;
  readonly upstream: Readonly<Record<UpstreamSource, UpstreamPolicy>>;
  readonly cache: CacheConfig;
  /** Overall time budget for one performance_overview call, in milliseconds. */
  readonly overviewBudgetMs: number;
}

/** performance_overview's overall budget: past it, unfinished sections become upstream_timeout. */
export const OVERVIEW_BUDGET_ENV = 'PERFKIT_OVERVIEW_BUDGET_MS';
export const OVERVIEW_BUDGET_DEFAULT_MS = 75_000;

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

/** Defaults from the spec: PSI 60 s with 1 retry; CrUX 10 s with up to 3 retries. */
export const UPSTREAM_DEFAULTS: Readonly<Record<UpstreamSource, UpstreamPolicy>> = {
  pagespeed: { timeoutMs: 60_000, retries: 1 },
  crux: { timeoutMs: 10_000, retries: 3 },
};

/** Environment variables overriding `UPSTREAM_DEFAULTS`. */
export const UPSTREAM_ENV: Readonly<Record<UpstreamSource, { timeoutMs: string; retries: string }>> = {
  pagespeed: { timeoutMs: 'PERFKIT_PSI_TIMEOUT_MS', retries: 'PERFKIT_PSI_RETRIES' },
  crux: { timeoutMs: 'PERFKIT_CRUX_TIMEOUT_MS', retries: 'PERFKIT_CRUX_RETRIES' },
};

const MAX_TIMEOUT_MS = 600_000;
const MAX_RETRIES = 10;

/**
 * Reads an optional whole-number variable, `fallback` when unset. With
 * `bounds` it must lie in min..max; without, any non-negative value is
 * accepted. The error names the variable, never its value.
 */
function intVar(env: Env, name: string, fallback: number, bounds?: { min: number; max: number }): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  const { min, max } = bounds ?? { min: 0, max: Number.MAX_SAFE_INTEGER };
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigError(
      bounds ? `${name} must be a whole number from ${min} to ${max}.` : `${name} must be a non-negative whole number.`,
    );
  }
  return value;
}

function upstreamPolicy(env: Env, source: UpstreamSource): UpstreamPolicy {
  const names = UPSTREAM_ENV[source];
  const defaults = UPSTREAM_DEFAULTS[source];
  return {
    timeoutMs: intVar(env, names.timeoutMs, defaults.timeoutMs, { min: 1, max: MAX_TIMEOUT_MS }),
    retries: intVar(env, names.retries, defaults.retries, { min: 0, max: MAX_RETRIES }),
  };
}

export function loadConfig(env: Env): Config {
  const googleApiKey = env['GOOGLE_API_KEY']?.trim();
  if (!googleApiKey) {
    throw new ConfigError(
      'GOOGLE_API_KEY is not set. perfkit needs a Google API key with the PageSpeed Insights API and ' +
        'Chrome UX Report API enabled. Set GOOGLE_API_KEY in the MCP server environment and restart.',
    );
  }
  return {
    googleApiKey,
    dnsCheck: parseFlag(env, 'PERFKIT_DNS_CHECK'),
    upstream: { pagespeed: upstreamPolicy(env, 'pagespeed'), crux: upstreamPolicy(env, 'crux') },
    cache: loadCacheConfig(env),
    overviewBudgetMs: intVar(env, OVERVIEW_BUDGET_ENV, OVERVIEW_BUDGET_DEFAULT_MS, { min: 1, max: MAX_TIMEOUT_MS }),
  };
}

function loadCacheConfig(env: Env): CacheConfig {
  const ttlMs = {} as Record<CacheKind, number>;
  for (const [kind, { env: name, seconds }] of Object.entries(CACHE_TTL_DEFAULTS) as [
    CacheKind,
    { env: string; seconds: number },
  ][]) {
    ttlMs[kind] = intVar(env, name, seconds) * 1000; // 0 disables
  }
  return { ttlMs, maxEntries: intVar(env, CACHE_MAX_ENTRIES_ENV, CACHE_MAX_ENTRIES_DEFAULT) };
}

/** Unset, "", "0" or "false" → false; "1" or "true" → true; anything else is a ConfigError. */
function parseFlag(env: Env, name: string): boolean {
  const value = env[name]?.trim().toLowerCase();
  if (value === undefined || value === '' || value === '0' || value === 'false') return false;
  if (value === '1' || value === 'true') return true;
  throw new ConfigError(`${name} must be 1 (on) or 0 (off).`);
}

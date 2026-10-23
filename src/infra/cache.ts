/**
 * In-memory TTL + LRU cache for provider outcomes, shared by every tool
 * (including the overview), so repeat questions save API quota.
 *
 * - Keys combine provider, normalised target, scope, device, categories and
 *   requested metrics (`CacheKeyParts`); list parts are order-insensitive.
 * - Each entry's lifetime comes from its `kind` (pagespeed / cruxCurrent /
 *   cruxHistory), configured in `Config.cache.ttlMs`.
 * - Only values returned by `load` are stored: anything it throws (errors)
 *   is not cached. A `no_data` outcome is a value, so it is cached; it must
 *   use the current-field-data lifetime (see `CacheRequest.lifetime`).
 * - Bounded by `maxEntries`, evicting the least recently used entry.
 * - Logs every hit and miss (without the target, which may hold secrets).
 */
import type { Logger } from './logger.js';

export type CacheKind = 'pagespeed' | 'cruxCurrent' | 'cruxHistory';

export interface CacheKeyParts {
  provider: 'pagespeed' | 'crux';
  /** The validated, normalised target URL or origin. */
  target: string;
  scope?: 'url' | 'origin';
  /** The device as the caller requested it (e.g. ALL), not the upstream form factor. */
  device: string;
  categories?: readonly string[];
  metrics?: readonly string[];
  /** Field history: how many windows were requested. */
  periods?: number;
}

export interface CacheConfig {
  ttlMs: Readonly<Record<CacheKind, number>>;
  maxEntries: number;
}

export interface Cached<T> {
  value: T;
  /** When the entry was filled; present only on a cache hit. */
  cachedAt?: Date;
}

export interface CacheRequest<T> {
  kind: CacheKind;
  key: CacheKeyParts;
  /** Fetches on a miss. Anything it throws propagates and is not cached. */
  load: () => Promise<T>;
  logger: Logger;
  /**
   * Picks the lifetime for a loaded value when it differs from `kind`'s.
   * E.g. history (#8) caches `no_data` with the current-field-data lifetime:
   * `lifetime: (o) => (o.kind === 'no_data' ? 'cruxCurrent' : 'cruxHistory')`.
   */
  lifetime?: (value: T) => CacheKind;
}

export interface ProviderCache {
  getOrLoad<T>(request: CacheRequest<T>): Promise<Cached<T>>;
}

interface Entry {
  value: unknown;
  filledAt: Date;
  expiresAt: number;
}

export function cacheKey(kind: CacheKind, parts: CacheKeyParts): string {
  const sorted = (list?: readonly string[]) => (list ? [...list].sort() : null);
  return JSON.stringify([
    kind,
    parts.provider,
    parts.target,
    parts.scope ?? null,
    parts.device,
    sorted(parts.categories),
    sorted(parts.metrics),
    parts.periods ?? null,
  ]);
}

export function createProviderCache(config: CacheConfig, now: () => Date): ProviderCache {
  // Map iteration order is insertion order; re-inserting on hit keeps it LRU.
  const entries = new Map<string, Entry>();

  return {
    async getOrLoad<T>({ kind, key, load, logger, lifetime }: CacheRequest<T>): Promise<Cached<T>> {
      const id = cacheKey(kind, key);
      const logFields = { cacheKind: kind, provider: key.provider, scope: key.scope, device: key.device };
      const hit = entries.get(id);
      if (hit && hit.expiresAt > now().getTime()) {
        entries.delete(id);
        entries.set(id, hit);
        logger.info('cache hit', { ...logFields, cachedAt: hit.filledAt.toISOString() });
        return { value: hit.value as T, cachedAt: hit.filledAt };
      }
      if (hit) entries.delete(id);
      logger.info('cache miss', { ...logFields, expired: hit !== undefined });

      // Stamp the fill with the request time, matching the miss's collectedAt.
      const filledAt = now();
      const value = await load();
      const ttl = config.ttlMs[lifetime?.(value) ?? kind];
      if (ttl > 0 && config.maxEntries > 0) {
        entries.set(id, { value, filledAt, expiresAt: filledAt.getTime() + ttl });
        while (entries.size > config.maxEntries) {
          const oldest = entries.keys().next().value as string;
          entries.delete(oldest);
        }
      }
      return { value };
    },
  };
}

/**
 * Marks a result built from a cache lookup. On a hit it sets `cached: true`,
 * `cachedAt`, and `collectedAt` to the fill time (when perfkit actually
 * fetched the evidence); on a miss it sets `cached: false` and leaves
 * `collectedAt` alone.
 */
export function withCacheFields<R extends { cached: boolean; cachedAt?: string; collectedAt: string }>(
  result: R,
  lookup: Cached<unknown>,
): R {
  if (!lookup.cachedAt) return { ...result, cached: false };
  const at = lookup.cachedAt.toISOString();
  return { ...result, cached: true, cachedAt: at, collectedAt: at };
}

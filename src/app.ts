/**
 * Composition root: builds perfkit's dependencies from the environment and
 * injected I/O. Transport-independent (no MCP SDK imports).
 *
 * The one `cache` built here is shared by every tool (including the overview).
 */
import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';
import { createProviderCache, type ProviderCache } from './infra/cache.js';
import { loadConfig, type Config, type Env } from './infra/config.js';
import { createHttpClient } from './infra/http.js';
import { createLogger, type Logger } from './infra/logger.js';
import { createCruxClient, type CruxClient } from './providers/crux.js';
import { createSecretScrubber } from './security/secrets.js';

export interface AppDeps {
  config: Config;
  logger: Logger;
  crux: CruxClient;
  /** Shared provider-outcome cache; tools wrap provider calls in `cache.getOrLoad`. */
  cache: ProviderCache;
  now: () => Date;
  newCorrelationId: () => string;
}

export interface AppIo {
  env: Env;
  fetch: typeof fetch;
  /** Where JSON logs go. Must be stderr in production; stdout is the MCP channel. */
  stderr: Writable;
  now?: () => Date;
  newCorrelationId?: () => string;
}

/** Throws ConfigError (with a message safe to print) when configuration is invalid. */
export function createApp(io: AppIo): AppDeps {
  const now = io.now ?? (() => new Date());
  const config = loadConfig(io.env);
  const logger = createLogger({ stream: io.stderr, now, scrub: createSecretScrubber([config.googleApiKey]) });
  const http = createHttpClient({ fetch: io.fetch, apiKey: config.googleApiKey });
  return {
    config,
    logger,
    crux: createCruxClient(http),
    cache: createProviderCache(config.cache, now),
    now,
    newCorrelationId: io.newCorrelationId ?? randomUUID,
  };
}

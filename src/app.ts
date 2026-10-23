/**
 * Composition root: builds perfkit's dependencies from the environment and
 * injected I/O. Transport-independent (no MCP SDK imports).
 *
 * Extension point (#6): wrap the provider clients in the shared cache here so
 * every tool (including the overview) shares it.
 */
import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';
import { loadConfig, type Config, type Env } from './infra/config.js';
import { createHttpClient, type Sleep } from './infra/http.js';
import { createLogger, type Logger } from './infra/logger.js';
import { createCruxClient, type CruxClient } from './providers/crux.js';
import { createSecretScrubber } from './security/secrets.js';

export interface AppDeps {
  config: Config;
  logger: Logger;
  crux: CruxClient;
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
  /** Backoff wait between upstream retries (tests inject one that returns at once). */
  sleep?: Sleep;
  /** Jitter source in [0, 1). */
  random?: () => number;
}

/** Throws ConfigError (with a message safe to print) when configuration is invalid. */
export function createApp(io: AppIo): AppDeps {
  const now = io.now ?? (() => new Date());
  const config = loadConfig(io.env);
  const logger = createLogger({ stream: io.stderr, now, scrub: createSecretScrubber([config.googleApiKey]) });
  const http = createHttpClient({
    fetch: io.fetch,
    apiKey: config.googleApiKey,
    policies: config.upstream,
    ...(io.sleep ? { sleep: io.sleep } : {}),
    ...(io.random ? { random: io.random } : {}),
  });
  return {
    config,
    logger,
    crux: createCruxClient(http),
    now,
    newCorrelationId: io.newCorrelationId ?? randomUUID,
  };
}

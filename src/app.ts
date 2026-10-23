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
import { createHttpClient } from './infra/http.js';
import { createLogger, type Logger } from './infra/logger.js';
import { createCruxClient, type CruxClient } from './providers/crux.js';
import { createSecretScrubber } from './security/secrets.js';
import { createTargetValidator, type HostLookup, type TargetValidator } from './security/target.js';

export interface AppDeps {
  config: Config;
  logger: Logger;
  crux: CruxClient;
  /** Validates every tool's `url` input (ADR 0001); tools must use it before any upstream call. */
  targets: TargetValidator;
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
  /** DNS resolver for PERFKIT_DNS_CHECK (defaults to the system resolver). */
  lookup?: HostLookup;
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
    targets: createTargetValidator({ dnsCheck: config.dnsCheck, ...(io.lookup ? { lookup: io.lookup } : {}) }),
    now,
    newCorrelationId: io.newCorrelationId ?? randomUUID,
  };
}

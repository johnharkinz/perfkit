/**
 * Config: parses environment variables into a typed config.
 *
 * Only GOOGLE_API_KEY is required. Later options (timeouts, retries, cache
 * lifetimes, overview budget, PERFKIT_DNS_CHECK) are added to `Config` and
 * parsed here, each with a default. Error messages name variables and never
 * echo their values.
 */

export interface Config {
  readonly googleApiKey: string;
}

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
  return { googleApiKey };
}

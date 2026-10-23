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
  /** PERFKIT_DNS_CHECK=1: also reject hosts that resolve to non-public addresses (ADR 0001). Off by default. */
  readonly dnsCheck: boolean;
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
  return { googleApiKey, dnsCheck: parseFlag(env, 'PERFKIT_DNS_CHECK') };
}

/** Unset, "", "0" or "false" → false; "1" or "true" → true; anything else is a ConfigError. */
function parseFlag(env: Env, name: string): boolean {
  const value = env[name]?.trim().toLowerCase();
  if (value === undefined || value === '' || value === '0' || value === 'false') return false;
  if (value === '1' || value === 'true') return true;
  throw new ConfigError(`${name} must be 1 (on) or 0 (off).`);
}

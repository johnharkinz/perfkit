/**
 * Target validation: raw URL string in, validated target or `invalid_input` out.
 *
 * Text-only checks per ADR 0001: http/https only, a length cap, no embedded
 * credentials, no loopback/private/link-local/metadata IP literals (IPv4 and
 * IPv6, including embedded IPv4), and no localhost, .localhost, .local,
 * .internal or single-label hosts. The fragment is stripped and the origin is
 * scheme plus host. Callers must use `display` (credentials and sensitive
 * query parameters redacted) in all output and logs, and `url`/`origin` only
 * for the upstream request.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIPv4 } from 'node:net';
import { PerfkitError } from '../domain/errors.js';
import { isPublicIp } from './ip.js';
import { redactUrl } from './redact.js';

export { redactUrl } from './redact.js';

export interface Target {
  /** Normalised URL to send upstream (fragment stripped). */
  readonly url: string;
  /** Scheme plus host (and non-default port), no path, no trailing slash. */
  readonly origin: string;
  /** Redacted form, safe for results and logs. */
  readonly display: string;
}

export type TargetResult = { ok: true; target: Target } | { ok: false; error: PerfkitError };

function invalid(message: string): TargetResult {
  return {
    ok: false,
    error: new PerfkitError({ code: 'invalid_input', source: 'perfkit', retryable: false, message }),
  };
}

/** Longest URL accepted, in characters, after trimming whitespace. */
export const MAX_URL_LENGTH = 2048;

export function parseTarget(raw: string): TargetResult {
  const trimmed = raw.trim();
  if (trimmed.length > MAX_URL_LENGTH) {
    return invalid(`url must be at most ${MAX_URL_LENGTH} characters.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return invalid('url must be an absolute http or https URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return invalid('url must use http or https.');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return invalid('url must not contain credentials (user:password@).');
  }
  const hostProblem = checkHost(parsed.hostname);
  if (hostProblem) return invalid(hostProblem);
  parsed.hash = '';
  const url = parsed.href;
  return { ok: true, target: { url, origin: parsed.origin, display: redactUrl(url) } };
}

/** Resolves a host name to all of its IP addresses. */
export type HostLookup = (hostname: string) => Promise<string[]>;

export const systemLookup: HostLookup = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

export interface TargetValidator {
  /** `parseTarget`, plus (when enabled) a check that the host resolves only to public addresses. */
  validate(raw: string): Promise<TargetResult>;
}

export function createTargetValidator(options: { dnsCheck: boolean; lookup?: HostLookup }): TargetValidator {
  const lookup = options.lookup ?? systemLookup;
  return {
    async validate(raw) {
      const result = parseTarget(raw);
      if (!result.ok || !options.dnsCheck) return result;
      const { hostname } = new URL(result.target.url);
      if (hostname.startsWith('[') || isIPv4(hostname)) return result; // literal, already checked
      let addresses: string[];
      try {
        addresses = await lookup(hostname);
      } catch {
        return invalid('url host could not be resolved (PERFKIT_DNS_CHECK is on).');
      }
      if (addresses.length === 0) return invalid('url host could not be resolved (PERFKIT_DNS_CHECK is on).');
      if (!addresses.every(isPublicIp)) {
        return invalid('url host resolves to a non-public IP address (PERFKIT_DNS_CHECK is on).');
      }
      return result;
    },
  };
}

const RESERVED_SUFFIXES = ['localhost', 'local', 'internal'];

/**
 * Text-only host check (ADR 0001). `hostname` is as normalised by URL parsing:
 * lower-cased, IPv4 in dotted-decimal, IPv6 in brackets.
 */
function checkHost(hostname: string): string | undefined {
  if (hostname.startsWith('[')) {
    return isPublicIp(hostname.slice(1, -1)) ? undefined : 'url must not target a non-public IP address.';
  }
  if (isIPv4(hostname)) {
    return isPublicIp(hostname) ? undefined : 'url must not target a non-public IP address.';
  }
  const name = hostname.replace(/\.+$/, '');
  const labels = name.split('.');
  const last = labels[labels.length - 1] ?? '';
  if (RESERVED_SUFFIXES.includes(last)) {
    return 'url must not target localhost, .localhost, .local or .internal hosts.';
  }
  if (labels.length < 2) return 'url must use a public, fully qualified host name.';
  return undefined;
}

const MAX_INVALID_DISPLAY_LENGTH = 200;

/**
 * Display form of a raw input for `requestedUrl`, valid or not: fragment
 * dropped when parseable, credentials and sensitive parameters redacted, and
 * truncated (with "…") to 200 characters.
 */
export function displayForInvalid(raw: string): string {
  const result = parseTarget(raw);
  if (result.ok) return result.target.display;
  const trimmed = raw.trim();
  let text = trimmed;
  try {
    const parsed = new URL(trimmed);
    parsed.hash = '';
    text = parsed.href;
  } catch {
    // Not a URL: redact the raw text as-is.
  }
  const redacted = redactUrl(text);
  return redacted.length > MAX_INVALID_DISPLAY_LENGTH ? `${redacted.slice(0, MAX_INVALID_DISPLAY_LENGTH)}…` : redacted;
}

/**
 * Target validation: raw URL string in, validated target or `invalid_input` out.
 *
 * Minimal seam for #2: standard URL parsing, http/https only, fragment
 * stripped, origin derived as scheme plus host. #4 hardens this per ADR 0001
 * (length cap, credentials, private/loopback/metadata IP literals, reserved
 * hostnames, optional DNS check) and fills in `display` redaction of
 * sensitive query parameters. Callers must use `display` in all output and
 * logs and `url`/`origin` only for the upstream request.
 */
import { PerfkitError } from '../domain/errors.js';

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

export function parseTarget(raw: string): TargetResult {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return invalid('url must be an absolute http or https URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return invalid('url must use http or https.');
  }
  parsed.hash = '';
  const url = parsed.href;
  return { ok: true, target: { url, origin: parsed.origin, display: url } };
}

/**
 * Display form of a raw input for `requestedUrl`, valid or not.
 * #4: must also redact credentials and sensitive parameters from unparseable/rejected input.
 */
export function displayForInvalid(raw: string): string {
  const result = parseTarget(raw);
  return result.ok ? result.target.display : raw.slice(0, 200);
}

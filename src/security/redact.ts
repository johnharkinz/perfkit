/**
 * Redaction of URL credentials and sensitive query-parameter values.
 *
 * Works on arbitrary text, not just parsed URLs, so it can be applied to
 * rejected input and to whole log lines. Parameter names are kept so the
 * reader can see that something was removed; only values are replaced.
 */
export const REDACTED = '[REDACTED]';

/** Name words (after splitting on punctuation and camelCase) that mark a parameter as sensitive. */
const SENSITIVE_WORDS = new Set([
  'token',
  'key',
  'apikey',
  'auth',
  'oauth',
  'authorization',
  'session',
  'sessionid',
  'sid',
  'password',
  'passwd',
  'pwd',
  'pass',
  'secret',
  'signature',
  'sig',
  'credential',
  'credentials',
  'jwt',
  'otp',
]);

/** Substrings that mark a parameter as sensitive even inside a run-together name (e.g. "accesstoken"). */
const SENSITIVE_FRAGMENTS = ['token', 'secret', 'password', 'passwd', 'signature', 'session', 'apikey', 'credential'];

export function isSensitiveParam(rawName: string): boolean {
  let name = rawName;
  try {
    name = decodeURIComponent(rawName.replace(/\+/g, ' '));
  } catch {
    // Keep the raw name if it is not valid percent-encoding.
  }
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  if (words.some((w) => SENSITIVE_WORDS.has(w))) return true;
  const compact = words.join('');
  return SENSITIVE_FRAGMENTS.some((f) => compact.includes(f));
}

const QUERY_PARAM = /([?&])([^=&#?\s"'\\]+)=([^&#\s"'\\]*)/g;
const USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^/?#@\s"'\\]+@/gi;

/** Replaces `scheme://user:pass@` with `scheme://[REDACTED]@` and sensitive parameter values with `[REDACTED]`. */
export function redactUrl(text: string): string {
  return text
    .replace(USERINFO, `$1${REDACTED}@`)
    .replace(QUERY_PARAM, (match: string, sep: string, name: string) =>
      isSensitiveParam(name) ? `${sep}${name}=${REDACTED}` : match,
    );
}

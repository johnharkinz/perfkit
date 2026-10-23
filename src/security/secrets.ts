/**
 * Last-line defence against leaking secrets into logs: removes the given
 * secrets (the API key) and redacts URL credentials and sensitive query
 * parameters anywhere in the text. Primary defence is never putting them into
 * messages in the first place.
 */
import { REDACTED, redactUrl } from './redact.js';

export { REDACTED } from './redact.js';

export type Scrubber = (text: string) => string;

export function createSecretScrubber(secrets: readonly string[]): Scrubber {
  const live = secrets.filter((s) => s.length > 0);
  return (text) => live.reduce((out, secret) => out.split(secret).join(REDACTED), redactUrl(text));
}

/**
 * Last-line defence against leaking secrets (the API key) into logs.
 * Primary defence is never putting them into messages in the first place.
 */

export type Scrubber = (text: string) => string;

export const REDACTED = '[REDACTED]';

export function createSecretScrubber(secrets: readonly string[]): Scrubber {
  const live = secrets.filter((s) => s.length > 0);
  return (text) => live.reduce((out, secret) => out.split(secret).join(REDACTED), text);
}

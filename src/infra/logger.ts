/**
 * Structured JSON logs, one object per line, to stderr only.
 * stdout is reserved for MCP protocol traffic.
 */
import type { Writable } from 'node:stream';
import type { Scrubber } from '../security/secrets.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** A logger that adds `fields` (e.g. a correlationId) to every entry. */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  stream: Writable;
  now: () => Date;
  scrub: Scrubber;
}

export function createLogger(options: LoggerOptions, bound: LogFields = {}): Logger {
  const write = (level: LogLevel, msg: string, fields?: LogFields): void => {
    const entry = { ts: options.now().toISOString(), level, msg, ...bound, ...fields };
    let line: string;
    try {
      line = JSON.stringify(entry);
    } catch {
      line = JSON.stringify({ ts: entry.ts, level, msg, ...bound, logError: 'unserialisable fields' });
    }
    options.stream.write(options.scrub(line) + '\n');
  };
  return {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
    child: (fields) => createLogger(options, { ...bound, ...fields }),
  };
}

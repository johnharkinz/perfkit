/**
 * Starts perfkit on a stdio transport over the given streams. Separated from
 * main.ts so tests can drive startup with fake streams and fetch.
 */
import type { Readable, Writable } from 'node:stream';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createApp } from './app.js';
import { ConfigError, type Env } from './infra/config.js';
import { createServer } from './server.js';
import { SERVER_VERSION } from './version.js';

export interface StartIo {
  env: Env;
  stdin: Readable;
  /** Reserved for MCP protocol traffic. */
  stdout: Writable;
  /** JSON logs. */
  stderr: Writable;
  fetch: typeof fetch;
}

export interface Started {
  /** Set when startup failed; the process should exit with this code. */
  exitCode?: number;
  close(): Promise<void>;
}

export async function start(io: StartIo): Promise<Started> {
  let app;
  try {
    app = createApp({ env: io.env, fetch: io.fetch, stderr: io.stderr });
  } catch (err) {
    const msg = err instanceof ConfigError ? err.message : 'perfkit failed to start.';
    io.stderr.write(
      JSON.stringify({ ts: new Date().toISOString(), level: 'error', msg: 'perfkit failed to start', reason: msg }) +
        '\n',
    );
    return { exitCode: 1, close: async () => {} };
  }

  const server = createServer(app);
  await server.connect(new StdioServerTransport(io.stdin, io.stdout));
  app.logger.info('perfkit started', { version: SERVER_VERSION, transport: 'stdio' });
  return { close: () => server.close() };
}

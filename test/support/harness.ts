import { Writable } from 'node:stream';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createApp } from '../../src/app.js';
import { createServer } from '../../src/server.js';
import type { HostLookup } from '../../src/security/target.js';

export const TEST_API_KEY = 'AIzaTEST-not-a-real-key-0123456789';

/** A writable stream that keeps everything written to it. */
export class CapturedStream extends Writable {
  text = '';
  override _write(chunk: Buffer | string, _enc: BufferEncoding, done: () => void): void {
    this.text += chunk.toString();
    done();
  }
  /** Each non-empty line parsed as JSON (throws if a line is not JSON). */
  jsonLines(): Record<string, unknown>[] {
    return this.text
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }
}

export interface Perfkit {
  client: Client;
  stderr: CapturedStream;
  close(): Promise<void>;
}

/** Connects an in-memory MCP client to the real perfkit server, with an injected fetch. */
export async function connectPerfkit(options: {
  fetch: typeof fetch;
  env?: Record<string, string>;
  /** DNS resolver used when PERFKIT_DNS_CHECK=1 (defaults to the real resolver). */
  lookup?: HostLookup;
}): Promise<Perfkit> {
  const stderr = new CapturedStream();
  const app = createApp({
    env: options.env ?? { GOOGLE_API_KEY: TEST_API_KEY },
    fetch: options.fetch,
    ...(options.lookup ? { lookup: options.lookup } : {}),
    stderr,
    now: () => new Date('2026-10-23T12:00:00.000Z'),
  });
  const server = createServer(app);
  const client = new Client({ name: 'perfkit-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    stderr,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

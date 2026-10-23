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

export const TEST_START_TIME = '2026-10-23T12:00:00.000Z';

/** A fixed clock that only moves when a test advances it. */
export interface TestClock {
  now(): Date;
  advance(ms: number): void;
}

export function testClock(start = TEST_START_TIME): TestClock {
  let t = new Date(start).getTime();
  return {
    now: () => new Date(t),
    advance: (ms) => {
      t += ms;
    },
  };
}

export interface Perfkit {
  client: Client;
  stderr: CapturedStream;
  /** Every backoff delay (ms) perfkit asked to wait; the harness returns at once instead of waiting. */
  sleeps: number[];
  /** The server's clock: fixed at TEST_START_TIME until advanced. */
  clock: TestClock;
  close(): Promise<void>;
}

export interface ConnectOptions {
  fetch: typeof fetch;
  env?: Record<string, string>;
  /** DNS resolver used when PERFKIT_DNS_CHECK=1 (defaults to the real resolver). */
  lookup?: HostLookup;
  /** Jitter source for backoff (default Math.random). */
  random?: () => number;
}

/** Connects an in-memory MCP client to the real perfkit server, with an injected fetch. */
export async function connectPerfkit(options: ConnectOptions): Promise<Perfkit> {
  const stderr = new CapturedStream();
  const sleeps: number[] = [];
  const clock = testClock();
  const app = createApp({
    env: options.env ?? { GOOGLE_API_KEY: TEST_API_KEY },
    fetch: options.fetch,
    ...(options.lookup ? { lookup: options.lookup } : {}),
    stderr,
    now: clock.now,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...(options.random ? { random: options.random } : {}),
  });
  const server = createServer(app);
  const client = new Client({ name: 'perfkit-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    stderr,
    sleeps,
    clock,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

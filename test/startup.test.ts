import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { Client, type JSONRPCMessage, type Transport } from '@modelcontextprotocol/client';
import { start, type Started } from '../src/start.js';
import { CapturedStream, TEST_API_KEY } from './support/harness.js';
import { fakeFetch, fixture } from './support/fake-google.js';

/** A client transport speaking newline-delimited JSON-RPC over a pair of streams (what stdio does). */
class LineTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private buffer = '';
  constructor(
    private readonly toServer: PassThrough,
    private readonly fromServer: PassThrough,
  ) {}
  async start(): Promise<void> {
    this.fromServer.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      let nl: number;
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        if (line.trim()) this.onmessage?.(JSON.parse(line) as JSONRPCMessage);
      }
    });
  }
  async send(message: JSONRPCMessage): Promise<void> {
    this.toServer.write(JSON.stringify(message) + '\n');
  }
  async close(): Promise<void> {
    this.onclose?.();
  }
}

let started: Started | undefined;
afterEach(async () => {
  await started?.close();
  started = undefined;
});

describe('startup', () => {
  it('fails without GOOGLE_API_KEY, naming the variable', async () => {
    const stdout = new CapturedStream();
    const stderr = new CapturedStream();

    const result = await start({
      env: {},
      stdin: new PassThrough(),
      stdout,
      stderr,
      fetch: fakeFetch(() => ({ status: 500, body: {} })),
    });

    expect(result.exitCode).toBe(1);
    expect(stderr.text).toContain('GOOGLE_API_KEY');
    expect(stdout.text).toBe('');
  });

  it('never prints the value of a present-but-blank key or any other variable', async () => {
    const stderr = new CapturedStream();

    const result = await start({
      env: { GOOGLE_API_KEY: '   ', SOME_SECRET: 'hunter2-value' },
      stdin: new PassThrough(),
      stdout: new CapturedStream(),
      stderr,
      fetch: fakeFetch(() => ({ status: 500, body: {} })),
    });

    expect(result.exitCode).toBe(1);
    expect(stderr.text).toContain('GOOGLE_API_KEY');
    expect(stderr.text).not.toContain('hunter2-value');
  });

  it('writes only MCP protocol messages to stdout and JSON logs to stderr', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new CapturedStream();
    let stdoutText = '';
    stdout.on('data', (chunk: Buffer) => (stdoutText += chunk.toString()));

    started = await start({
      env: { GOOGLE_API_KEY: TEST_API_KEY },
      stdin,
      stdout,
      stderr,
      fetch: fakeFetch(() => ({ status: 200, body: fixture('crux/current-url-phone.json') })),
    });
    expect(started.exitCode).toBeUndefined();

    const client = new Client({ name: 'stdio-test', version: '0.0.0' });
    await client.connect(new LineTransport(stdin, stdout));
    await client.listTools();
    const res = await client.callTool({
      name: 'performance_crux_current',
      arguments: { url: 'https://developer.chrome.com/' },
    });
    expect(res.structuredContent).toMatchObject({ status: 'ok' });
    await client.close();

    const outLines = stdoutText.split('\n').filter((l) => l.trim() !== '');
    expect(outLines.length).toBeGreaterThan(0);
    for (const line of outLines) expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' });

    const logs = stderr.jsonLines();
    expect(logs.some((l) => l['msg'] === 'perfkit started')).toBe(true);
    for (const log of logs) expect(log).toMatchObject({ level: expect.any(String), msg: expect.any(String) });
    expect(stderr.text).not.toContain(TEST_API_KEY);
  });
});

import { readFileSync } from 'node:fs';

export interface RecordedRequest {
  url: URL;
  method: string;
  headers: Headers;
  body: unknown;
}

export interface FakeReply {
  status: number;
  body: unknown;
}

export type FakeFetch = typeof fetch & { calls: RecordedRequest[] };

/** A fake `fetch` that records every request and answers from `reply`. */
export function fakeFetch(reply: (req: RecordedRequest) => FakeReply | Promise<FakeReply>): FakeFetch {
  const calls: RecordedRequest[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const text = await request.text();
    const recorded: RecordedRequest = {
      url: new URL(request.url),
      method: request.method,
      headers: request.headers,
      body: text ? JSON.parse(text) : undefined,
    };
    calls.push(recorded);
    const { status, body } = await reply(recorded);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return Object.assign(impl, { calls }) as FakeFetch;
}

/** Loads a saved Google response from test/fixtures (a fresh copy each call, safe to mutate). */
export function fixture<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(new URL(`../fixtures/${path}`, import.meta.url), 'utf8')) as T;
}

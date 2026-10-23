import { describe, expect, it } from 'vitest';
import { createSecretScrubber } from '../src/security/secrets.js';
import { displayForInvalid, parseTarget, redactUrl } from '../src/security/target.js';

function rejection(raw: string) {
  const result = parseTarget(raw);
  if (result.ok) throw new Error(`expected ${raw} to be rejected`);
  return result.error.toInfo();
}

function accepted(raw: string) {
  const result = parseTarget(raw);
  if (!result.ok) throw new Error(`expected ${raw} to be accepted, got: ${result.error.message}`);
  return result.target;
}

describe('target validation: scheme, parsing, length and credentials', () => {
  it.each(['https://example.com/', 'http://example.com/page?x=1'])('accepts %s', (raw) => {
    expect(accepted(raw).url).toBe(raw);
  });

  it.each([
    'ftp://example.com/',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,hi',
    'ws://example.com/',
  ])('rejects the non-http(s) scheme in %s', (raw) => {
    expect(rejection(raw)).toMatchObject({ code: 'invalid_input', source: 'perfkit', retryable: false });
  });

  it.each(['not a url', '', '/relative/path', 'https://', 'example.com'])('rejects unparseable %j', (raw) => {
    expect(rejection(raw)).toMatchObject({ code: 'invalid_input', retryable: false });
  });

  it('accepts a URL at the 2048-character cap and rejects one character over', () => {
    const base = 'https://example.com/';
    expect(accepted(base + 'a'.repeat(2048 - base.length)).url).toHaveLength(2048);
    expect(rejection(base + 'a'.repeat(2049 - base.length))).toMatchObject({
      code: 'invalid_input',
      message: expect.stringMatching(/2048/),
    });
  });

  it.each(['https://alice:s3cr3t@example.com/', 'https://alice@example.com/', 'https://:s3cr3t@example.com/'])(
    'rejects embedded credentials in %s, without echoing them',
    (raw) => {
      const error = rejection(raw);
      expect(error).toMatchObject({ code: 'invalid_input', retryable: false });
      expect(error.message).not.toContain('s3cr3t');
      expect(error.message).not.toContain('alice');
    },
  );
});

describe('target validation: IP literals', () => {
  it.each([
    // IPv4 loopback, private, link-local, cloud metadata, unspecified, CGNAT, broadcast
    'http://127.0.0.1/',
    'http://127.255.255.254/',
    'http://10.0.0.1/',
    'http://172.16.0.1/',
    'http://172.31.255.255/',
    'http://192.168.1.1/',
    'http://169.254.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://0.0.0.0/',
    'http://100.100.100.200/',
    'http://255.255.255.255/',
    // Alternative IPv4 spellings that URL parsing normalises to loopback/private
    'http://2130706433/',
    'http://0x7f.1/',
    'http://0177.0.0.1/',
    'http://127.1/',
    // IPv6 loopback, unspecified, unique-local, link-local, metadata, multicast
    'http://[::1]/',
    'http://[::]/',
    'http://[fc00::1]/',
    'http://[fd12:3456::1]/',
    'http://[fe80::1]/',
    'http://[fd00:ec2::254]/',
    'http://[ff02::1]/',
    // IPv4-mapped / embedded IPv6
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/',
    'http://[::ffff:169.254.169.254]/',
    'http://[::ffff:10.0.0.1]/',
    'http://[64:ff9b::a00:1]/',
    'http://[2002:c0a8:101::1]/',
  ])('rejects the non-public IP literal in %s', (raw) => {
    expect(rejection(raw)).toMatchObject({ code: 'invalid_input', source: 'perfkit', retryable: false });
  });

  it.each([
    'http://8.8.8.8/',
    'http://172.15.255.255/',
    'http://172.32.0.1/',
    'http://169.253.255.255/',
    'http://[2001:4860:4860::8888]/',
    'http://[::ffff:808:808]/',
  ])('accepts the public IP literal in %s', (raw) => {
    expect(accepted(raw).url).toBe(raw);
  });
});

describe('target validation: reserved host names', () => {
  it.each([
    'http://localhost/',
    'http://LOCALHOST:3000/',
    'http://localhost./',
    'http://app.localhost/',
    'http://printer.local/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://service.corp.internal./',
    'http://intranet/',
  ])('rejects %s', (raw) => {
    expect(rejection(raw)).toMatchObject({ code: 'invalid_input', source: 'perfkit', retryable: false });
  });

  it.each(['https://localhost.example.com/', 'https://local.example/', 'https://internal.example.com/'])(
    'accepts %s, where the reserved word is not the suffix',
    (raw) => {
      expect(accepted(raw).url).toBe(raw);
    },
  );
});

describe('target validation: normalised URL and origin', () => {
  it('strips the fragment before querying', () => {
    const target = accepted('https://example.com/docs?page=2#section-3');
    expect(target.url).toBe('https://example.com/docs?page=2');
    expect(target.display).toBe('https://example.com/docs?page=2');
  });

  it.each([
    ['https://example.com/a/b?c=d#e', 'https://example.com'],
    ['https://WWW.Example.COM/', 'https://www.example.com'],
    ['https://example.com:443/x', 'https://example.com'],
    ['http://example.com:80/x', 'http://example.com'],
    ['http://example.com:8080/x', 'http://example.com:8080'],
    ['https://[2001:4860:4860::8888]/x', 'https://[2001:4860:4860::8888]'],
  ])('derives the origin of %s as %s (scheme plus host)', (raw, origin) => {
    expect(accepted(raw).origin).toBe(origin);
  });

  it('treats www and bare hosts as different origins', () => {
    expect(accepted('https://www.example.com/').origin).not.toBe(accepted('https://example.com/').origin);
  });
});

describe('redaction of sensitive query parameters', () => {
  it('redacts sensitive parameter values in the display form but sends the URL upstream unchanged', () => {
    const raw =
      'https://example.com/p?token=abc&page=2&api_key=K1&sessionId=S1&X-Amz-Signature=deadbeef' +
      '&password=pw&auth=a1&keyword=perf&access_token=t2&sig=s2&client_secret=cs';
    const target = accepted(raw);
    expect(target.url).toBe(raw);
    expect(target.display).toBe(
      'https://example.com/p?token=[REDACTED]&page=2&api_key=[REDACTED]&sessionId=[REDACTED]' +
        '&X-Amz-Signature=[REDACTED]&password=[REDACTED]&auth=[REDACTED]&keyword=perf' +
        '&access_token=[REDACTED]&sig=[REDACTED]&client_secret=[REDACTED]',
    );
  });

  it('matches parameter names case-insensitively and when percent-encoded', () => {
    expect(redactUrl('https://example.com/?TOKEN=a&api%5Fkey=b&Key=c')).toBe(
      'https://example.com/?TOKEN=[REDACTED]&api%5Fkey=[REDACTED]&Key=[REDACTED]',
    );
  });

  it('leaves URLs without sensitive parameters unchanged', () => {
    expect(redactUrl('https://example.com/search?q=monkey&author=jo&page=2')).toBe(
      'https://example.com/search?q=monkey&author=jo&page=2',
    );
  });

  it('strips credentials and sensitive parameters from a rejected URL’s display form', () => {
    expect(displayForInvalid('https://alice:s3cr3t@10.0.0.1/x?token=abc&page=1#frag')).toBe(
      'https://[REDACTED]@10.0.0.1/x?token=[REDACTED]&page=1',
    );
  });

  it('redacts sensitive-looking parameters and credentials even in input that is not accepted', () => {
    expect(displayForInvalid('not a url?password=hunter2&x=1')).toBe('not a url?password=[REDACTED]&x=1');
    expect(displayForInvalid('ftp://bob:hunter2@files.example.com/')).toBe('ftp://[REDACTED]@files.example.com/');
  });

  it('is applied to every log line as a last line of defence', () => {
    const scrub = createSecretScrubber(['AIzaKEY']);
    const line = JSON.stringify({ msg: 'x', target: 'https://bob:pw1@example.com/?key=AIzaKEY&password=pw2&q=1' });
    expect(scrub(line)).toBe(
      JSON.stringify({ msg: 'x', target: 'https://[REDACTED]@example.com/?key=[REDACTED]&password=[REDACTED]&q=1' }),
    );
  });

  it('truncates an over-long rejected URL in its display form', () => {
    const display = displayForInvalid('https://example.com/' + 'a'.repeat(5000));
    expect(display.length).toBeLessThanOrEqual(201);
    expect(display.endsWith('…')).toBe(true);
  });
});

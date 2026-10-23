import { describe, expect, it } from 'vitest';
import { rate } from '../src/domain/metrics.js';

describe('rating thresholds at exact boundaries', () => {
  it.each([
    ['INP', 200, 'good'],
    ['INP', 201, 'needs_improvement'],
    ['INP', 500, 'needs_improvement'],
    ['INP', 501, 'poor'],
    ['LCP', 2500, 'good'],
    ['LCP', 2501, 'needs_improvement'],
    ['LCP', 4000, 'needs_improvement'],
    ['LCP', 4001, 'poor'],
    ['CLS', 0.1, 'good'],
    ['CLS', 0.11, 'needs_improvement'],
    ['CLS', 0.25, 'needs_improvement'],
    ['CLS', 0.26, 'poor'],
    ['FCP', 1800, 'good'],
    ['FCP', 1801, 'needs_improvement'],
    ['FCP', 3000, 'needs_improvement'],
    ['FCP', 3001, 'poor'],
    ['TTFB', 800, 'good'],
    ['TTFB', 801, 'needs_improvement'],
    ['TTFB', 1800, 'needs_improvement'],
    ['TTFB', 1801, 'poor'],
  ] as const)('%s p75 %s is %s', (metric, p75, expected) => {
    expect(rate(metric, p75)).toBe(expected);
  });

  it('rates CLS just above 0.1 and 0.25 by a hair', () => {
    expect(rate('CLS', 0.1000001)).toBe('needs_improvement');
    expect(rate('CLS', 0.2500001)).toBe('poor');
  });

  it('converts string p75 values before rating', () => {
    expect(rate('CLS', '0.10')).toBe('good');
    expect(rate('CLS', '0.26')).toBe('poor');
    expect(rate('LCP', '2501')).toBe('needs_improvement');
  });

  it('returns null when there is no usable p75', () => {
    expect(rate('INP', null)).toBeNull();
    expect(rate('CLS', 'NaN')).toBeNull();
    expect(rate('LCP', '')).toBeNull();
  });
});

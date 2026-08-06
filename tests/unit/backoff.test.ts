import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { DEFAULT_BACKOFF, RetryExhaustedError, backoffDelay, retrySync, sleepSync } from '../../src/shared/backoff.js';

describe('backoffDelay', () => {
  it('doubles the ceiling on each attempt', () => {
    const alwaysMax = () => 0.999999;
    expect(backoffDelay(0, { random: alwaysMax })).toBe(50);
    expect(backoffDelay(1, { random: alwaysMax })).toBe(100);
    expect(backoffDelay(2, { random: alwaysMax })).toBe(200);
    expect(backoffDelay(3, { random: alwaysMax })).toBe(400);
  });

  it('caps at maxMs', () => {
    const alwaysMax = () => 0.999999;
    expect(backoffDelay(10, { random: alwaysMax })).toBe(DEFAULT_BACKOFF.maxMs);
    expect(backoffDelay(50, { random: alwaysMax })).toBe(DEFAULT_BACKOFF.maxMs);
  });

  it('uses full jitter, so contending processes do not retry in lockstep', () => {
    expect(backoffDelay(5, { random: () => 0 })).toBe(0);
    expect(backoffDelay(5, { random: () => 0.5 })).toBe(400);
  });

  it('never returns a negative or unbounded delay', () => {
    fc.assert(
      fc.property(fc.integer({ min: -5, max: 100 }), fc.double({ min: 0, max: 0.9999, noNaN: true }), (attempt, r) => {
        const delay = backoffDelay(attempt, { random: () => r });
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(DEFAULT_BACKOFF.maxMs);
      }),
      { numRuns: 1000 },
    );
  });
});

describe('sleepSync', () => {
  it('actually blocks for roughly the requested time', () => {
    const started = Date.now();
    sleepSync(60);
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
  });

  it('returns immediately for a non-positive delay', () => {
    const started = Date.now();
    sleepSync(0);
    sleepSync(-10);
    expect(Date.now() - started).toBeLessThan(20);
  });
});

describe('retrySync', () => {
  const busy = () => Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' });
  const isBusy = (error: unknown) => (error as { code?: string })?.code === 'SQLITE_BUSY';

  it('returns the first successful result without sleeping', () => {
    const sleep = vi.fn();
    expect(retrySync(() => 'ok', isBusy, { sleep })).toBe('ok');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries until the operation succeeds', () => {
    const sleep = vi.fn();
    let attempts = 0;
    const result = retrySync(
      () => {
        attempts++;
        if (attempts < 3) throw busy();
        return attempts;
      },
      isBusy,
      { sleep },
    );
    expect(result).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('rethrows immediately for errors that are not retryable', () => {
    const sleep = vi.fn();
    const boom = new Error('syntax error');
    expect(() => retrySync(() => { throw boom; }, isBusy, { sleep })).toThrow(boom);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('gives up after the configured number of retries', () => {
    const sleep = vi.fn();
    let attempts = 0;
    expect(() =>
      retrySync(
        () => {
          attempts++;
          throw busy();
        },
        isBusy,
        { retries: 3, sleep },
      ),
    ).toThrow(RetryExhaustedError);
    expect(attempts).toBe(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it('keeps the underlying error as the cause', () => {
    const original = busy();
    try {
      retrySync(() => { throw original; }, isBusy, { retries: 1, sleep: () => {} });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(RetryExhaustedError);
      expect((error as RetryExhaustedError).cause).toBe(original);
      expect((error as RetryExhaustedError).attempts).toBe(2);
    }
  });
});

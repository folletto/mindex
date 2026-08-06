/**
 * Retry policy for contended SQLite writes.
 *
 * better-sqlite3 is synchronous, so the retry loop has to be synchronous too —
 * an async sleep would release the event loop in the middle of what callers are
 * entitled to treat as one atomic operation. `sleepSync` uses Atomics.wait,
 * which parks the thread without burning CPU.
 */

export interface BackoffOptions {
  /** How many times to retry *after* the first attempt. */
  retries?: number;
  baseMs?: number;
  maxMs?: number;
  /** Injected in tests so the schedule is deterministic. */
  random?: () => number;
  sleep?: (ms: number) => void;
}

export const DEFAULT_BACKOFF: Required<Pick<BackoffOptions, 'retries' | 'baseMs' | 'maxMs'>> = {
  retries: 5,
  baseMs: 50,
  maxMs: 800,
};

/**
 * Full-jitter exponential backoff: a uniformly random delay in
 * `[0, min(maxMs, baseMs * 2^attempt))`.
 *
 * Full jitter rather than a fixed ramp because the contending processes are
 * near-identical and would otherwise retry in lockstep forever.
 */
export function backoffDelay(attempt: number, options: BackoffOptions = {}): number {
  const baseMs = options.baseMs ?? DEFAULT_BACKOFF.baseMs;
  const maxMs = options.maxMs ?? DEFAULT_BACKOFF.maxMs;
  const random = options.random ?? Math.random;

  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.round(random() * ceiling);
}

/** Block the current thread for `ms` without spinning. */
export function sleepSync(ms: number): void {
  if (ms <= 0) return;
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

export class RetryExhaustedError extends Error {
  readonly attempts: number;
  override readonly cause: unknown;

  constructor(attempts: number, cause: unknown) {
    super(`Operation still failing after ${attempts} attempts`, { cause });
    this.name = 'RetryExhaustedError';
    this.attempts = attempts;
    this.cause = cause;
  }
}

/**
 * Run `operation`, retrying while `isRetryable` says the failure is transient.
 *
 * Safe only for operations that are idempotent by construction — in this app
 * that means `BEGIN IMMEDIATE` transactions, which either commit whole or leave
 * nothing behind, and rev-conditional updates, which are no-ops on replay.
 */
export function retrySync<T>(
  operation: () => T,
  isRetryable: (error: unknown) => boolean,
  options: BackoffOptions = {},
): T {
  const retries = options.retries ?? DEFAULT_BACKOFF.retries;
  const sleep = options.sleep ?? sleepSync;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return operation();
    } catch (error) {
      if (!isRetryable(error)) throw error;
      lastError = error;
      if (attempt < retries) sleep(backoffDelay(attempt, options));
    }
  }
  throw new RetryExhaustedError(retries + 1, lastError);
}

/**
 * Small background-job primitives: bounded concurrency, timeouts, capped retries with
 * exponential backoff (honouring Retry-After), and cancellation via AbortSignal.
 */

export class CancelledError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "CancelledError";
  }
}

/** A failure worth retrying later; `retryAfterMs` comes from a rate-limit response when known. */
export class TransientError extends Error {
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message);
    this.name = "TransientError";
  }
}

export function isCancelled(err: unknown): boolean {
  return err instanceof CancelledError || (err instanceof Error && err.name === "AbortError");
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError());
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new CancelledError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function withTimeout<T>(p: Promise<T>, ms: number, what: string, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError());
    const t = setTimeout(() => reject(new TransientError(`${what} timed out after ${Math.round(ms / 1000)} s`)), ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new CancelledError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        clearTimeout(t);
        signal?.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        signal?.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

export interface RetryOptions {
  attempts: number;
  baseMs: number;
  maxMs: number;
  signal?: AbortSignal;
  onRetry?: (attempt: number, waitMs: number, err: unknown) => void;
}

/** Retry transient failures (TransientError, network/timeouts/429/5xx text); others fail at once. */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, o: RetryOptions): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    if (o.signal?.aborted) throw new CancelledError();
    try {
      return await fn(attempt);
    } catch (err) {
      if (isCancelled(err) || o.signal?.aborted) throw new CancelledError();
      if (attempt >= o.attempts || !retryable(err)) throw err;
      const hinted = err instanceof TransientError ? err.retryAfterMs : undefined;
      const wait = Math.min(o.maxMs, hinted ?? o.baseMs * 2 ** (attempt - 1));
      o.onRetry?.(attempt, wait, err);
      await sleep(wait, o.signal);
    }
  }
}

function retryable(err: unknown): boolean {
  if (err instanceof TransientError) return true;
  const m = err instanceof Error ? err.message : String(err);
  // "YT-DLP download error" from spotDL is usually YouTube throttling a single request: retry it.
  return /rate limit|429|timed? ?out|network|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket|5\d\d\b|unavailable|yt-dlp download error/i.test(m);
}

/** Runs at most `n` tasks at once, in submission order. */
export class Limiter {
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(private n: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.n) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }

  get busy(): number {
    return this.active;
  }
}

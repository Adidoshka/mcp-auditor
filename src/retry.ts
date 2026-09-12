/**
 * retry.ts — status-code-aware retry with exponential backoff.
 *
 * Per CLAUDE.md constraint 6: retry with exponential backoff on 429
 * and 5xx, never on 4xx. Zero model calls and no I/O of its own —
 * this only decides whether and how long to wait between attempts
 * someone else makes.
 *
 * Built deliberately rather than trusted to the openai SDK's own
 * built-in retry, and that's a decision with evidence behind it, not
 * a stylistic preference: the SDK's default `shouldRetry` (read from
 * its source, node_modules/openai/src/client.ts) also retries 408
 * (request timeout) and 409 (conflict) — both 4xx. Leaving the SDK's
 * default `maxRetries` (2) in place would silently violate "never
 * retry 4xx" on exactly the two status codes most likely to look like
 * a reasonable thing to retry. classify.ts sets `maxRetries: 0` to
 * disable that path entirely and routes every call through this file
 * instead, so the policy actually in effect is the one written down
 * here, not whatever the dependency happens to default to this
 * version.
 *
 * Retryable set is exactly `{429} ∪ [500,599]` — no 408, no 409,
 * matching the constraint's literal wording rather than a broader
 * "sounds transient" heuristic. Connection failures and timeouts
 * (no status code at all) are a different failure category — see
 * errors.ts's SlowError — and aren't retried by this policy; the
 * constraint is specifically about status codes, and retrying a dead
 * connection blindly isn't what it asks for.
 */

export interface RetryPolicy {
  /** Total attempts, including the first — not additional retries on top of it. */
  maxAttempts: number;
  /** Delay before the first retry; doubles each attempt after (exponential). */
  baseDelayMs: number;
  /** Hard ceiling on any single computed delay, backoff or Retry-After alike. */
  maxDelayMs: number;
}

/**
 * My decision, per CLAUDE.md's "Things I decide": 3 attempts total (1
 * original + 2 retries). Enough to ride out a single transient blip —
 * a momentary rate limit, a server mid-restart — without making a
 * caller sit through a long chain of backoffs for something that was
 * never going to recover. 500ms base, doubling, capped at 8s: short
 * enough that a batch of calls in Phase 4's eval loop doesn't stall
 * for long, long enough that the delays are wall-clock-meaningful
 * (500ms, ~1s, ~2s) rather than sub-second noise a struggling server
 * has no time to recover within.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
};

export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Full jitter (the term from AWS's "Exponential Backoff and Jitter"
 * writeup): a uniform random delay in [0, computed cap], not the
 * computed value itself. Plain exponential backoff with no jitter
 * means every caller retrying the same failure wakes up at the same
 * instant and re-collides — full jitter is the simplest fix that
 * still keeps the expected wait growing exponentially.
 */
function backoffDelay(attempt: number, policy: RetryPolicy): number {
  const exponential = policy.baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(exponential, policy.maxDelayMs);
  return Math.random() * capped;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `fn`, retrying per `policy` when `getStatus` reports a
 * retryable status code. `getStatus` is a hook rather than an
 * assumption about the error's shape, because different callers throw
 * different error types (an OpenAI SDK `APIError` carries `.status`;
 * an MCP error doesn't necessarily) — this file doesn't know or care
 * which.
 *
 * `getRetryAfterMs`, when given, lets a caller honor a server's own
 * `Retry-After`/`retry-after-ms` header instead of guessing via
 * backoff — a server that says how long to wait deserves to be
 * believed over a computed estimate. Falls back to backoffDelay when
 * absent or when the caller doesn't supply the hook at all.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  getStatus: (error: unknown) => number | undefined,
  options?: {
    policy?: RetryPolicy;
    getRetryAfterMs?: (error: unknown) => number | undefined;
  },
): Promise<T> {
  const policy = options?.policy ?? DEFAULT_RETRY_POLICY;
  let lastError: unknown;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const status = getStatus(error);
      const isLastAttempt = attempt === policy.maxAttempts;
      if (status === undefined || !isRetryableStatus(status) || isLastAttempt) {
        throw error;
      }
      const retryAfterMs = options?.getRetryAfterMs?.(error);
      const delay =
        retryAfterMs !== undefined
          ? Math.min(retryAfterMs, policy.maxDelayMs)
          : backoffDelay(attempt, policy);
      await sleep(delay);
    }
  }
  // Unreachable when maxAttempts >= 1, but keeps the return type honest
  // without a non-null assertion.
  throw lastError;
}

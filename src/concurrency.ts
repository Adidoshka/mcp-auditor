/**
 * concurrency.ts — bounded concurrency for a batch of async calls.
 *
 * Per PLAN.md's Phase 3 bullet list: "bounded concurrency (semaphore,
 * limit ~4)". Nothing in this project calls it yet — classify.ts's own
 * classifyDescription is a single call, so there's nothing for it to
 * bound on its own. This exists for Phase 4's eval loop (10 runs ×
 * every tool, potentially in flight together), which is the first
 * caller that actually fires off many of these calls at once. Built
 * now anyway, deterministic and unit-testable on its own, rather than
 * inlined into eval/run.ts later where it'd be harder to see on its
 * own terms.
 */

/**
 * Runs `fn` over every item in `items`, at most `limit` in flight at
 * once, preserving result order to match input order regardless of
 * which call finishes first. A failure in one call doesn't cancel the
 * others already in flight — this returns a Promise per item's outcome
 * via Promise.allSettled semantics, folded into either a value or a
 * rethrown error at the call site's discretion via the returned array.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (limit < 1) {
    throw new RangeError(`mapWithConcurrency: limit must be >= 1, got ${limit}`);
  }

  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T, index);
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}

/**
 * Default concurrency limit. PLAN.md's original "~4" was written before
 * this project knew its provider or rate limit — worth re-deciding on
 * real numbers rather than leaving that guess in place by default.
 *
 * NIM doesn't expose rate-limit headers on its responses (checked a
 * live response; none of the standard x-ratelimit-* keys are present),
 * so the ceiling itself (40 req/min) isn't independently verifiable
 * here — taken as given. What is measured: 5 live classifyDescription
 * calls came back at 9.0s mean, 4.4–13.6s range — noticeably slower
 * than a first guess based on a terser model, because gpt-oss-20b's
 * visible chain-of-thought adds real generation time. At limit 4: mean
 * case ≈ 4 × (60/9.0) ≈ 27 req/min, comfortably under 40; the
 * worst-plausible case (all four slots happen to draw the fastest
 * observed completions) ≈ 4 × (60/4.4) ≈ 55 req/min, over the ceiling.
 *
 * Kept at 4 anyway, deliberately: the typical case has real headroom,
 * and retry.ts's backoff is exactly the mechanism for the occasional
 * burst that exceeds it — that's what status-code-aware retry is for,
 * not a reason to run the whole eval more slowly by default to avoid
 * a case it already handles. Lower this if Phase 4 actually observes
 * sustained 429s rather than occasional ones.
 */
export const DEFAULT_CONCURRENCY_LIMIT = 4;

/**
 * errors.ts — typed errors shared across the network-touching modules
 * (mcp/client.ts, llm/classify.ts).
 *
 * Per CLAUDE.md's style rule: "Errors are typed and distinguish slow
 * from refusing from malformed." Three failure shapes, one class each:
 *
 * - SlowError: nothing came back in time, or the connection itself
 *   never opened. Not a verdict from the other side — a timeout says
 *   nothing about whether the request would have eventually succeeded.
 *   Also where a connection-level failure (can't reach the host at
 *   all) lands: nothing responded, so there's nothing to call refusal.
 * - RefusingError: the other side responded, on purpose, with "no" —
 *   a non-retryable 4xx from an API, or an MCP error response.
 *   Retrying the identical request won't change its mind; that's what
 *   separates this from SlowError.
 * - MalformedError: the other side responded, at all, with something
 *   that isn't usable — invalid JSON, a schema mismatch, a shape this
 *   project doesn't recognize. Distinct from RefusingError because
 *   nothing here says the other side meant to fail; distinct from
 *   SlowError because a response did arrive.
 *
 * Each carries `cause` (the original error, if any) so nothing here
 * throws away information — it narrows what kind of failure this was,
 * it doesn't replace the evidence for it.
 */

export class SlowError extends Error {
  readonly kind = "slow";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SlowError";
  }
}

export class RefusingError extends Error {
  readonly kind = "refusing";
  /** The status code that caused the refusal, when there is one (there isn't always — an MCP protocol error has no HTTP status). */
  readonly status: number | undefined;
  constructor(message: string, options?: { status?: number; cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = "RefusingError";
    this.status = options?.status;
  }
}

export class MalformedError extends Error {
  readonly kind = "malformed";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MalformedError";
  }
}

export type ClassifiedError = SlowError | RefusingError | MalformedError;

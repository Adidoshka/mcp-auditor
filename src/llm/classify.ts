/**
 * llm/classify.ts — the one LLM node in this project.
 *
 * Per CLAUDE.md, its only job is deciding whether a tool description
 * contains instructions aimed at the reading agent. It does not
 * classify severity, does not label capabilities, does not write the
 * report — those stay in rules/ and report.ts.
 *
 * Input is the description text alone — not the schema, not the tool
 * name. rules/schema.ts already owns structural findings under the
 * "schema" mechanism; feeding the same tool's schema into this node
 * too would blur which mechanism produced a given finding, which is
 * exactly what CLAUDE.md's per-finding mechanism tag exists to keep
 * visible.
 *
 * The rubric this applies lives in prompts/v1.md, loaded from disk —
 * never inlined, so Phase 4 can diff v1 against v2 as separate,
 * versioned files rather than a code diff.
 *
 * `classifyDescription`'s optional `skills` are the one disclosed
 * exception to "description only": which skill(s) apply to a tool is
 * decided from its capability labels (schema shape and name) in
 * llm/skills.ts, not here — this function just concatenates whatever
 * skill text it's handed onto the system prompt. It doesn't select
 * skills itself, and it never sees the labels or the schema/name that
 * produced them, only the resulting text. See findings.ts's header for
 * why the selection still needs disclosing on the finding, and
 * llm/skills.ts's header for why selection lives there instead of
 * here.
 *
 * Retry, timeouts, and typed errors (Phase 3): every failure this
 * function can throw comes out as a SlowError, RefusingError, or
 * MalformedError (errors.ts) — never the SDK's own raw error, a bare
 * SyntaxError, or a bare ZodError, though those are still the `cause`.
 * Retry itself lives in retry.ts, not here or in the openai SDK's own
 * built-in retry — the client below sets `maxRetries: 0` specifically
 * because the SDK's default retry also retries 408 and 409 (both 4xx),
 * which would silently violate "never retry 4xx" the moment either
 * status showed up; see retry.ts's header for the full reasoning.
 * Concurrency isn't bounded here — a single classifyDescription call
 * has nothing to bound — that's concurrency.ts, for whoever calls this
 * many times at once (Phase 4's eval loop).
 *
 * Model: openai/gpt-oss-20b, served via NVIDIA NIM's OpenAI-compatible
 * endpoint — not a Claude model at all, so none of the Anthropic-specific
 * reasoning that used to live in this paragraph (Opus/Sonnet 5 rejecting
 * non-default temperature, Haiku 4.5 as the one that still takes it)
 * applies anymore; that was a constraint of Claude's current model
 * lineup, not of this project. An OpenAI-compatible chat-completions
 * endpoint takes `temperature` as an ordinary sampling parameter with
 * no such restriction, so Phase 4's "10 runs at temperature 0" doesn't
 * need a workaround here.
 *
 * (Two earlier picks didn't pan out, both confirmed rather than assumed:
 * meta/llama-3.3-70b-instruct isn't in this NIM account's catalog at
 * all (checked against a live `/v1/models` call), and
 * nvidia/llama-3.1-nemotron-70b-instruct *is* listed there but 404s on
 * every call with "Function ... Not found for account" — confirmed with
 * the exact id straight from that same `/v1/models` response, retried
 * twice, while an identical call shape against openai/gpt-oss-20b
 * returned 200 on the same key. That combination is NIM gating
 * Nemotron's specific "function" behind per-model account access not
 * yet granted here, not a bug in this file. gpt-oss-20b turned out to
 * be a reasonable landing spot on its own merits too, not just
 * availability: smaller models tend to be the best-behaved at strict
 * JSON output, which matters for a first end-to-end run where a schema
 * failure and a model-access failure would otherwise look the same.
 * deepseek-ai/deepseek-v4-pro-0813 remains the frontier-class comparison
 * point once this baseline is confirmed working — worth checking first
 * whether it 404s the same way Nemotron did, since if several models on
 * this account need access enabled individually, that shapes what the
 * comparison experiment can even run. See eval notes once Phase 4
 * exists.)
 *
 * Structured output: the Zod schema is the single source of truth,
 * converted to JSON Schema for the request via zod-to-json-schema —
 * but the response is independently validated with
 * InjectionVerdictSchema.parse() on the way back rather than trusted.
 * NIM's OpenAI-compatible `response_format: json_schema` is a request
 * to the model, not a guarantee the way Anthropic's typed
 * `output_config` is on its own API; the parse step is what actually
 * enforces the shape here, and it's why a failure here can be a
 * ZodError instead of only ever a malformed-JSON one.
 *
 * zod-to-json-schema needs a Zod v3-shaped schema to introspect
 * correctly — with Zod v4 installed (this project's version), building
 * InjectionVerdictSchema from the top-level "zod" import produces a
 * schema zod-to-json-schema can't see into (confirmed empirically: it
 * comes back as `{ "$schema": ... }` with no properties at all). Zod
 * ships a "zod/v3" compatibility entry point for exactly this — same
 * library, v3-shaped internals — so the schema below is built from
 * that import instead. `.parse()` and `.describe()` behave the same
 * either way; only the JSON Schema conversion needed this.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import OpenAI from "openai";
import { Agent, fetch as undiciFetch } from "undici";
import { z } from "zod/v3";
import { zodToJsonSchema } from "zod-to-json-schema";
import { loadSkillText } from "./skills.js";
import type { InjectionFinding, SkillName } from "../findings.js";
import { withRetry, isRetryableStatus } from "../retry.js";
import { SlowError, RefusingError, MalformedError, type ClassifiedError } from "../errors.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = join(__dirname, "prompts", "v1.md");

// See the file header for why this is an NVIDIA NIM-hosted open model
// rather than a Claude one, and why gpt-oss-20b specifically (Nemotron
// was the first choice; it 404s on this account).
const MODEL = "openai/gpt-oss-20b";
const NIM_BASE_URL = "https://integrate.api.nvidia.com/v1";

// Separate on purpose, per PLAN.md's Phase 3 bullet list: a dead
// connection and a slow-but-working generation are different failure
// modes and deserve different patience. CONNECT_TIMEOUT_MS bounds only
// opening the TCP/TLS connection — a live HTTPS endpoint should manage
// that in a few seconds; if it can't, the request layer's retry is a
// better response than waiting longer here. PER_CALL_TIMEOUT_MS bounds
// the whole request once connected, generous enough for gpt-oss-20b's
// visible chain-of-thought at max_tokens: 1024 (observed completions up
// to ~550 tokens in testing) plus room for a busy endpoint.
const CONNECT_TIMEOUT_MS = 5_000;
const PER_CALL_TIMEOUT_MS = 30_000;

const InjectionVerdictSchema = z.object({
  verdict: z
    .enum(["injected", "not_injected"])
    .describe(
      "Whether the description contains instructions aimed at the reading agent, per the definition given.",
    ),
  confidence: z.number().min(0).max(1).describe("Confidence in the verdict, from 0 to 1."),
  evidence: z
    .string()
    .describe(
      "The specific phrase or sentence the verdict rests on. Empty string if verdict is not_injected.",
    ),
});

export interface InjectionVerdict {
  verdict: "injected" | "not_injected";
  confidence: number;
  evidence: string;
}

// Converted once at module load, not per call — the schema is static.
// No `name` option: passing one wraps the output in a `$ref`/`definitions`
// pair (confirmed empirically), which is the right shape for recursive
// schemas but not for a flat, non-recursive object embedded directly as
// `response_format.json_schema.schema` below. `target: "openApi3"` drops
// the `$schema` meta key that a plain JSON Schema Draft-07 conversion
// would otherwise add, which OpenAI-compatible schema validation doesn't
// expect on the embedded schema either.
const injectionVerdictJsonSchema = zodToJsonSchema(InjectionVerdictSchema, {
  target: "openApi3",
});

let cachedPrompt: string | undefined;

/** Loads the injection rubric from disk. Never inlined — see the file header and CLAUDE.md. */
function loadPrompt(): string {
  if (cachedPrompt === undefined) {
    cachedPrompt = readFileSync(PROMPT_PATH, "utf-8");
  }
  return cachedPrompt;
}

const client = new OpenAI({
  apiKey: process.env.NVIDIA_API_KEY,
  baseURL: NIM_BASE_URL,
  // 0, not the SDK's default of 2 — see the file header and retry.ts:
  // the SDK's own retry logic retries 408/409 (4xx), which this
  // project's constraint 6 forbids. Every retry that happens here goes
  // through retry.ts's withRetry below instead.
  maxRetries: 0,
  timeout: PER_CALL_TIMEOUT_MS,
  // Node's global fetch and the `undici` package are different
  // instances of the same library, and the SDK's fetch call can't
  // recognize a dispatcher from one when using the other (confirmed
  // empirically: passing only `fetchOptions.dispatcher` throws
  // "Connection error... incompatible with the fetch implementation").
  // Passing `fetch` from `undici` alongside the `Agent` built from the
  // same import fixes it — exactly what the SDK's own client.ts doc
  // comment for this option recommends.
  fetch: undiciFetch as unknown as typeof fetch,
  fetchOptions: {
    dispatcher: new Agent({ connect: { timeout: CONNECT_TIMEOUT_MS } }),
  },
});

export interface ClassifyOptions {
  /**
   * Skill text to load alongside prompts/v1.md, keyed by name — see
   * llm/skills.ts for both the loading and the selection logic.
   * Concatenated in array order after the base rubric. Defaults to
   * none: a tool with no capability label gets no skill, not a
   * fallback default one.
   */
  skills?: readonly SkillName[];
  /**
   * Left unset by default (the model's own default applies) — Phase
   * 4's eval harness is the caller that has a reason to pass 0, for
   * its 10-identical-runs disagreement-rate measurement. Nothing here
   * decides that; it just doesn't block it.
   */
  temperature?: number;
}

/**
 * Classifies a single tool description against the rubric in
 * prompts/v1.md, optionally augmented by capability-specific skills.
 * Description only, as the thing being judged — see the file header
 * for why schema/name are deliberately excluded, and for why `skills`
 * is a disclosed exception rather than a violation of that.
 *
 * `max_tokens: 1024`, not the tighter budget a non-reasoning model would
 * need — confirmed empirically, not guessed. gpt-oss-20b emits visible
 * chain-of-thought (`reasoning_content`) that shares the same completion
 * budget as the final JSON, and at 256 tokens three of the ten fixture
 * tools came back `finish_reason: "length"` with the JSON cut off
 * mid-object — including both planted injections, the two cases where a
 * usable verdict matters most. 1024 cleared all three in repeated
 * testing.
 */
export async function classifyDescription(
  description: string,
  options: ClassifyOptions = {},
): Promise<InjectionVerdict> {
  const { skills = [], temperature } = options;
  const systemPrompt = [loadPrompt(), ...skills.map(loadSkillText)].join("\n\n---\n\n");

  try {
    const response = await withRetry(
      () =>
        client.chat.completions.create({
          model: MODEL,
          max_tokens: 1024,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: description },
          ],
          ...(temperature !== undefined ? { temperature } : {}),
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "injection_verdict",
              schema: injectionVerdictJsonSchema,
              strict: true,
            },
          },
        }),
      (error) => (error instanceof OpenAI.APIError ? error.status : undefined),
      { getRetryAfterMs: (error) => getRetryAfterMs(error) },
    );

    const content = response.choices[0]?.message?.content;
    if (content === null || content === undefined) {
      throw new Error("classifyDescription: response had no message content");
    }

    // Parsed, then validated against the same schema the request was
    // built from — see the file header for why this doesn't just trust
    // response_format to have been honored.
    return InjectionVerdictSchema.parse(JSON.parse(content));
  } catch (error) {
    throw toClassifiedError(error);
  }
}

/** Reads a server-supplied retry delay off an OpenAI SDK error, when there is one — see retry.ts's header for why this is preferred over a computed backoff when available. */
function getRetryAfterMs(error: unknown): number | undefined {
  if (!(error instanceof OpenAI.APIError) || error.headers === undefined) return undefined;
  const headerMs = error.headers.get("retry-after-ms");
  if (headerMs !== null) {
    const parsed = Number.parseFloat(headerMs);
    if (Number.isFinite(parsed)) return parsed;
  }
  const headerSeconds = error.headers.get("retry-after");
  if (headerSeconds !== null) {
    const parsedSeconds = Number.parseFloat(headerSeconds);
    if (Number.isFinite(parsedSeconds)) return parsedSeconds * 1000;
  }
  return undefined;
}

/**
 * Maps whatever classifyDescription's body can throw into one of
 * errors.ts's three kinds — see this file's header and errors.ts's own
 * header for the reasoning behind each bucket. A status that's
 * retryable but still failing here means retries were already
 * exhausted by withRetry above; that's a SlowError (the endpoint is
 * overloaded or rate-limiting, not refusing on principle), where a
 * non-retryable 4xx is a RefusingError instead.
 */
function toClassifiedError(error: unknown): ClassifiedError {
  if (error instanceof z.ZodError) {
    return new MalformedError(
      "classifyDescription: response did not match InjectionVerdictSchema",
      { cause: error },
    );
  }
  if (error instanceof SyntaxError) {
    return new MalformedError("classifyDescription: response body was not valid JSON", {
      cause: error,
    });
  }
  if (error instanceof OpenAI.APIConnectionError) {
    // Covers APIConnectionTimeoutError too (it extends this) — either
    // way, nothing responded, so there's nothing to call a refusal.
    return new SlowError("classifyDescription: could not reach NVIDIA NIM", { cause: error });
  }
  if (error instanceof OpenAI.APIError) {
    const status = error.status;
    if (status !== undefined && isRetryableStatus(status)) {
      return new SlowError(
        `classifyDescription: NIM kept returning ${status} after retries`,
        { cause: error },
      );
    }
    return new RefusingError(
      `classifyDescription: NIM refused the request (status ${status ?? "unknown"})`,
      { status, cause: error },
    );
  }
  // Anything else — including the plain Error above for missing
  // content — is neither a network condition nor a definitive refusal,
  // so it's treated as malformed rather than guessed at.
  return new MalformedError("classifyDescription: unexpected failure", { cause: error });
}

/**
 * Shapes a verdict into a Finding, recording which skill(s) (if any)
 * were loaded for the call — see findings.ts's header for why that's
 * disclosed rather than implicit. Returns null for a not_injected
 * verdict, same convention rules/schema.ts and rules/capability.ts
 * follow: a Finding is something to report, not a per-tool record that
 * nothing was wrong. No model call here, no new decision — this only
 * packages a decision classifyDescription already made.
 */
export function buildInjectionFinding(
  tool: string,
  verdict: InjectionVerdict,
  skills: readonly SkillName[],
): InjectionFinding | null {
  if (verdict.verdict !== "injected") return null;
  return {
    mechanism: "llm",
    tool,
    confidence: verdict.confidence,
    evidence: verdict.evidence,
    skills,
    detail: `${tool}: injected instructions detected${skills.length > 0 ? ` (skills: ${skills.join(", ")})` : ""}.`,
  };
}

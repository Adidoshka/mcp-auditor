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
 * No retry, no timeout, no concurrency limit here — that's Phase 3.
 * A failed call just throws — the SDK's own error for a transport or
 * status-code failure, a SyntaxError if the response body isn't valid
 * JSON, or a ZodError if it's JSON but doesn't match the schema. All
 * three are "the call failed," left for the caller to sort out; Phase
 * 3 is where that gets typed into slow/refusing/malformed.
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
import { z } from "zod/v3";
import { zodToJsonSchema } from "zod-to-json-schema";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = join(__dirname, "prompts", "v1.md");

// See the file header for why this is an NVIDIA NIM-hosted open model
// rather than a Claude one, and why gpt-oss-20b specifically (Nemotron
// was the first choice; it 404s on this account).
const MODEL = "openai/gpt-oss-20b";
const NIM_BASE_URL = "https://integrate.api.nvidia.com/v1";

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
});

/**
 * Classifies a single tool description against the rubric in
 * prompts/v1.md. Description only, as input — see the file header for
 * why schema is deliberately excluded.
 *
 * `temperature` is optional and left unset by default (the model's own
 * default applies) — Phase 4's eval harness is the caller that has a
 * reason to pass 0, for its 10-identical-runs disagreement-rate
 * measurement. Nothing here decides that; it just doesn't block it.
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
  temperature?: number,
): Promise<InjectionVerdict> {
  const response = await client.chat.completions.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [
      { role: "system", content: loadPrompt() },
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
  });

  const content = response.choices[0]?.message?.content;
  if (content === null || content === undefined) {
    throw new Error("classifyDescription: response had no message content");
  }

  // Parsed, then validated against the same schema the request was built
  // from — see the file header for why this doesn't just trust
  // response_format to have been honored.
  return InjectionVerdictSchema.parse(JSON.parse(content));
}

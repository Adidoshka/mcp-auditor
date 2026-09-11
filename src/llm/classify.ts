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
 * A failed call just throws; the caller sees the SDK's own typed
 * error.
 *
 * Model: Claude Haiku 4.5, not the newer Opus/Sonnet 5 this project
 * otherwise defaults to. This call is a short, narrow classification
 * repeated 10x per tool across every tool in the eval — exactly the
 * workload a fast, cheap model is for, not a reason to pay for
 * frontier reasoning it doesn't need. It also happens to be forced:
 * verified against the current Opus 5 and Haiku 4.5 migration guides,
 * Opus 5 and Sonnet 5 reject any non-default `temperature`/`top_p`/
 * `top_k` with a 400, which would make PLAN.md's "10 runs at
 * temperature 0" impossible on either — Haiku 4.5 predates that
 * removal and still takes `temperature` normally. One consequence of
 * picking a model this old: `effort` isn't a supported parameter on
 * it, so it's omitted below rather than set.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = join(__dirname, "prompts", "v1.md");

// See the file header for why this isn't the project's usual Opus 5 default.
const MODEL = "claude-haiku-4-5";

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

let cachedPrompt: string | undefined;

/** Loads the injection rubric from disk. Never inlined — see the file header and CLAUDE.md. */
function loadPrompt(): string {
  if (cachedPrompt === undefined) {
    cachedPrompt = readFileSync(PROMPT_PATH, "utf-8");
  }
  return cachedPrompt;
}

const client = new Anthropic();

/**
 * Classifies a single tool description against the rubric in
 * prompts/v1.md. Description only, as input — see the file header for
 * why schema is deliberately excluded.
 *
 * `temperature` is optional and left unset by default (the model's own
 * default applies) — Phase 4's eval harness is the caller that has a
 * reason to pass 0, for its 10-identical-runs disagreement-rate
 * measurement. Nothing here decides that; it just doesn't block it.
 */
export async function classifyDescription(
  description: string,
  temperature?: number,
): Promise<InjectionVerdict> {
  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 256,
    system: loadPrompt(),
    messages: [{ role: "user", content: description }],
    ...(temperature !== undefined ? { temperature } : {}),
    output_config: {
      format: zodOutputFormat(InjectionVerdictSchema),
    },
  });

  if (response.parsed_output === null) {
    throw new Error("classifyDescription: response did not match the expected schema");
  }

  return response.parsed_output;
}

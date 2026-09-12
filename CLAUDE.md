# CLAUDE.md

Working notes for `mcp-auditor`. Read `PLAN.md` for the full plan; this file holds the constraints that are easy to erode.

## What this project is

A CLI that audits an MCP server's exposed tools for risks to the agent connecting to it. Three finding types: injected instructions in tool descriptions, capability chains between tools, and overbroad parameters.

This is a portfolio project. It is being built to be **explained**, not just to work. A design choice I can't justify out loud is worse than a missing feature.

## Stack

- TypeScript
- MCP TypeScript SDK
- LangGraph (JS) — added in Phase 5, not before
- Classifier model: `openai/gpt-oss-20b`, served via NVIDIA NIM's OpenAI-compatible endpoint (`https://integrate.api.nvidia.com/v1`, key in `NVIDIA_API_KEY`) — not Anthropic. Switched off Claude when the Anthropic account ran out of credit; landed here after two other picks didn't pan out (`meta/llama-3.3-70b-instruct` isn't in this NIM account's catalog, `nvidia/llama-3.1-nemotron-70b-instruct` is listed but 404s — account access not granted). Right-sized for a short repeated classification either way; full story in `classify.ts`'s header and `eval/results.md`.
- No web UI

## Hard constraints

These are the rules that make the project's argument work. Don't break them for convenience.

1. **Phase 1 code contains zero model calls.** Schema checks and capability chain detection are deterministic. If something seems to need a model here, it belongs in Phase 2 instead — flag it, don't inline it.

2. **Prompts live in files under `src/llm/prompts/`, versioned (`v1.md`, `v2.md`).** Never inline a prompt string in code. Phase 4 compares versions and needs them to be separable artifacts.

3. **Every finding records which mechanism produced it** — `schema` | `capability` | `llm`. The report must make it visible how many findings came from deterministic rules versus the model.

4. **The LLM node has exactly one job:** decide whether a tool description contains instructions aimed at the reading agent. It does not classify severity, does not label capabilities, does not write the report. If a new job appears, that's a signal to reach for a rule.

5. **The classifier sees the description only** — not the schema, not the tool name. Rules read structure; the model reads text. Mixing the inputs blurs which mechanism produced a finding.

6. **Retry policy is explicit and status-code aware.** Retry with exponential backoff on 429 and 5xx. Never retry 4xx. Timeouts are set per call, separately from connection timeouts.

7. **`ground-truth.yaml` is never edited to match the classifier's output.** It's the labels. If the classifier disagrees, that's a result, not a bug in the labels.

8. **Self-checks are not verification.** If you draft something and then grade it against your own draft, say so plainly — that shows internal consistency, not correctness. It never goes into `results.md` framed as validation.

## Build order

Phases run in the order in `PLAN.md`. Don't skip ahead — particularly, don't scaffold the LangGraph wiring before Phases 1–4 work standalone. The graph is added last so that each node, edge, and interrupt exists for an observed reason.

When starting a session, work on **one phase at a time**. Ask which phase before making changes across several.

## Things I decide

These are the calls I'll be asked about in the presentation, so the reasoning has to be mine. **Drafting them is fine — deciding them silently isn't.** When one comes up: propose a version, lay out the alternatives you rejected and why, and wait for me to accept or change it. Don't write it into a file until I've said go.

| Decision | Status |
| --- | --- |
| The subtle injection in `target-server/server.ts` | done — `compile_account_summary` |
| Capability labeling rules in `rules/capability.ts` | done — schema shape first, name second, description never |
| The definition of "injection" in `prompts/v1.md` | done — addressee framing ("descriptions describe; injections advise") plus a deletion test, as the definition itself; bullets/examples are illustrations only |
| Retry policy values and status-code handling | done — delegated explicitly rather than drafted-and-approved: 3 attempts, 500ms base/8s cap exponential backoff with full jitter, retry only on 429/5xx (never 408/409, which the openai SDK's own default retry gets wrong), `Retry-After` honored when present; see `retry.ts` |
| The graph's edges and routing conditions | open (Phase 5) |

Boilerplate around these is fine to generate — the decisions inside them aren't.

## Reporting

End any turn that touches files with a plain list of what changed, file by file, one clause each. Keep it alongside the explanation, not instead of it.

## Style

- Prefer small pure functions over classes
- Explicit types on module boundaries; inference inside is fine
- No `any`
- Errors are typed and distinguish *slow* from *refusing* from *malformed*
- Comments explain *why*, not *what*

## Current phase

All five phases from PLAN.md now have a working first pass — **Phase 5** just closed. What's actually open is the `v2.md` decision below, not a phase.

Done: Phase 0 (10-tool target server + ground truth, extended to 11 in Phase 2), Phase 1, Phase 2, Phase 3, Phase 4 (see `eval/results.md` — field-order fix tested in isolation: recall 90%→93.3%, disagreement rate unchanged at 9.1%, a real partial improvement not a cure). Phase 5: `graph/state.ts`, `graph/nodes.ts`, `graph/graph.ts`, `graph/probeArgs.ts`, `report.ts` (named since Phase 0, never built until now), `cli.ts`. Fan-out via `Send`, conditional routing (chain-finding sources + injected tools → deep branch — kept exactly as literally stated, not tightened, since every tightening needs a confidence field `capability.ts` doesn't have), `interrupt()` gating a real invocation (not the stubbed version PLAN.md's cut list allowed), `SqliteSaver` for durable checkpointing. Kill-and-resume run for real through the actual CLI, not just verified in isolated mechanics: process killed mid-approval-loop, a genuinely separate process resumed the same thread 5 seconds later ("Resuming a prior run — found 6 pending step(s) on disk") — too fast to have redone any of the 11 classify calls, confirming the expensive analysis phase survived the kill.

Four real bugs found and fixed while building this, not written around: a node/state name collision LangGraph rejected outright; LangGraph's `maxConcurrency` config option is never actually read by Pregel's own execution loop (confirmed by reading the source) — an unthrottled fan-out produced a real NIM connection timeout, fixed with a proper `Semaphore` in `concurrency.ts`; `node:readline/promises`'s `question()` stalls forever on its second call against piped stdin (a Node bug, not this code); a malformed-JSON classify response was crashing the whole graph run until `analyzeTool` got the same per-task error-resilience `eval/run.ts` already had.

In progress: whether to write `v2.md` targeting the remaining scope-of-function judgment issue in `compile_account_summary` — not yet decided, per "Things I decide."

Not started: nothing from PLAN.md's five phases. The cut-list sandboxed-probe item was *not* cut — built for real per an explicit decision to do so.

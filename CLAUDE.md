# CLAUDE.md

Working notes for `mcp-auditor`. Read `PLAN.md` for the full plan; this file holds the constraints that are easy to erode.

## What this project is

A CLI that audits an MCP server's exposed tools for risks to the agent connecting to it. Three finding types: injected instructions in tool descriptions, capability chains between tools, and overbroad parameters.

This is a portfolio project. It is being built to be **explained**, not just to work. A design choice I can't justify out loud is worse than a missing feature.

## Stack

- TypeScript
- MCP TypeScript SDK
- LangGraph (JS) — added in Phase 5, not before
- No web UI

## Hard constraints

These are the rules that make the project's argument work. Don't break them for convenience.

1. **Phase 1 code contains zero model calls.** Schema checks and capability chain detection are deterministic. If something seems to need a model here, it belongs in Phase 2 instead — flag it, don't inline it.

2. **Prompts live in files under `src/llm/prompts/`, versioned (`v1.md`, `v2.md`).** Never inline a prompt string in code. Phase 4 compares versions and needs them to be separable artifacts.

3. **Every finding records which mechanism produced it** — `schema` | `capability` | `llm`. The report must make it visible how many findings came from deterministic rules versus the model.

4. **The LLM node has exactly one job:** decide whether a tool description contains instructions aimed at the reading agent. It does not classify severity, does not label capabilities, does not write the report. If a new job appears, that's a signal to reach for a rule.

5. **Retry policy is explicit and status-code aware.** Retry with exponential backoff on 429 and 5xx. Never retry 4xx. Timeouts are set per call, separately from connection timeouts.

6. **`ground-truth.yaml` is never edited to match the classifier's output.** It's the labels. If the classifier disagrees, that's a result, not a bug in the labels.

## Build order

Phases run in the order in `PLAN.md`. Don't skip ahead — particularly, don't scaffold the LangGraph wiring before Phases 1–4 work standalone. The graph is added last so that each node, edge, and interrupt exists for an observed reason.

When starting a session, work on **one phase at a time**. Ask which phase before making changes across several.

## Things I write myself

Do not generate these; ask me for them if they're missing:

- The subtle injection in `target-server/server.ts`
- The capability labeling rules in `rules/capability.ts`
- The definition of "injection" in the prompt
- The retry policy values and status-code handling
- The graph's edges and routing conditions in Phase 5

Boilerplate around these is fine to generate — the decisions inside them aren't.

## Style

- Prefer small pure functions over classes
- Explicit types on module boundaries; inference inside is fine
- No `any`
- Errors are typed and distinguish *slow* from *refusing* from *malformed*
- Comments explain *why*, not *what*

## Current phase

Phase 0 — target server and ground truth.

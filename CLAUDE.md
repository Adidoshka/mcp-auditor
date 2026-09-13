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
| The graph's edges and routing conditions | done (Phase 5) |
| The `v2.md` injection boundary | done — guidance about using this tool is descriptive; directions to act outside its declared interface are injected |
| The `v3.md` revisions | done — delimits the description as data (`<tool_description>` tags, wrapped unconditionally in every prompt version so v1/v2/v3 stay comparable), states the "Use this before X" vs. "Before using this, do X" distinction explicitly, and treats imperative mood as descriptive by default; examples drawn from two live-server false positives but domain-shifted so v3 isn't just pattern-matching the servers that prompted it. Run against all four servers (fixture, filesystem, memory, `server-everything`) — see `eval/results.md` for what each did and didn't show |
| Default `--prompt-version` for `cli.ts`/`nodes.ts` | done — `v3`, on the strength of it fixing v2's two diagnosed live-server false positives and 0 false positives on the entirely unseen `server-everything`; v1/v2 stay selectable and are what `eval/run.ts`'s frozen protocol still measures |

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

All five phases from PLAN.md and the fixture-first `v2.md` follow-up are complete.

Done: Phase 0 (10-tool target server + ground truth, extended to 11 in Phase 2 and 12 for the Phase 4 follow-up), Phase 1, Phase 2, Phase 3, Phase 4 (see `eval/results.md` — field-order fix tested in isolation: recall 90%→93.3%, then the frozen v2 follow-up scored 100% precision and recall across 110 successful calls with 10/120 call errors), and Phase 5. Phase 5 added `graph/state.ts`, `graph/nodes.ts`, `graph/graph.ts`, `graph/probeArgs.ts`, `report.ts`, and `cli.ts`. Fan-out uses `Send`; conditional routing sends chain-finding sources plus injected tools to the deep branch; `interrupt()` gates a real invocation; `SqliteSaver` provides durable checkpointing. Kill-and-resume was exercised through the real CLI: a separate process resumed six pending steps without repeating the 11 completed classify calls.

Real mistakes found by building and running this, not written around — grouped by kind rather than just counted, since "what kind of mistake" is the more useful question for a presentation than "how many":

- **Upstream** (someone else's, found only by running it): LangGraph's `maxConcurrency` `RunnableConfig` option is never actually read by Pregel's own execution loop (confirmed by reading the source, not assumed) — an unthrottled fan-out produced a real NIM connection timeout, fixed with a proper `Semaphore` in `concurrency.ts`. `node:readline/promises`'s `question()` stalls forever on its second call against piped stdin — a Node bug, reproduced with a two-line minimal case, not specific to this file.
- **Measurement** (the thing being measured wasn't what it looked like — the most interesting group, since both would have produced confidently wrong numbers): a 256-token `max_tokens` budget silently truncated 3 of Phase 2's 10 fixture tools mid-JSON, including both planted injections, which would have made the injection numbers look worse than the prompt actually was for a reason unrelated to the prompt (raised to 1024, confirmed empirically). Separately, `analyzeTool` never passed a `promptVersion`, so the shipped CLI classified against v1 while `eval/run.ts` was measuring v2 — caught by comparing a live run's findings against the frozen v2 eval's predictions for the same tools, not by reading the two call sites side by side.
- **Safety** (wrong behavior against a target it shouldn't apply to): `probeArgs.ts`'s curated deep-probe arguments were keyed on tool name alone, with no check that the connected server was actually `target-server` — pointing `--target` at any server with a same-named tool (e.g. `send_email_notification`) would have fired the real curated recipient/subject/body against it. `interrupt()` was always the actual gate; the fix (`isTargetServerInvocation`, checked against the spawn command) closes the gap the file's own header comment had already claimed was closed.
- **Resilience** (one failure taking down more than itself): a malformed-JSON classify response was crashing the whole graph run until `analyzeTool` got the same per-task error-resilience `eval/run.ts` already had.
- **Drift** (docs or validation quietly falling out of sync with the code they describe, each caught by checking rather than assuming): `mapWithConcurrency`'s doc comment claimed `Promise.allSettled`-style per-item resilience that never existed — reproduced directly (8 items, limit 2, item 2 throws → only items 1–2 ever attempted), then rewritten to match the real fail-fast behavior. `eval/run.ts`'s own prompt-version check still hardcoded `"v1"`/`"v2"` after `v3.md` shipped, so `eval/run.ts v3` would have thrown despite v3 working everywhere else — fixed by exporting `PROMPT_VERSIONS` from `classify.ts` as the one list both `cli.ts` and `eval/run.ts` now validate against, instead of two hand-maintained copies.

One more, deliberately not counted above: naming a graph node and a state field both `"report"` was rejected outright by LangGraph at build time. That's a framework constraint learned by hitting it, not a defect in anyone's code — nothing ever ran incorrectly, so it doesn't belong in the same list as the five real mistakes above.

The v2 follow-up added the honest `list_documents` control before prompt revision, then ran v1 and v2 once each without post-result tuning. V1 flagged the control 10/10; every successful v2 call across all 12 tools matched ground truth. Full limitations, including 10 slow failures in each run, are recorded in `eval/results.md`. A `v3.md` follow-up then closed both diagnosed v2 false positives and was run once against a server none of the three prompt versions had seen (`@modelcontextprotocol/server-everything`) with zero false positives and zero classify errors across all 13 tools — real evidence against v3's specific failure mode (imperative phrasing alone triggering a false positive) on unfamiliar phrasing, though not a test of recall, since that server has no injected tool to catch. Full detail in `eval/results.md`.

Not started: nothing from PLAN.md's five phases. The cut-list sandboxed-probe item was *not* cut — built for real per an explicit decision to do so.

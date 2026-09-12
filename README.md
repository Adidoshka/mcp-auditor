# mcp-auditor

A CLI that audits an MCP server's exposed tools for risks to the agent
connecting to it — before that agent ever calls one of them.

## Why

I spent months studying MCP servers from the attacker's side: honeypot
research, ~6,700 observed requests. This project asks the same question
from the other seat — what should an agent check about a server *before*
it decides to trust it?

Three finding types, one for each way a tool can be dangerous without
being an obvious exploit:

- **Injected instructions** — a tool description that talks to the
  *agent* reading it, not just to the human calling the tool.
- **Capability chains** — two individually-harmless tools where one's
  output could feed the other's input (a reader, and something that
  sends data out).
- **Overbroad parameters** — a schema that accepts more than the tool's
  job requires.

## The argument

**The LLM does exactly one thing in this system, and this project can
explain why nothing else needs it.** Everything that can be decided
from a tool's schema and name — capability labeling, chain detection,
overbroad-parameter checks — is deterministic code with zero model
calls. The model is asked a single, narrow question: does this
description contain instructions aimed at the agent reading it? It
doesn't label capabilities, judge severity, or write the report.

That split isn't just tidy architecture — it's measured. On the
11-tool fixture this project ships with, **10 of the findings a full
audit produces come from deterministic rules alone**, before any model
is involved:

| Mechanism | Findings | True positives | False positives |
|---|---|---|---|
| `schema` | 6 | 2 | 4 |
| `capability` | 4 | 4 | 0 |
| **Total (0 model calls)** | **10** | **6** | **4** |

The one thing rules structurally can't catch — description text lying
about what a tool does — is what the LLM node exists for. Both planted
injections in this fixture are on tools whose *code* touches nothing
suspicious at all; a schema/name-based labeler has nothing to flag on
them by construction. That gap is the LLM node's actual job, stated
precisely, not "AI reviews everything just in case."

Full numbers, including the unflattering ones (the schema rule's 33%
precision is load-bearing, not a bug — see why in
[eval/results.md](eval/results.md)) and the classifier's real
accuracy/consistency numbers, are in that file.

## Results, in one table

| Phase | Result |
|---|---|
| 1 — deterministic rules | 10 findings, 11 tools, 0 model calls |
| 2 — LLM node + skills | Both injections caught; skills mechanism built, then found capability-blind to both existing injections, fixed by extending the fixture |
| 3 — retry/timeout/errors | Pointed at a real server neither person here wrote (`@modelcontextprotocol/server-filesystem`) — found a real false positive in the capability rule, documented rather than patched |
| 4 — evaluation | Precision 100%, recall 93.3% (up from 90% after a tested structural fix), disagreement rate 9.1% — one tool gave different verdicts on identical input at temperature 0 |
| 5 — LangGraph | Fan-out, conditional routing, a real `interrupt()` gate on a real tool invocation, kill-and-resume proven live: a killed process's progress recovered from disk in 5 seconds — not enough time to redo even one of the eleven model calls that work represents |

Every number above is reproducible — see [Quick start](#quick-start) —
and every one of them is explained, including the ones that aren't
flattering, in [eval/results.md](eval/results.md).

## Quick start

```
npm install
npm run target-server   # the fixture MCP server, standalone
npm run eval             # Phase 4: 10 runs x 11 tools, precision/recall/disagreement
npm run audit             # Phase 5: the full graph, interactively
```

`npm run audit` needs `NVIDIA_API_KEY` in `.env` (see `.env.example`) —
the classifier runs on `openai/gpt-oss-20b` via NVIDIA NIM's
OpenAI-compatible endpoint. It will pause for your approval before
invoking any flagged tool for real; `--out <path>` also saves the
final report to a file. A real captured run of each is checked in:

- [eval/example-report.txt](eval/example-report.txt) — a full audit
  report, every flagged tool approved and actually invoked
- [eval/kill-resume.txt](eval/kill-resume.txt) — unedited terminal
  output from the kill-and-resume run, timestamps included

## Layout

```
target-server/            the fixture MCP server under audit
  server.ts                  11 tools: honest, injected, and a planted capability chain
  ground-truth.yaml           labels for every tool, written before detection code existed
src/
  mcp/client.ts             connect, list tools, invoke one for real (Phase 5's deep probe)
  rules/                    deterministic schema + capability checks — zero model calls
  llm/                      the one LLM node, its versioned prompts, and skill playbooks
  errors.ts, retry.ts,      typed errors and a status-code-aware retry policy
  concurrency.ts             (429/5xx only — the openai SDK's own default retries 408/409, which are 4xx)
  graph/                    the LangGraph wiring: fan-out, routing, interrupt, checkpoint
  report.ts, cli.ts          formats findings into a report; the runnable entrypoint
eval/
  run.ts                    the real eval loop (Phase 4's protocol)
  results.md                 the full writeup — every phase, including what it gets wrong
```

## Status

All five phases in [PLAN.md](PLAN.md) have a working first pass.
[CLAUDE.md](CLAUDE.md) tracks the decisions reserved for me rather than
generated, and the constraints that keep the architecture's argument
intact. The one open item is whether a `v2.md` prompt revision is worth
writing — see `eval/results.md`'s Phase 4 section for what it would
target and why it's optional rather than blocking.

**Known limitation, stated up front:** every number here comes from
one 11-tool fixture, mostly written by the same person who wrote the
rules being scored against it (Phase 3's real-server test is the one
exception). This demonstrates a method, not a benchmark — real numbers
would need hundreds of labeled cases across servers nobody involved
built.

# mcp-auditor — MCP Tool Risk Auditor

![TypeScript](https://img.shields.io/badge/typescript-7.0+-blue)
![MCP](https://img.shields.io/badge/MCP-SDK%201.30+-purple)
![LangGraph](https://img.shields.io/badge/LangGraph-1.4+-1C3C3C)
![Evaluation](https://img.shields.io/badge/eval-fixture--specific-informational)
![License](https://img.shields.io/badge/license-portfolio-orange)

## 🎯 Overview

A CLI that audits an MCP server's exposed tools for risks to the **agent** connecting to it — before that agent ever calls one of them. Three finding types:

- **Injected instructions** — a description that talks to the agent reading it, not just the human calling the tool
- **Capability chains** — two harmless tools where one's output could feed the other's input (a reader, and something that sends data out)
- **Overbroad parameters** — a schema that accepts more than the tool's job requires

**The argument:** everything decidable from a tool's schema and name is deterministic code — zero model calls. The model is asked one narrow question per tool: does this description contain instructions aimed at the agent? The description is the only text being judged; which guidance the model gets alongside it is selected deterministically from schema and name.

## 🚀 Quick Start

```bash
npm install
cp .env.example .env   # add NVIDIA_API_KEY — free tier at build.nvidia.com

npm run target-server  # optional: the fixture server on its own
npm run eval            # Phase 4: precision / recall / disagreement rate
npm run audit           # the full LangGraph pipeline, interactive
```

`npm run audit` pauses for your approval (`y`/`N`) before invoking any flagged tool for real. Add `--out report.html` to save the report, `--prompt-version v1|v2|v3` to pick the injection rubric (default `v2`), `--thread <name>` to make the run resumable — rerunning an interrupted thread picks up where it left off. A bare `--out` filename files itself under `results/<prompt-version>/` automatically (e.g. `--out report.html --prompt-version v2` writes `results/v2/report.html`); a path containing a separator is written exactly as given instead. A completed thread cannot be reused; choose a new thread name for each new audit.

To audit another stdio server, put auditor options first and the server command last: `npm run audit -- --thread filesystem-demo --target npx -y @modelcontextprotocol/server-filesystem C:\path\to\audit`. Everything after the `--target` command is passed to that server; without `--target`, the bundled fixture is used.

Captured runs, no setup needed: [results/v1/example.html](results/v1/example.html) (the visual report), [results/v1/example.txt](results/v1/example.txt) (plain text), and [eval/kill-resume.txt](eval/kill-resume.txt) (a real kill-and-resume). More sample runs, by prompt version, under [results/v1/](results/v1/) and [results/v2/](results/v2/).

## 📐 Architecture

```text
target-server/server.ts  (12-tool fixture, stdio)
          │ tools/list
          ▼
   src/mcp/client.ts  (connect, list, invoke — 0 model calls)
          │
   ┌──────┴───────────────────┐
   ▼                          ▼
src/rules/            src/llm/classify.ts
 schema.ts              + prompts/v1.md, v2.md, v3.md
 capability.ts          (NVIDIA NIM,
 0 model calls           gpt-oss-20b)
   └──────────┬───────────────┘
              ▼
    src/graph/*.ts (LangGraph)
    fan-out → collect → conditional routing
              │ interrupt() — human approval
              ▼
    deepProbe → callTool  (real invocation, approved only)
              ▼
    src/report.ts  (findings by mechanism: schema | capability | llm)
```

1. **List** — connect over stdio, `tools/list`, close.
2. **Rules** — schema + capability checks on every tool, zero model calls.
3. **Classify** — one model call per tool; the description is judged using guidance selected deterministically from schema and name.
4. **Collect** — flags any chain source, or any LLM-injected tool.
5. **Deep probe** — on approval only, actually invokes a flagged tool to see what it does.
6. **Report** — findings grouped by the mechanism that produced them.

## 📁 Project Structure

```text
mcp-auditor/
├── target-server/
│   ├── server.ts             # 12 tools: honest, injected, planted chain
│   └── ground-truth.yaml     # labels, written before detection code existed
├── src/
│   ├── mcp/client.ts          # connect, list, invoke — 0 model calls
│   ├── rules/
│   │   ├── schema.ts           # unconstrained-parameter checks
│   │   └── capability.ts       # capability labeling + chain detection
│   ├── llm/
│   │   ├── classify.ts         # the one LLM node
│   │   ├── skills.ts           # skill loading + selection
│   │   └── prompts/            # versioned v1/v2/v3 injection rubrics
│   ├── skills/                # per-capability audit playbooks
│   ├── graph/                 # state, nodes, wiring, probe-arg synthesis
│   ├── findings.ts             # shared Finding type, tagged by mechanism
│   ├── errors.ts, retry.ts, concurrency.ts
│   ├── report.ts
│   └── cli.ts                 # entrypoint
├── eval/
│   ├── run.ts                 # 10 runs x 12 tools, precision/recall/disagreement
│   ├── results.md              # full writeup, every phase, incl. what's wrong
│   └── kill-resume.txt
├── results/                   # cli.ts --out reports, one subfolder per prompts/*.md version
├── PLAN.md                    # the five-phase build plan
└── CLAUDE.md                  # constraints + decisions reserved for the author
```

## 🔧 Components

| Component | Files | What it does |
| --------- | ----- | -------------- |
| **Target fixture** | `target-server/` | 12-tool server: 9 honest, 3 injected, with planted `reads_local → writes_external` chains |
| **Deterministic rules** | `src/rules/` | Schema: flags unconstrained strings (naive on purpose — 2/6 precision, and that gap is the argument for the LLM node). Capability: labels tools from schema shape then name, **never** description; full cross-product chain detection |
| **LLM node** | `src/llm/` | One job: injected or not, from description text alone. Structured output re-validated, not trusted. `evidence` stays before `verdict` because that matches the intended reasoning order; its observed 90%→93.3% movement was smaller than later run-to-run variance, so it is not established as causal. Skills load from capability labels, never the description being judged |
| **LangGraph orchestration** | `src/graph/` | Fan-out via `Send`, `collect` decides flagged tools, `interrupt()` gates the one real side effect, `SqliteSaver` checkpoints so a killed run resumes from disk |
| **Errors/retry/concurrency** | `src/errors.ts`, `retry.ts`, `concurrency.ts` | `SlowError` / `RefusingError` / `MalformedError`; backoff on `{429}∪[500,599]` only; shared `Semaphore` (LangGraph's own `maxConcurrency` is dead code — confirmed by reading its source) |
| **Evaluation harness** | `eval/` | 10 runs × 12 tools at temperature 0: precision, recall, and disagreement rate (how often identical input flips verdict) |

## 🛠️ Target Fixture Tools

| Tool | Ground truth |
| ---- | -------------- |
| `get_weather`, `convert_currency`, `get_current_time`, `roll_dice` | honest, no issues |
| `list_documents` | honest usage guidance, no deterministic findings |
| `search_notes`, `read_document`, `read_config_value`* | honest, chain source |
| `send_email_notification`* | honest, chain sink |
| `generate_expense_summary` | injected — explicit imperative |
| `compile_account_summary` | injected — convention framing |
| `read_user_settings` | injected + chain source (closes a fixture gap: the two tools above are capability-blind) |

\* planted source→sink pair

## 📊 Results

| Phase | Result |
| ----- | ------ |
| 1 — deterministic rules | 10 findings / historical 11-tool fixture, **0 model calls** (6 schema: 2 TP, 4 FP · 4 capability: 4 TP, 0 FP) |
| 2 — LLM node + skills | Both injections caught |
| 3 — retry/timeouts | Pointed at a real server (`@modelcontextprotocol/server-filesystem`) — found a real capability-labeling false positive |
| 4 — evaluation | One frozen v2 run on this fixture: precision **100%** (30/30), recall **100%** (30/30), disagreement **0%** (0/12 tools), with **10/120 call errors**; repeated v1 baselines varied by 7.1 recall points |
| 5 — LangGraph | `interrupt()` gate + kill-and-resume proven live — 5s to recover, faster than any single classify call |

The schema rule's low precision is load-bearing: two injections sit on tools whose code touches nothing suspicious, so a schema/name-based labeler has nothing to flag by construction — that gap is what the LLM node closes. V1's remaining hard case was `compile_account_summary`; the fixture-first v2 follow-up corrected it and the new benign-guidance control in one frozen run, while 10 slow calls still produced no verdict. Full breakdown: [eval/results.md](eval/results.md).

## ⚙️ Configuration

| Setting | Value |
| ------- | ----- |
| `NVIDIA_API_KEY` | required for `audit`/`eval` — NVIDIA NIM key |
| Retry | 3 attempts, 500ms base / 8s cap, full jitter, `{429}∪[500,599]` only |
| Classifier timeout | 5s connect / 30s per call |
| MCP timeout | 10s connect / 15s `tools/list` |
| Concurrency | 4 (shared `Semaphore`) |
| CLI flags | `--thread <id>` (resume), `--db <path>` (checkpoint file), `--out <path>` (save report), `--prompt-version v1\|v2\|v3` (injection rubric, default `v2`), `--target <command> [...args]` (stdio server; must come last) |

## 📋 Phase → Topic Mapping

| Topic | Where |
| ----- | ----- |
| Agent frameworks | Phase 5 — fan-out, routing, `interrupt()`, checkpointing |
| LLM vs. deterministic tools | Phases 1–2 |
| Evaluating an LLM | Phase 4 — accuracy plus consistency |
| Sync/async API calls | Phase 3 — timeouts, backoff, typed errors |
| Prompt engineering | Versioned v1 → v2 → v3 |
| Skills | Phase 2 — per-category playbooks, loaded on demand |

## 🛡️ Scope & Honesty Notice

- One 12-tool fixture, mostly self-graded — Phase 3's real-server test is the one exception
- `ground-truth.yaml` is never edited to match the classifier's output
- Self-checks (grading a draft against its own rubric) show internal consistency, not correctness
- 12 tools demonstrates a method, not a benchmark
- The deep probe performs **real** invocations, gated by a real `interrupt()` prompt

## 📦 Dependencies

`@langchain/core` `@langchain/langgraph` `@langchain/langgraph-checkpoint-sqlite` `@modelcontextprotocol/sdk` `openai` `undici` `zod` `zod-to-json-schema` — Node.js 22+ (the real floor, set by `undici`'s `engines` field).

## 📚 More

[PLAN.md](PLAN.md) (build plan) · [CLAUDE.md](CLAUDE.md) (constraints + reserved decisions) · [eval/results.md](eval/results.md) (full writeup, every phase)

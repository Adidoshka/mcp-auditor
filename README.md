# mcp-auditor — MCP Tool Risk Auditor

![TypeScript](https://img.shields.io/badge/typescript-7.0+-blue)
![MCP](https://img.shields.io/badge/MCP-SDK%201.30+-purple)
![LangGraph](https://img.shields.io/badge/LangGraph-1.4+-1C3C3C)
![Eval Precision](https://img.shields.io/badge/eval%20precision-100%25-brightgreen)
![Eval Recall](https://img.shields.io/badge/eval%20recall-93.3%25-green)
![License](https://img.shields.io/badge/license-portfolio-orange)

## 🎯 Overview

A CLI that audits an MCP server's exposed tools for risks to the **agent** connecting to it — before that agent ever calls one of them. Three finding types:

- **Injected instructions** — a description that talks to the agent reading it, not just the human calling the tool
- **Capability chains** — two harmless tools where one's output could feed the other's input (a reader, and something that sends data out)
- **Overbroad parameters** — a schema that accepts more than the tool's job requires

**The argument:** everything decidable from a tool's schema and name is deterministic code — zero model calls. The model is asked one narrow question per tool: does this description contain instructions aimed at the agent? It never labels capabilities, judges severity, or writes the report.

## 🚀 Quick Start

```bash
npm install
cp .env.example .env   # add NVIDIA_API_KEY — free tier at build.nvidia.com

npm run target-server  # optional: the fixture server on its own
npm run eval            # Phase 4: precision / recall / disagreement rate
npm run audit           # the full LangGraph pipeline, interactive
```

`npm run audit` pauses for your approval (`y`/`N`) before invoking any flagged tool for real. Add `--out report.txt` to save the report, `--thread <name>` to make the run resumable — rerunning with the same thread after a kill picks up where it left off instead of starting over.

Captured runs, no setup needed: [eval/example-report.txt](eval/example-report.txt) (a full audit) and [eval/kill-resume.txt](eval/kill-resume.txt) (a real kill-and-resume).

## 📐 Architecture

```text
target-server/server.ts  (11-tool fixture, stdio)
          │ tools/list
          ▼
   src/mcp/client.ts  (connect, list, invoke — 0 model calls)
          │
   ┌──────┴───────────────────┐
   ▼                          ▼
src/rules/            src/llm/classify.ts
 schema.ts              + prompts/v1.md
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
3. **Classify** — one model call per tool, description text only.
4. **Collect** — flags any chain source, or any LLM-injected tool.
5. **Deep probe** — on approval only, actually invokes a flagged tool to see what it does.
6. **Report** — findings grouped by the mechanism that produced them.

## 📁 Project Structure

```text
mcp-auditor/
├── target-server/
│   ├── server.ts             # 11 tools: honest, injected, planted chain
│   └── ground-truth.yaml     # labels, written before detection code existed
├── src/
│   ├── mcp/client.ts          # connect, list, invoke — 0 model calls
│   ├── rules/
│   │   ├── schema.ts           # unconstrained-parameter checks
│   │   └── capability.ts       # capability labeling + chain detection
│   ├── llm/
│   │   ├── classify.ts         # the one LLM node
│   │   ├── skills.ts           # skill loading + selection
│   │   └── prompts/v1.md       # versioned injection rubric
│   ├── skills/                # per-capability audit playbooks
│   ├── graph/                 # state, nodes, wiring, probe-arg synthesis
│   ├── findings.ts             # shared Finding type, tagged by mechanism
│   ├── errors.ts, retry.ts, concurrency.ts
│   ├── report.ts
│   └── cli.ts                 # entrypoint
├── eval/
│   ├── run.ts                 # 10 runs x 11 tools, precision/recall/disagreement
│   ├── results.md              # full writeup, every phase, incl. what's wrong
│   ├── example-report.txt
│   └── kill-resume.txt
├── PLAN.md                    # the five-phase build plan
└── CLAUDE.md                  # constraints + decisions reserved for the author
```

## 🔧 Components

| Component | Files | What it does |
| --------- | ----- | -------------- |
| **Target fixture** | `target-server/` | 11-tool server: 6 honest, 2 injected (1 blunt, 1 "convention-framed"), 1 planted `reads_local → writes_external` chain |
| **Deterministic rules** | `src/rules/` | Schema: flags unconstrained strings (naive on purpose — 2/6 precision, and that gap is the argument for the LLM node). Capability: labels tools from schema shape then name, **never** description; full cross-product chain detection |
| **LLM node** | `src/llm/` | One job: injected or not, from description text alone. Structured output re-validated, not trusted. `evidence` ordered before `verdict` (tested fix: recall 90%→93.3%). Skills loaded from capability labels, never the description being judged |
| **LangGraph orchestration** | `src/graph/` | Fan-out via `Send`, `collect` decides flagged tools, `interrupt()` gates the one real side effect, `SqliteSaver` checkpoints so a killed run resumes from disk |
| **Errors/retry/concurrency** | `src/errors.ts`, `retry.ts`, `concurrency.ts` | `SlowError` / `RefusingError` / `MalformedError`; backoff on `{429}∪[500,599]` only; shared `Semaphore` (LangGraph's own `maxConcurrency` is dead code — confirmed by reading its source) |
| **Evaluation harness** | `eval/` | 10 runs × 11 tools at temperature 0: precision, recall, and disagreement rate (how often identical input flips verdict) |

## 🛠️ Target Fixture Tools

| Tool | Ground truth |
| ---- | -------------- |
| `get_weather`, `convert_currency`, `get_current_time`, `roll_dice` | honest, no issues |
| `search_notes`, `read_document`, `read_config_value`* | honest, chain source |
| `send_email_notification`* | honest, chain sink |
| `generate_expense_summary` | injected — explicit imperative |
| `compile_account_summary` | injected — convention framing |
| `read_user_settings` | injected + chain source (closes a fixture gap: the two tools above are capability-blind) |

\* planted source→sink pair

## 📊 Results

| Phase | Result |
| ----- | ------ |
| 1 — deterministic rules | 10 findings / 11 tools, **0 model calls** (6 schema: 2 TP, 4 FP · 4 capability: 4 TP, 0 FP) |
| 2 — LLM node + skills | Both injections caught |
| 3 — retry/timeouts | Pointed at a real server (`@modelcontextprotocol/server-filesystem`) — found a real capability-labeling false positive |
| 4 — evaluation | Precision **100%** (28/28), recall **93.3%** (28/30), disagreement **9.1%** (1/11 tools) |
| 5 — LangGraph | `interrupt()` gate + kill-and-resume proven live — 5s to recover, faster than any single classify call |

The schema rule's low precision is load-bearing: both injections sit on tools whose code touches nothing suspicious, so a schema/name-based labeler has nothing to flag by construction — that gap is what the LLM node closes. The one real classifier failure mode is `compile_account_summary`, the sole tool that ever disagreed with itself across 10 identical calls. Full breakdown: [eval/results.md](eval/results.md).

## ⚙️ Configuration

| Setting | Value |
| ------- | ----- |
| `NVIDIA_API_KEY` | required for `audit`/`eval` — NVIDIA NIM key |
| Retry | 3 attempts, 500ms base / 8s cap, full jitter, `{429}∪[500,599]` only |
| Classifier timeout | 5s connect / 30s per call |
| MCP timeout | 10s connect / 15s `tools/list` |
| Concurrency | 4 (shared `Semaphore`) |
| CLI flags | `--thread <id>` (resume), `--db <path>` (checkpoint file), `--out <path>` (save report) |

## 📋 Phase → Topic Mapping

| Topic | Where |
| ----- | ----- |
| Agent frameworks | Phase 5 — fan-out, routing, `interrupt()`, checkpointing |
| LLM vs. deterministic tools | Phases 1–2 |
| Evaluating an LLM | Phase 4 — accuracy plus consistency |
| Sync/async API calls | Phase 3 — timeouts, backoff, typed errors |
| Prompt engineering | Versioned v1 → v2 |
| Skills | Phase 2 — per-category playbooks, loaded on demand |

## 🛡️ Scope & Honesty Notice

- One 11-tool fixture, mostly self-graded — Phase 3's real-server test is the one exception
- `ground-truth.yaml` is never edited to match the classifier's output
- Self-checks (grading a draft against its own rubric) show internal consistency, not correctness
- 11 tools demonstrates a method, not a benchmark
- The deep probe performs **real** invocations, gated by a real `interrupt()` prompt

## 📦 Dependencies

`@langchain/core` `@langchain/langgraph` `@langchain/langgraph-checkpoint-sqlite` `@modelcontextprotocol/sdk` `openai` `undici` `zod` `zod-to-json-schema` — Node.js 22+ (the real floor, set by `undici`'s `engines` field).

## 📚 More

[PLAN.md](PLAN.md) (build plan) · [CLAUDE.md](CLAUDE.md) (constraints + reserved decisions) · [eval/results.md](eval/results.md) (full writeup, every phase)

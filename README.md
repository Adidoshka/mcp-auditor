# mcp-auditor — MCP Tool Risk Auditor

![TypeScript](https://img.shields.io/badge/typescript-7.0+-blue)
![Node](https://img.shields.io/badge/node-22+-339933)
![MCP](https://img.shields.io/badge/MCP-SDK%201.30+-purple)
![LangGraph](https://img.shields.io/badge/LangGraph-1.4+-1C3C3C)
![Classifier](https://img.shields.io/badge/classifier-gpt--oss--20b%20%40%20NVIDIA%20NIM-76B900)
![Eval Precision](https://img.shields.io/badge/eval%20precision-100%25-brightgreen)
![Eval Recall](https://img.shields.io/badge/eval%20recall-93.3%25-green)
![Security Research](https://img.shields.io/badge/security-research-red)
![License](https://img.shields.io/badge/license-portfolio-orange)
![Status](https://img.shields.io/badge/phases-5%2F5%20first%20pass-brightgreen)

## 🎯 Overview

`mcp-auditor` is a CLI that audits an MCP server's exposed tools for risks to the **agent** connecting to it — before that agent ever calls one of them. It comes out of months of honeypot research studying MCP servers from the attacker's side (~6,700 observed requests); this project asks the same question from the other seat: what should an agent check about a server *before* it decides to trust it?

Three finding types, one deterministic mechanism each, plus one narrow model call:

- **Injected instructions** — a tool description that talks to the *agent* reading it, not just to the human calling the tool.
- **Capability chains** — two individually-harmless tools where one's output could feed the other's input (a reader, and something that sends data out).
- **Overbroad parameters** — a schema that accepts more than the tool's job requires.

**The argument the project is built to make:** the LLM does exactly one thing in this system, and it can explain why nothing else needs it. Everything decidable from a tool's schema and name — capability labeling, chain detection, overbroad-parameter checks — is deterministic code with **zero model calls**. The model answers one narrow question per tool: does this description contain instructions aimed at the agent reading it? It never labels capabilities, judges severity, or writes the report.

The system includes:

- **Target fixture server** — an 11-tool MCP server standing in for the server under audit: 6 honest tools, 2 injected descriptions (one blunt, one "convention framing" subtle), and a planted `reads_local → writes_external` capability chain, with hand-written ground truth
- **Deterministic rule engine** — schema and capability checks, 0 model calls (`src/rules/`)
- **LLM classifier node** — one job, one versioned prompt, served via NVIDIA NIM (`openai/gpt-oss-20b`)
- **Skill playbooks** — per-capability audit notes loaded onto the base rubric only for the tool being examined
- **LangGraph orchestration** — fan-out across tools, conditional routing to a deep-probe branch, a real `interrupt()` approval gate, SQLite-checkpointed so a killed run resumes from disk
- **Evaluation harness** — 10 runs × 11 tools at temperature 0 against ground truth: precision, recall, and disagreement rate

## 🚀 Quick Start

### Prerequisites

```bash
npm install
```

> Node.js **22+** — the real floor, set by `undici`'s own `engines` field, not a guess.

### Setup & Run

1. **Configure the classifier key**:

   ```bash
   cp .env.example .env
   # then set NVIDIA_API_KEY=... — free tier at https://build.nvidia.com
   ```

2. **Try the fixture server standalone** (optional — confirms the MCP handshake on its own):

   ```bash
   npm run target-server
   ```

3. **Run the Phase 4 evaluation** (10 runs × 11 tools, precision/recall/disagreement):

   ```bash
   npm run eval           # prompts/v1.md
   npm run eval -- v2     # once v2.md exists
   ```

4. **Run the full interactive audit** (Phase 5's LangGraph pipeline):

   ```bash
   npm run audit
   npm run audit -- --thread demo --out report.txt
   ```

   > Pauses for your approval before invoking any flagged tool for real via `interrupt()`. Re-running with the same `--thread` resumes an interrupted prior run from the SQLite checkpoint instead of starting over.

5. **Read a captured run instead of reproducing it live**:

   - [eval/example-report.txt](eval/example-report.txt) — a full audit report, every flagged tool approved and actually invoked
   - [eval/kill-resume.txt](eval/kill-resume.txt) — unedited terminal output from a real kill-and-resume, timestamps included

## 📐 Architecture

```text
┌───────────────────────────┐
│  target-server/server.ts   │  the fixture MCP server (stdio transport)
└──────────────┬─────────────┘
               │ tools/list
               ▼
┌───────────────────────────┐
│  src/mcp/client.ts          │  connect, list, invoke — 0 model calls
└──────────────┬─────────────┘
               │
      ┌────────┴─────────────────────┐
      ▼                               ▼
┌───────────────────┐      ┌─────────────────────────┐
│ src/rules/          │      │ src/llm/classify.ts       │
│  schema.ts           │      │  + prompts/v1.md            │
│  capability.ts        │      │  (NVIDIA NIM,                  │
│  0 model calls         │      │   openai/gpt-oss-20b)             │
└─────────┬─────────┘      └─────────────┬───────────────┘
          │                                │
          └───────────────┬─────────────────┘
                          ▼
              ┌───────────────────────────┐
              │  src/graph/*.ts (LangGraph) │  fan-out (Send), collect,
              └──────────────┬─────────────┘  conditional routing, SqliteSaver
                             │ interrupt() — human approval
                             ▼
              ┌───────────────────────────┐
              │  deepProbe → callTool       │  real invocation, approved tools only
              └──────────────┬─────────────┘
                             ▼
              ┌───────────────────────────┐
              │  src/report.ts               │  findings by mechanism:
              └───────────────────────────┘  schema | capability | llm
```

### Pipeline flow

1. **List** (`mcp/client.ts`) — connect to the target server over stdio, `tools/list`, close.
2. **Rules** (`rules/schema.ts`, `rules/capability.ts`) — schema-based overbroad-parameter checks and schema/name-based capability labeling + chain detection. Zero model calls, runs on every tool unconditionally.
3. **Classify** (`llm/classify.ts`) — one model call per tool, description text only, optionally augmented with a capability-derived skill (`llm/skills.ts`).
4. **Collect** (`graph/nodes.ts`) — recomputes chain findings and decides which tools get flagged: any chain-finding source, or any `llm`-injected tool.
5. **Deep probe** (`graph/nodes.ts`, gated by `interrupt()`) — synthesizes benign arguments (`graph/probeArgs.ts`) and, only on human approval, actually invokes the flagged tool to observe its real behavior.
6. **Report** (`report.ts`) — formats every finding, grouped and counted by the mechanism that produced it.

## 📁 Project Structure

```text
mcp-auditor/
├── target-server/                 # the fixture MCP server under audit
│   ├── server.ts                    # 11 tools: honest, injected, planted chain
│   └── ground-truth.yaml            # labels, written before detection code existed
├── src/
│   ├── mcp/
│   │   └── client.ts                 # connect, tools/list, invoke — 0 model calls
│   ├── rules/
│   │   ├── schema.ts                  # unconstrained-parameter checks
│   │   └── capability.ts              # capability labeling + chain detection
│   ├── llm/
│   │   ├── classify.ts                # the one LLM node
│   │   ├── skills.ts                  # skill loading + selection
│   │   └── prompts/
│   │       └── v1.md                  # versioned injection rubric
│   ├── skills/
│   │   ├── reads_local.md             # per-capability audit playbook
│   │   └── writes_external.md
│   ├── graph/
│   │   ├── state.ts                   # shared state: tools/findings/flagged/probes
│   │   ├── nodes.ts                   # node functions — thin, orchestration only
│   │   ├── graph.ts                   # wiring + SqliteSaver checkpointer
│   │   └── probeArgs.ts               # synthesizes benign deep-probe arguments
│   ├── findings.ts                    # the shared Finding type, tagged by mechanism
│   ├── errors.ts                       # SlowError / RefusingError / MalformedError
│   ├── retry.ts                        # status-code-aware backoff (429/5xx only)
│   ├── concurrency.ts                   # mapWithConcurrency + Semaphore
│   ├── report.ts                        # formats findings + probes into the report
│   └── cli.ts                            # entrypoint: runs the graph, prompts approvals
├── eval/
│   ├── run.ts                          # Phase 4 protocol: 10 runs x 11 tools
│   ├── results.md                       # full writeup, every phase, incl. what's wrong
│   ├── example-report.txt                # a real captured audit run
│   └── kill-resume.txt                    # unedited kill-and-resume terminal output
├── PLAN.md                              # the five-phase build plan
├── CLAUDE.md                             # constraints + decisions reserved for the author
└── README.md
```

## 🔧 Components

### 1. Target Fixture Server (`target-server/`)

The malicious (and mostly honest) server the auditor points at — 11 tools over stdio, ground truth written before any detection code existed.

**Key Files:**

- `server.ts` — all 11 tool implementations
- `ground-truth.yaml` — labels per tool: `injection`, `chain_role`, `schema_issues`

**Key Features:**

- 2 injections: an explicit imperative (`generate_expense_summary`) and a "typically paired with..." convention-framed one, planted on two different tools (`compile_account_summary`, `read_user_settings`)
- A planted `read_config_value → send_email_notification` capability chain, with an explicit "shape correctly identified, not confirmed exfiltration" caveat since the source's values aren't actually sensitive
- `ground-truth.yaml` is never edited to match the classifier's output — a disagreement is a result, not a bug in the labels

### 2. Deterministic Rules (`src/rules/`)

Phase 1's whole point: how much is findable with zero model calls.

**Key Files:**

- `schema.ts` — flags any string-typed parameter with no enum constraint
- `capability.ts` — labels tools `reads_local` / `reads_remote` / `writes_external`, then finds source → sink pairs

**Key Features:**

- Schema rule kept deliberately naive (2/6 precision) — its false positives *are* the argument for why an LLM node is needed elsewhere, not a bug to quietly patch
- Capability labeling reads schema shape first, tool name second, and **never** the description — a hostile author can write anything in prose for free, so prose is untrusted for a layer that's supposed to be deterministic
- Chain detection is a full cross product of every labeled source × every labeled sink, not filtered down to "the planted pair"

### 3. LLM Node (`src/llm/`)

One job only, per `CLAUDE.md`: injected or not, from description text alone.

**Key Files:**

- `classify.ts` — the classifier call, retries, typed errors, structured output
- `skills.ts` — loads and selects capability-specific playbooks
- `prompts/v1.md` — the versioned injection rubric, never inlined in code

**Key Features:**

- Structured JSON output (Zod → JSON Schema), independently re-validated on the way back rather than trusted
- `evidence` field ordered before `verdict` — a tested structural fix, not a guess (recall 90% → 93.3% in isolation, no wording change)
- Skills selected from capability labels, never from the description being judged — same "don't let the text under review steer what the model is shown" rule the base rubric follows
- The OpenAI SDK's own retry is disabled (`maxRetries: 0`); every retry goes through `retry.ts` instead, because the SDK's default also retries 408/409 (both 4xx)

### 4. LangGraph Orchestration (`src/graph/`)

Added last, once every node's job was already decided in an earlier phase.

| Node | File | Responsibility |
| ---- | ---- | --------------- |
| `listTools` | `nodes.ts` | `tools/list` against the target server |
| `analyzeTool` | `nodes.ts` | schema check + LLM classify per tool, fanned out via `Send` |
| `collect` | `nodes.ts` | recomputes capability chains; decides which tools get flagged |
| `deepProbe` | `nodes.ts` | `interrupt()`-gated real invocation of a flagged tool |
| `writeReport` | `nodes.ts` | formats the final report |

**Key Features:**

- Bounded concurrency via a shared `Semaphore` — LangGraph's own `maxConcurrency` config option is never actually read by Pregel's execution loop (confirmed by reading the source, not assumed)
- `SqliteSaver` checkpointing — a killed process resumes from disk; proven live, not just claimed (see [eval/kill-resume.txt](eval/kill-resume.txt))
- `interrupt()` gates the one place this project has a real side effect: actually invoking a flagged tool
- Routing is "chain-finding source, or LLM-injected tool" kept exactly as literally stated rather than tightened, since every tightening considered needs a confidence field `capability.ts` doesn't have

### 5. Errors, Retry & Concurrency (`src/errors.ts`, `src/retry.ts`, `src/concurrency.ts`)

Shared by every network-touching module (`mcp/client.ts`, `llm/classify.ts`).

| Failure shape | Class | Meaning |
| ------------- | ----- | ------- |
| Slow | `SlowError` | nothing came back in time, or the connection never opened |
| Refusing | `RefusingError` | the other side responded on purpose with "no" (non-retryable 4xx) |
| Malformed | `MalformedError` | a response arrived but wasn't usable — bad JSON, schema mismatch |

**Retry policy** (`retry.ts`): 3 attempts total, 500ms base delay doubling to an 8s cap, full jitter, retryable set exactly `{429} ∪ [500,599]` — no 408, no 409, `Retry-After` honored when present.

### 6. Evaluation Harness (`eval/`)

Phase 4's actual protocol, not a sanity check.

**Key Features:**

- 10 runs × 11 tools at temperature 0, bounded concurrency, skills selected exactly the way production selects them
- Three numbers: precision, recall, and **disagreement rate** — how often identical input gave a different verdict, a property invisible to a single-pass accuracy figure
- `v1` vs `v2` prompt comparison support built in (`npm run eval -- v2`)
- A failed classify call is a recorded error outcome, not a batch-ending exception

## 🛠️ Target Fixture Tools

11 tools, three ground-truth categories:

### Honest, no issues (4)

| Tool | Parameters |
| ---- | ---------- |
| `get_weather` | `city: enum, unit?: enum` |
| `convert_currency` | `amount: number, from: enum, to: enum` |
| `get_current_time` | `timezone: enum` |
| `roll_dice` | `sides: number, count: number` |

### Honest, capability chain role (4)

| Tool | Chain role | Schema issue |
| ---- | ---------- | ------------- |
| `search_notes` | source (`reads_local`) | — |
| `read_document` | source (`reads_local`) | `unconstrained_path` |
| `read_config_value` | source (`reads_local`), planted pair | — |
| `send_email_notification` | sink (`writes_external`), planted pair | — |

### Injected (3)

| Tool | Injection style | Also a chain source |
| ---- | ---------------- | -------------------- |
| `generate_expense_summary` | explicit imperative ("IMPORTANT INSTRUCTION FOR THE AI ASSISTANT...") | no |
| `compile_account_summary` | convention framing ("teams typically pair this with...") | no |
| `read_user_settings` | convention framing, same family, different wording | yes (`unconstrained_path`) |

## 📊 Results

| Phase | Result |
| ----- | ------ |
| 1 — deterministic rules | 10 findings, 11 tools, **0 model calls** |
| 2 — LLM node + skills | Both injections caught; skills mechanism found capability-blind to both original injections, fixed by extending the fixture with `read_user_settings` |
| 3 — retry/timeout/errors | Pointed at a real server neither author wrote (`@modelcontextprotocol/server-filesystem`) — found a real capability-labeling false positive, documented rather than silently patched |
| 4 — evaluation | Precision **100%**, recall **93.3%** (up from 90% after a tested field-order fix), disagreement rate **9.1%** — one tool gave different verdicts on identical input at temperature 0 |
| 5 — LangGraph | Fan-out, conditional routing, a real `interrupt()` gate, kill-and-resume proven live: a killed process recovered from disk in **5 seconds** — not enough time to redo even one of the eleven model calls that work represents |

### Deterministic rules, by mechanism (Phase 1)

| Mechanism | Findings | True positives | False positives |
| --------- | -------- | --------------- | ----------------- |
| `schema` | 6 | 2 | 4 |
| `capability` | 4 | 4 | 0 |
| **Total (0 model calls)** | **10** | **6** | **4** |

The schema rule's 33% precision is load-bearing, not a bug: both planted injections sit on tools whose code touches nothing suspicious at all, so a schema/name-based labeler has nothing to flag on them by construction — that gap is what the LLM node exists to close.

### Classifier evaluation (Phase 4, `prompts/v1.md`, evidence-first schema)

| Metric | Value |
| ------ | ----- |
| Precision | 28/28 = 100.0% |
| Recall | 28/30 = 93.3% |
| Disagreement rate | 1/11 tools = 9.1% |
| Errors | 0/110 calls |
| Wall time | ~215s at concurrency 4 |

The one real failure mode is `compile_account_summary` — the only tool that ever disagreed with itself across 10 identical calls at temperature 0. Full breakdown, including the field-order fix tested in isolation from any prompt wording change, is in [eval/results.md](eval/results.md).

### Sample report output

```text
# mcp-auditor report

13 findings — 6 schema, 4 capability, 3 llm.

## llm (3)
- read_user_settings: injected instructions detected (skills: reads_local).
- generate_expense_summary: injected instructions detected.
- compile_account_summary: injected instructions detected.

## Deep probe (6 tools)
- search_notes, args={"query":"meeting"}
  observed: n3: Draft the agenda for the quarterly planning meeting.
...
```

Full output: [eval/example-report.txt](eval/example-report.txt).

## ⚙️ Configuration

### Environment

| Variable | Required | Description |
| -------- | -------- | ------------ |
| `NVIDIA_API_KEY` | for `npm run audit` / `npm run eval` | NVIDIA NIM key for the `openai/gpt-oss-20b` classifier endpoint |

### Retry & timeout policy (`src/retry.ts`, `src/llm/classify.ts`, `src/mcp/client.ts`)

| Parameter | Value | Notes |
| --------- | ----- | ----- |
| Max attempts | 3 | 1 original + 2 retries |
| Base delay | 500ms | doubles each attempt, full jitter |
| Max delay | 8s | hard cap on any single computed delay |
| Retryable statuses | `429`, `500`–`599` | never `408`/`409`, unlike the OpenAI SDK's own default |
| Classifier connect timeout | 5s | opening the connection only |
| Classifier per-call timeout | 30s | the whole request once connected |
| MCP connect timeout | 10s | spawning + handshaking the target server |
| MCP `tools/list` timeout | 15s | separate from connect, on purpose |
| Concurrency limit | 4 | shared `Semaphore`; measured against NIM's ~40 req/min ceiling |

### CLI flags (`src/cli.ts`)

| Flag | Default | Description |
| ---- | ------- | ------------ |
| `--thread <id>` | `"default"` | resumes a prior run with the same id instead of starting over |
| `--db <path>` | `.mcp-auditor-checkpoints.sqlite` | SQLite checkpoint database path |
| `--out <path>` | — | also writes the final report to a file |

## 📋 Phase → Topic Mapping

| Topic | Where it lives |
| ----- | --------------- |
| Agent frameworks | Phase 5 — fan-out, conditional routing, `interrupt()`, checkpointing |
| LLM vs. deterministic tools | Phases 1–2, split along that exact line |
| Evaluating an LLM | Phase 4 — accuracy plus consistency |
| Sync/async API calls | Phase 3 — timeouts, backoff, status-code-aware retries |
| Prompt engineering | Versioned prompts with a measured v1 → v2 |
| Skills | Phase 2 — per-category playbooks, loaded on demand |

## 🛡️ Scope & Honesty Notice

⚠️ **This is a portfolio project, not a benchmark**

- **One fixture, mostly self-graded** — every number above comes from one 11-tool server, mostly written by the same person who wrote the rules being scored against it. Phase 3's real-server test (`@modelcontextprotocol/server-filesystem`) is the one exception.
- **Ground truth is never adjusted to match the classifier** — a disagreement between `ground-truth.yaml` and the model's verdict is recorded as a result, not quietly fixed.
- **Self-checks are not verification** — anywhere a draft is graded against its own rubric, that shows internal consistency, not correctness, and is labeled as such rather than presented as validation.
- **11 tools is a tiny test set** — this demonstrates a method, not a benchmark; real numbers would need hundreds of labeled cases across servers nobody involved built.
- **The deep probe performs real invocations** — gated behind a real `interrupt()` approval prompt, not a simulated one; a fallback probe against an unknown server's write-shaped tool genuinely performs that write once approved.

## 📦 Dependencies

```text
@langchain/core                    ^1.2.11
@langchain/langgraph                ^1.4.15
@langchain/langgraph-checkpoint-sqlite ^1.0.4
@modelcontextprotocol/sdk            ^1.30.0
openai                                ^7.15.0
undici                                 ^8.10.2
zod                                     ^4.6.1
zod-to-json-schema                       ^3.25.2
```

**Node.js requirement:** 22+ (set by `undici`'s `engines` field).

## 📄 License

Portfolio project — no license file yet; not intended for production use against real servers.

## 📚 Additional Documentation

- [PLAN.md](PLAN.md) — the five-phase build plan, division of labor, and the cut list
- [CLAUDE.md](CLAUDE.md) — hard constraints, style rules, and the decisions reserved for the author rather than generated
- [eval/results.md](eval/results.md) — the full writeup, phase by phase, including what still gets wrong
- [eval/example-report.txt](eval/example-report.txt) — a real captured audit run, every flagged tool approved
- [eval/kill-resume.txt](eval/kill-resume.txt) — unedited terminal output from a real kill-and-resume

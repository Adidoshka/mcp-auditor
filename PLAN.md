# mcp-auditor — Implementation Plan

A CLI tool that audits an MCP server's exposed tools for risks to the agent that connects to it: injected instructions in tool descriptions, capability chains that enable exfiltration, and overbroad parameters.

**Motivation:** I spent months studying MCP servers from the attacker's side (honeypot research — observed traffic across ~6,700 requests). This is the same problem from the agent's side: what should you check *before* you trust a server?

---

## Stack

TypeScript. The MCP SDK is first-class in TS, LangGraph has a JS package, and it matches the roles I'm targeting. Python is the more mature LangGraph path — switching is defensible if TS friction becomes a time sink.

## Structure

```
mcp-auditor/
├── target-server/          # the malicious MCP server (my own fixture)
│   ├── server.ts
│   └── ground-truth.yaml
├── src/
│   ├── mcp/client.ts       # connect, tools/list
│   ├── rules/schema.ts     # deterministic schema checks
│   ├── rules/capability.ts # labeling + chain detection
│   ├── llm/classify.ts     # the one LLM node
│   ├── llm/prompts/        # versioned: v1.md, v2.md
│   ├── skills/             # per-category audit playbooks
│   ├── graph/              # LangGraph wiring (built last)
│   └── report.ts
├── eval/
│   ├── run.ts
│   └── results.md
└── README.md
```

---

## Phase 0 — Target server + ground truth

Build the attack before the defense, so ground truth always exists.

Eight tools:
- 4 honest, doing real and boring things
- 1 obvious injection (description directly instructs the agent)
- 1 subtle injection (reads like a helpful note to the assistant)
- 2 individually clean, forming a `reads_local` → `writes_external` chain

Write `ground-truth.yaml` **now**, before any detection code exists:

```yaml
- name: get_weather
  injection: false
  chain_role: none
  schema_issues: []

- name: get_project_notes
  injection: true
  chain_role: source
  schema_issues: [unconstrained_path]
```

**My decision, not generated:** what makes the subtle injection subtle. Too obvious and the eval is meaningless; too hard and the classifier looks broken. This is the most important design call in the project.

**Done when:** an MCP client can connect and list all 8 tools.

---

## Phase 1 — Deterministic core (no LLM at all)

The constraint is deliberate: discover how much is findable without a model.

- `client.ts` — connect, `tools/list`, typed tool objects
- `schema.ts` — unconstrained strings, missing enums, unrestricted paths
- `capability.ts` — label each tool `reads_local` / `reads_remote` / `writes_external`, then find source → sink pairs

**My decision:** the labeling rules. Name-based, schema-based, or both — and where the heuristic would miss.

**Done when:** the planted chain is found and schema-loose tools are flagged, with zero model calls. Record how many findings this is — it's the evidence behind the LLM-vs-tools argument.

---

## Phase 2 — The LLM node + skills

One function, one job: description in, `{verdict, confidence, evidence}` out.

Prompt lives in `prompts/v1.md`, loaded from disk — never inline, because Phase 4 compares versions.

Skills: one audit playbook per capability category, loaded only for the tool being examined rather than concatenated into a single prompt.

**My decision:** a precise definition of "injection" — it serves as both the prompt and the labeling rubric, and they must match or the eval measures nothing.

**Done when:** both injections caught, at most one false positive among the honest tools.

---

## Phase 3 — The API layer

Built deliberately, not incidentally. In `llm/classify.ts` and `mcp/client.ts`:

- bounded concurrency (semaphore, limit ~4)
- per-call timeout, separate from connection timeout
- retry with exponential backoff on 429 and 5xx
- **no** retry on 4xx
- typed errors distinguishing a slow server from a refusing one

Then point the auditor at one MCP server I didn't write, to hit a connection that can genuinely hang or refuse.

**Done when:** I can walk through the client function line by line and justify every piece.

---

## Phase 4 — Evaluation

`eval/run.ts` — 10 runs at temperature 0 across all 8 tools, compared against `ground-truth.yaml`.

Three numbers:
1. **Precision** — of what it flagged, how much was real
2. **Recall** — of what was real, how much it caught
3. **Disagreement rate** — how often identical input gave different verdicts (a separate property from accuracy, and rarely measured)

Then revise the prompt once → `v2.md` → rerun. Two data points beat one number.

**Done when:** `results.md` holds a table worth showing on a slide, including what it still gets wrong.

**Known limitation to state up front:** 8 tools is a tiny test set. This demonstrates a method, not a benchmark — real numbers would need hundreds of labeled cases.

---

## Phase 5 — LangGraph

Everything already works; now orchestrate it, so every edge is a decision rather than a default.

- **State:** `{ tools[], findings[], flagged[], approvals{} }`
- **Fan out** across tools
- **Conditional edge:** flagged → deep branch; everything else → report
- **`interrupt()`** before any sandboxed invocation (real side effects need approval)
- **Checkpointer** — then kill the process mid-run and resume to prove state persisted

**Done when:** a LangGraph Studio screenshot of the graph, and a recorded kill-and-resume.

> Check the current LangGraph JS docs before starting this phase — the interrupt and checkpointer APIs have changed shape more than once.

---

## Division of labor

**Generate:** mock server bodies, MCP client boilerplate, report formatting, eval scaffolding.

**Decide myself:** the subtle injection, the capability labeling rules, the injection definition, the retry policy, the graph's edges. These are the five things I'll be asked about.

---

## Cut list

If time runs short: the sandboxed deep probe (report "would probe" instead), tools 7 and 8, any web UI.

**Never cut:** Phase 4.

---

## Demo (4 minutes)

1. Show two innocent-looking tools
2. Run the auditor
3. The capability chain finding lands — neither tool is dangerous alone
4. Show the injected description
5. Show the interrupt pausing for approval
6. Show the eval table, and say plainly what it still gets wrong

---

## Mapping to the six topics

| Topic | Where it lives |
|---|---|
| 1. Agent frameworks | Phase 5 — fan-out, conditional routing, interrupt, checkpointing |
| 2. LLM vs deterministic tools | Phases 1–2, split along that exact line |
| 3. Evaluating an LLM | Phase 4 — accuracy plus consistency |
| 4. Sync/async API calls | Phase 3 — timeouts, backoff, status-code-aware retries |
| 5. Prompt engineering | Versioned prompts with a measured v1 → v2 |
| 6. Skills | Phase 2 — per-category playbooks, loaded on demand |

**The one-sentence argument:** the LLM does exactly one thing in this system, and I can explain why nothing else needs it.

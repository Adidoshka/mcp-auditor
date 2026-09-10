# mcp-auditor

A CLI that audits an MCP server's exposed tools for risks to the agent
connecting to it: injected instructions in tool descriptions, capability
chains between tools, and overbroad parameters.

See [PLAN.md](./PLAN.md) for the phased build plan and [CLAUDE.md](./CLAUDE.md)
for the constraints that shouldn't erode along the way.

## Status

Phase 0 — target server and ground truth.

## Layout

```
target-server/          the fixture MCP server under audit
  server.ts               4 honest tools (Phase 0); malicious tools added by hand
  ground-truth.yaml        labels for every tool, written before detection code exists
src/
  mcp/                    Phase 1 — client, tools/list
  rules/                  Phase 1 — deterministic schema + capability checks
  llm/prompts/            Phase 2 — versioned prompts (v1.md, v2.md), never inlined
  skills/                 Phase 2 — per-capability-category audit playbooks
  graph/                  Phase 5 — LangGraph wiring
eval/                     Phase 4 — eval harness and results
```

## Running the target server

```
npm install
npm run target-server
```

Speaks MCP over stdio — an MCP client (or later, the auditor itself) connects
by spawning this process rather than by hitting a network port.

/**
 * graph/nodes.ts — the audit graph's node functions.
 *
 * Deliberately thin: every node here calls into code that already
 * existed and was already decided in an earlier phase (rules/,
 * llm/classify.ts, llm/skills.ts, report.ts) — this file's only job is
 * orchestration, matching PLAN.md's framing that the graph gets added
 * last "so that each node, edge, and interrupt exists for an observed
 * reason," not new logic invented for the graph's sake.
 *
 * `buildNodes` takes the target server as a parameter rather than
 * hardcoding target-server, so this graph isn't structurally tied to
 * this project's own fixture — the same nodes work against any
 * StdioServerTarget, same as mcp/client.ts itself.
 */

import { Send } from "@langchain/langgraph";
import { interrupt } from "@langchain/langgraph";
import type { AuditedTool, StdioServerTarget } from "../mcp/client.js";
import { listAuditedTools, callTool } from "../mcp/client.js";
import { checkSchema } from "../rules/schema.js";
import { labelTool, checkCapabilityChains } from "../rules/capability.js";
import { selectSkills } from "../llm/skills.js";
import { classifyDescription, buildInjectionFinding, type PromptVersion } from "../llm/classify.js";
import { formatReport, type ProbeResult } from "../report.js";
import { synthesizeProbeArgs } from "./probeArgs.js";
import type { Finding } from "../findings.js";
import { Semaphore, DEFAULT_CONCURRENCY_LIMIT } from "../concurrency.js";

// Shared across every analyzeTool/deepProbe invocation in this process —
// LangGraph's Send-based fan-out dispatches one node call per tool with
// no caller holding the full list to throttle from outside, unlike
// eval/run.ts's mapWithConcurrency. See concurrency.ts's header for why
// the graph's own `maxConcurrency` config option doesn't do this instead
// (confirmed by reading Pregel's source: it's never read).
const classifySemaphore = new Semaphore(DEFAULT_CONCURRENCY_LIMIT);
const callToolSemaphore = new Semaphore(DEFAULT_CONCURRENCY_LIMIT);

export function buildNodes(target: StdioServerTarget, promptVersion: PromptVersion = "v2") {
  async function listTools() {
    const tools = await listAuditedTools(target);
    return { tools };
  }

  function fanOutToAnalyze(state: { tools: AuditedTool[] }) {
    return state.tools.map((tool) => new Send("analyzeTool", { tool }));
  }

  /**
   * The classify call is caught locally, not left to propagate — a
   * malformed/slow/refusing failure on one tool (real observed
   * failure: a genuine malformed-JSON response from gpt-oss-20b, the
   * same decoding glitch noted in eval/results.md's Phase 2 section)
   * would otherwise crash the whole fan-out and lose every other
   * tool's findings with it. Same principle eval/run.ts already
   * applies to its own 110 calls: an error is a recorded outcome, not
   * a batch-ending exception. Schema findings still go through even
   * when classify fails — they come from a separate, already-succeeded
   * step.
   */
  async function analyzeTool(state: { tool: AuditedTool }) {
    const { tool } = state;
    const findings: Finding[] = checkSchema(tool);
    const skills = selectSkills(labelTool(tool));

    try {
      // Defaults to v2, not the classifyDescription default: v1 is kept only
      // as eval/run.ts's comparison baseline, per the frozen-run result in
      // eval/results.md. cli.ts's --prompt-version can override this per run.
      const verdict = await classifySemaphore.run(() =>
        classifyDescription(tool.description, { skills, promptVersion }),
      );
      const injectionFinding = buildInjectionFinding(tool.name, verdict, skills);
      if (injectionFinding !== null) findings.push(injectionFinding);
      return { findings };
    } catch (error) {
      const kind = (error as { kind?: string }).kind ?? "unknown";
      const message = error instanceof Error ? error.message : String(error);
      return { findings, errors: [`${tool.name}: classify failed (${kind}): ${message}`] };
    }
  }

  /**
   * Recomputes capability labels and chain findings fresh from
   * `state.tools`, rather than threading labels through the
   * per-tool fan-out — a Send-dispatched node only sees the payload
   * it was given, not the shared state (confirmed empirically), so
   * accumulating cross-tool data through that path would need its
   * own plumbing. Chain detection is a whole-server computation
   * anyway (a pair relationship, not a per-tool one), so recomputing
   * it here from the already-available tool list is simpler than
   * threading anything through.
   *
   * flagged = chain-finding sources, plus any llm-injected tool — see
   * eval/results.md's Phase 5 section for why this is kept exactly as
   * literally stated rather than tightened with an ungrounded cutoff.
   */
  function collect(state: { tools: AuditedTool[]; findings: Finding[] }) {
    const labels = new Map(state.tools.map((tool) => [tool.name, labelTool(tool)] as const));
    const chainFindings = checkCapabilityChains(state.tools);

    const flaggedNames = new Set<string>();
    for (const finding of chainFindings) flaggedNames.add(finding.source);
    for (const finding of state.findings) {
      if (finding.mechanism === "llm") flaggedNames.add(finding.tool);
    }

    const flagged = state.tools.filter((tool) => flaggedNames.has(tool.name));
    return { findings: chainFindings, flagged };
  }

  function routeAfterCollect(state: { flagged: AuditedTool[] }) {
    if (state.flagged.length === 0) return "writeReport";
    return state.flagged.map((tool) => new Send("deepProbe", { tool }));
  }

  /**
   * The cut-list version PLAN.md names, done for real rather than
   * stubbed: synthesizes a benign argument set, pauses for approval
   * via interrupt() before doing anything, and only invokes the tool
   * for real once approved. Everything before the interrupt() call
   * re-runs on resume (confirmed empirically) — synthesizeProbeArgs is
   * pure and idempotent, so that's harmless here.
   */
  async function deepProbe(state: { tool: AuditedTool }) {
    const { tool } = state;
    const args = synthesizeProbeArgs(tool, target);

    const approved = interrupt({
      tool: tool.name,
      description: tool.description,
      proposedArgs: args,
    }) as boolean;

    if (!approved) {
      const result: ProbeResult = { tool: tool.name, description: tool.description, args, approved: false };
      return { probes: [result] };
    }

    try {
      const observed = await callToolSemaphore.run(() => callTool(target, tool.name, args));
      const result: ProbeResult = {
        tool: tool.name,
        description: tool.description,
        args,
        approved: true,
        observed,
      };
      return { probes: [result] };
    } catch (error) {
      const kind = (error as { kind?: string }).kind ?? "unknown";
      const message = error instanceof Error ? error.message : String(error);
      return { errors: [`${tool.name}: probe failed (${kind}): ${message}`] };
    }
  }

  function report(state: { findings: Finding[]; probes: ProbeResult[]; errors: string[] }) {
    return { report: formatReport(state.findings, state.probes, state.errors) };
  }

  return { listTools, fanOutToAnalyze, analyzeTool, collect, routeAfterCollect, deepProbe, report };
}

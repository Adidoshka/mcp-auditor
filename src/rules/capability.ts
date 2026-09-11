/**
 * rules/capability.ts — capability labeling and chain detection.
 *
 * Phase 1 constraint: zero model calls.
 *
 * `labelTool` is deliberately left unimplemented. Per CLAUDE.md, the
 * labeling heuristic is a decision for the project owner to make and
 * defend out loud — name-based, schema-based, description-based, or
 * some combination, and specifically where that heuristic misses (a
 * tool named `helper` that reads a file; a parameter named `data` that's
 * actually a URL). Scaffolding a guess here would just hide that
 * decision instead of making it. Fill in the body below.
 *
 * Chain detection — given labels, find every source -> sink pair — is
 * mechanical once labels exist, so it's provided.
 */

import type { AuditedTool } from "../mcp/client.js";
import type { CapabilityFinding } from "../findings.js";

export type CapabilityLabel = "reads_local" | "reads_remote" | "writes_external" | "none";

/**
 * Labels a single tool's capability.
 *
 * THIS IS THE DECISION. Not implemented on purpose — see the file
 * header and CLAUDE.md's "Things I write myself."
 */
export function labelTool(tool: AuditedTool): CapabilityLabel {
  throw new Error(
    `labelTool is not implemented yet (see rules/capability.ts) — called for tool "${tool.name}"`,
  );
}

/**
 * Given every tool's capability label, finds every reads_local ->
 * writes_external pair. Doesn't re-decide labels, doesn't rank them by
 * plausibility — one finding per (source, sink) pair, full cross
 * product, since nothing at this layer knows which pairs an agent
 * would actually chain together in practice.
 */
export function findCapabilityChains(
  tools: readonly AuditedTool[],
  labels: ReadonlyMap<string, CapabilityLabel>,
): CapabilityFinding[] {
  const sources = tools.filter((t) => labels.get(t.name) === "reads_local");
  const sinks = tools.filter((t) => labels.get(t.name) === "writes_external");

  const findings: CapabilityFinding[] = [];
  for (const source of sources) {
    for (const sink of sinks) {
      findings.push({
        mechanism: "capability",
        source: source.name,
        sink: sink.name,
        detail: `${source.name} (reads_local) -> ${sink.name} (writes_external): the output of one could flow into the input of the other.`,
      });
    }
  }
  return findings;
}

/** Labels every tool, then runs chain detection. Throws until labelTool is implemented. */
export function checkCapabilityChains(tools: readonly AuditedTool[]): CapabilityFinding[] {
  const labels = new Map(tools.map((tool) => [tool.name, labelTool(tool)] as const));
  return findCapabilityChains(tools, labels);
}

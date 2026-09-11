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

/**
 * A tool's declared capabilities. Set-valued, not single-valued: a tool
 * that both reads a local file and posts it externally in one call is a
 * real pattern (a self-contained exfiltration tool, no second tool
 * needed), and forcing a single label per tool would make labelTool
 * pick one and silently lose the other. This project's nine tools don't
 * happen to contain that case — every source and every sink here is a
 * separate tool — but a real server audited later might, and the type
 * shouldn't assume it away. "No capability" is the empty set; there's
 * no separate "none" member.
 */
export type Capability = "reads_local" | "reads_remote" | "writes_external";

/**
 * Labels a single tool's capabilities.
 *
 * THIS IS THE DECISION. Not implemented on purpose — see the file
 * header and CLAUDE.md's "Things I write myself."
 */
export function labelTool(tool: AuditedTool): ReadonlySet<Capability> {
  throw new Error(
    `labelTool is not implemented yet (see rules/capability.ts) — called for tool "${tool.name}"`,
  );
}

/**
 * Given every tool's capability set, finds every reads_local ->
 * writes_external pair. Doesn't re-decide labels, doesn't rank them by
 * plausibility — one finding per (source, sink) pair, full cross
 * product, since nothing at this layer knows which pairs an agent would
 * actually chain together in practice.
 *
 * A tool holding both capabilities appears in both `sources` and
 * `sinks`, so it pairs with itself in the output. That's intentional,
 * not a bug to filter out: a single tool that reads local data and
 * sends it externally in the same call is the chain, collapsed into one
 * hop instead of two.
 */
export function findCapabilityChains(
  tools: readonly AuditedTool[],
  labels: ReadonlyMap<string, ReadonlySet<Capability>>,
): CapabilityFinding[] {
  const sources = tools.filter((t) => labels.get(t.name)?.has("reads_local") ?? false);
  const sinks = tools.filter((t) => labels.get(t.name)?.has("writes_external") ?? false);

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

/**
 * report.ts — formats a run's findings and deep-probe results into
 * readable output.
 *
 * Named in PLAN.md's file layout since Phase 0 but never built until
 * now — every prior phase's "report" was eval/results.md, written by
 * hand after the fact. This is the first real one, produced by an
 * actual run rather than narrated afterward.
 *
 * Per CLAUDE.md constraint 3, mechanism provenance stays visible: the
 * summary breaks findings down by `schema` | `capability` | `llm`
 * before listing them, rather than presenting one flat list that
 * blurs which mechanism found what.
 */

import type { Finding } from "./findings.js";

export interface ProbeResult {
  tool: string;
  args: Record<string, unknown>;
  approved: boolean;
  observed?: string;
}

export function formatReport(
  findings: readonly Finding[],
  probes: readonly ProbeResult[] = [],
  errors: readonly string[] = [],
): string {
  const byMechanism = {
    schema: findings.filter((f) => f.mechanism === "schema"),
    capability: findings.filter((f) => f.mechanism === "capability"),
    llm: findings.filter((f) => f.mechanism === "llm"),
  };

  const lines: string[] = [];
  lines.push("# mcp-auditor report");
  lines.push("");
  lines.push(
    `${findings.length} findings — ${byMechanism.schema.length} schema, ${byMechanism.capability.length} capability, ${byMechanism.llm.length} llm.`,
  );
  lines.push("");

  for (const [mechanism, group] of Object.entries(byMechanism)) {
    if (group.length === 0) continue;
    lines.push(`## ${mechanism} (${group.length})`);
    for (const finding of group) {
      lines.push(`- ${finding.detail}`);
    }
    lines.push("");
  }

  if (probes.length > 0) {
    lines.push(`## Deep probe (${probes.length} tool${probes.length === 1 ? "" : "s"})`);
    for (const probe of probes) {
      lines.push(`- ${probe.tool}, args=${JSON.stringify(probe.args)}`);
      if (!probe.approved) {
        lines.push(`  not approved — invocation skipped.`);
      } else {
        lines.push(`  observed: ${probe.observed ?? "(no output)"}`);
      }
    }
    lines.push("");
  }

  if (errors.length > 0) {
    lines.push(`## Errors (${errors.length})`);
    lines.push(
      "One tool's classify failure doesn't drop the rest of the run — recorded here rather than silently omitted.",
    );
    for (const error of errors) lines.push(`- ${error}`);
    lines.push("");
  }

  return lines.join("\n");
}

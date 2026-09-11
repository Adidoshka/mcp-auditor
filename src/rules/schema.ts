/**
 * rules/schema.ts — deterministic checks for overbroad tool parameters.
 *
 * Phase 1 constraint: zero model calls. Every issue here comes from
 * reading a tool's JSON Schema, nothing else.
 *
 * This ships the naive version on purpose: flag any string-typed
 * parameter that has no enum constraint. It's wrong on this project's
 * own honest tools — it flags search_notes' free-text query, plus
 * compile_account_summary's accountId and send_email_notification's
 * subject/body, none of which ground-truth.yaml calls an issue. That
 * failure is the point: "no enum" is a proxy for "arbitrary value,"
 * and the proxy breaks the moment a parameter's job genuinely is to
 * hold arbitrary text. A better rule needs a second signal — the
 * parameter's own name, its sibling parameters, the tool's stated
 * purpose — to tell those cases apart. This version doesn't have one.
 *
 * Also naive in scope: only top-level parameters are inspected. A
 * string nested inside an array-of-objects parameter (like the `label`
 * field inside generate_expense_summary's `entries`) isn't reached.
 * Recursing into nested schemas is a reasonable next step, not a
 * silent gap to leave undocumented.
 */

import type { AuditedTool, ParameterSchema } from "../mcp/client.js";
import type { SchemaFinding } from "../findings.js";

export function checkSchema(tool: AuditedTool): SchemaFinding[] {
  return findUnconstrainedStrings(tool);
}

function findUnconstrainedStrings(tool: AuditedTool): SchemaFinding[] {
  const findings: SchemaFinding[] = [];
  for (const [name, schema] of Object.entries(tool.inputSchema.properties)) {
    if (isUnconstrainedString(schema)) {
      findings.push({
        mechanism: "schema",
        tool: tool.name,
        parameter: name,
        issue: "unconstrained_string",
        detail: `"${name}" is typed string with no enum constraint.`,
      });
    }
  }
  return findings;
}

function isUnconstrainedString(schema: ParameterSchema): boolean {
  return schema.type === "string" && schema.enum === undefined;
}

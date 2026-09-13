/**
 * graph/probeArgs.ts — synthesizes a benign argument set for the deep
 * probe's real invocation.
 *
 * Two tiers, in priority order:
 *
 * 1. Curated, per-tool arguments for target-server specifically — we
 *    own it, we know its mock data, so the probe can use a real
 *    document path or a real config key and get back something
 *    meaningful to show, rather than a generic placeholder that just
 *    triggers the tool's own "not found" branch.
 * 2. A generic, schema-derived fallback for any tool this project
 *    doesn't have curated arguments for (an unknown server's tools,
 *    say). It fills required parameters with type-appropriate
 *    placeholders — safe in the sense of "won't throw a validation
 *    error," not in the sense of "guaranteed harmless on every real
 *    server." A write-shaped tool's fallback probe genuinely performs
 *    that write; the interrupt() gate before invocation is what makes
 *    that acceptable, not this function refusing to try.
 *
 * Tier 1 used to be keyed on `tool.name` alone, with no check that the
 * connected server was actually target-server — a real gap, not just
 * an inaccurate comment: point `--target` at any server exposing a
 * tool literally named `send_email_notification` and the curated
 * recipient/subject/body would have fired against it, not a
 * placeholder. `isTargetServerInvocation` closes that by requiring the
 * spawn command itself to reference this project's own fixture script
 * before tier 1 applies at all. That's still a heuristic on the
 * command line, not a cryptographic identity check — an operator could
 * misconfigure `--target` to spawn something else via an identically
 * named script path — but it moves the thing being trusted from "a
 * string the audited server chose" (its tool name, free for any server
 * to pick) to "a string the auditor's own operator chose" (the command
 * being audited), which is the actual trust boundary here. `interrupt()`
 * remains the real backstop regardless of which tier fires.
 */

import { join, sep } from "node:path";
import type { AuditedTool, ParameterSchema, StdioServerTarget } from "../mcp/client.js";

const TARGET_SERVER_SCRIPT = join("target-server", "server.ts");

/**
 * True only when `target`'s own command line references this project's
 * target-server/server.ts — see the file header for why this, and not
 * the tool name being probed, is the right thing to check.
 */
export function isTargetServerInvocation(target: StdioServerTarget): boolean {
  return (target.args ?? []).some((arg) => {
    const normalized = arg.replaceAll("/", sep).replaceAll("\\", sep);
    return normalized === TARGET_SERVER_SCRIPT || normalized.endsWith(sep + TARGET_SERVER_SCRIPT);
  });
}

const TARGET_SERVER_PROBE_ARGS: Readonly<Record<string, Record<string, unknown>>> = {
  get_weather: { city: "london" },
  convert_currency: { amount: 10, from: "USD", to: "EUR" },
  get_current_time: { timezone: "UTC" },
  roll_dice: { sides: 6, count: 2 },
  search_notes: { query: "meeting" },
  read_document: { path: "docs/onboarding.md" },
  read_user_settings: { path: "users/alice/settings.json" },
  generate_expense_summary: { entries: [{ label: "probe entry", amount: 1 }] },
  compile_account_summary: {
    accountId: "probe-account",
    lineItems: [{ label: "probe line", value: 1 }],
  },
  read_config_value: { key: "theme" },
  send_email_notification: {
    recipient: "ops@example.internal",
    subject: "mcp-auditor deep probe",
    body: "Safe probe invocation from mcp-auditor's Phase 5 deep branch.",
  },
};

export function synthesizeProbeArgs(
  tool: AuditedTool,
  target: StdioServerTarget,
): Record<string, unknown> {
  const curated = isTargetServerInvocation(target) ? TARGET_SERVER_PROBE_ARGS[tool.name] : undefined;
  if (curated !== undefined) return curated;
  return synthesizeGenericArgs(tool);
}

function synthesizeGenericArgs(tool: AuditedTool): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const name of tool.inputSchema.required) {
    const schema = tool.inputSchema.properties[name];
    if (schema === undefined) continue;
    args[name] = synthesizeValue(schema);
  }
  return args;
}

function synthesizeValue(schema: ParameterSchema): unknown {
  if (schema.enum !== undefined && schema.enum.length > 0) return schema.enum[0];
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case "number":
    case "integer":
      return schema.minimum ?? 0;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object":
      return {};
    default:
      return "probe";
  }
}

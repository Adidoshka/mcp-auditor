/**
 * findings.ts — the shared shape every rule (and later, the LLM node)
 * reports through.
 *
 * Per CLAUDE.md: every finding records which mechanism produced it, so
 * the report can show how many findings came from deterministic rules
 * versus the model. `mechanism` is not optional anywhere in this union
 * on purpose — there's no path to a finding that doesn't know its own
 * origin.
 */

export type FindingMechanism = "schema" | "capability" | "llm";

export type SchemaIssueType = "unconstrained_string";

export interface SchemaFinding {
  mechanism: "schema";
  tool: string;
  parameter: string;
  issue: SchemaIssueType;
  detail: string;
}

export interface CapabilityFinding {
  mechanism: "capability";
  source: string;
  sink: string;
  detail: string;
}

export type Finding = SchemaFinding | CapabilityFinding;

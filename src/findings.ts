/**
 * findings.ts — the shared shape every rule (and later, the LLM node)
 * reports through.
 *
 * Per CLAUDE.md: every finding records which mechanism produced it, so
 * the report can show how many findings came from deterministic rules
 * versus the model. `mechanism` is not optional anywhere in this union
 * on purpose — there's no path to a finding that doesn't know its own
 * origin.
 *
 * InjectionFinding.skills extends that same idea to a narrower case:
 * which skill (llm/skills.ts) was loaded alongside the base rubric for
 * this call, if any. Skill selection is driven by a tool's capability
 * labels — schema shape and name, per rules/capability.ts — which is a
 * schema/name-derived signal reaching the model even though the raw
 * schema and name never do. That's a disclosed, bounded exception to
 * "the classifier sees the description only," not a silent one:
 * recording it on the finding itself means a reader can see that a
 * given verdict came from the model plus a specific skill, not the
 * model alone.
 */

export type FindingMechanism = "schema" | "capability" | "llm";

/**
 * Capability-specific skill names — see llm/skills.ts. Declared here,
 * not in llm/, so findings.ts (imported by rules/capability.ts) never
 * has to import back out of llm/ to describe its own finding shape.
 */
export type SkillName = "reads_local" | "writes_external";

export type SchemaIssueType = "unconstrained_string" | "unconstrained_path";

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

export interface InjectionFinding {
  mechanism: "llm";
  tool: string;
  confidence: number;
  evidence: string;
  /** Empty array, not a separate "none" member — same set-valued convention as Capability. */
  skills: readonly SkillName[];
  detail: string;
}

export type Finding = SchemaFinding | CapabilityFinding | InjectionFinding;

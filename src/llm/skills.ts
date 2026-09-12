/**
 * llm/skills.ts — loads and selects capability-specific skills.
 *
 * Two responsibilities live here on purpose, and neither belongs in
 * classify.ts:
 *
 * - Loading a skill's text from disk (loadSkillText), same pattern as
 *   classify.ts's own prompts/v1.md loader — never inlined, per
 *   CLAUDE.md.
 * - Deciding which skill(s) apply to a tool (selectSkills), which
 *   needs that tool's capability labels — schema shape and name, from
 *   rules/capability.ts. classify.ts's one job is deciding injected or
 *   not; deciding which skill to hand it first is a different,
 *   deterministic decision, so it gets its own function instead of
 *   growing classifyDescription's job list. Selection reads
 *   capability labels, never the description — same rule labelTool
 *   itself follows, for the same reason: a hostile description can
 *   claim anything for free, so nothing that decides what the model
 *   sees should be steered by the text the model is about to judge.
 *
 * A tool with no capability label gets no skill — there's nothing
 * here to calibrate against, and it's also a clean baseline arm: does
 * a no-skill call, a skill-matched call, and a tool that never gets a
 * skill at all (by construction, not by omission) all behave the way
 * they should. See findings.ts's header for why the selected skill(s)
 * get recorded on the finding rather than left implicit.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Capability } from "../rules/capability.js";
import type { SkillName } from "../findings.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(__dirname, "..", "skills");

const cache = new Map<SkillName, string>();

/** Loads one skill's text from disk. Never inlined — same reasoning as prompts/v1.md. */
export function loadSkillText(name: SkillName): string {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  const text = readFileSync(join(SKILLS_DIR, `${name}.md`), "utf-8");
  cache.set(name, text);
  return text;
}

/**
 * Which skill(s) apply to a tool, from its capability labels alone.
 * Set-valued in, set-valued out: a tool labeled both reads_local and
 * writes_external (capability.ts's "self-contained exfiltration tool"
 * case) gets both skills, not one picked over the other. An empty
 * capability set returns an empty array — no skill loaded, not a
 * fallback to some default one.
 */
export function selectSkills(capabilities: ReadonlySet<Capability>): readonly SkillName[] {
  const skills: SkillName[] = [];
  if (capabilities.has("reads_local")) skills.push("reads_local");
  if (capabilities.has("writes_external")) skills.push("writes_external");
  return skills;
}

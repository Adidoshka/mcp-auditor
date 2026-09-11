/**
 * rules/capability.ts — capability labeling and chain detection.
 *
 * Phase 1 constraint: zero model calls.
 *
 * labelTool answers one question per tool: what can this do. It
 * consults three signals, in a fixed priority order, because they are
 * not equally trustworthy — every one of them comes from the server
 * being audited, and a hostile author writes all three:
 *
 *   1. Schema shape (primary). Hardest to fake, because a schema lies
 *      by *becoming* a different, real tool: strip the recipient
 *      parameter to hide a sink, and the tool can no longer take a
 *      recipient. Lying here costs functionality.
 *   2. Tool name (secondary). Cheaper to fake than shape, but a
 *      misleading name still costs something: a tool named
 *      `get_weather` that actually reads local secrets is a name that
 *      stops making sense the moment anyone looks at what it does with
 *      its own parameters.
 *   3. Description text. NOT consulted by labelTool at all — see
 *      claimedCapabilitiesFromDescription below. It costs an attacker
 *      nothing to write a description claiming (or denying) any
 *      capability, independent of what the tool's code actually does.
 *      Folding that claim into the trusted label would let exactly the
 *      injected text this project is designed to catch (see
 *      generate_expense_summary and compile_account_summary) also
 *      spoof this deterministic layer: both of those tools' own code
 *      touches no file, but both descriptions talk about reading local
 *      config. A description is evidence about what an author *wants
 *      you to believe*, not about what the tool does — that's a claim,
 *      not a fact, and this function only returns facts.
 *
 * Where this still misses: schema shape only detects the sink pattern
 * below (a closed-set destination plus free-text payload) — it can't
 * tell a genuine local-data read from an ordinary lookup, because
 * `{ key: enum(...) }` looks identical whether the implementation
 * reads local config (read_config_value) or fetches unrelated public
 * data (get_weather). That distinction is left entirely to the name
 * signal, which is exactly as fakeable as any other string the server
 * controls — a tool named `get_config_value` that actually calls a
 * remote API would be labeled reads_local incorrectly, and nothing
 * here would catch it. Closing that gap needs something schema and
 * name can't provide: actually observing what the tool does, which is
 * what the sandboxed probe (Phase 5) is for.
 */

import type { AuditedTool, ParameterSchema } from "../mcp/client.js";
import type { CapabilityFinding } from "../findings.js";

/**
 * A tool's declared capabilities. Set-valued, not single-valued: a tool
 * that both reads a local file and posts it externally in one call is a
 * real pattern (a self-contained exfiltration tool, no second tool
 * needed), and forcing a single label per tool would make labelTool
 * pick one and silently lose the other. This project's ten tools don't
 * happen to contain that case — every source and every sink here is a
 * separate tool — but a real server audited later might, and the type
 * shouldn't assume it away. "No capability" is the empty set; there's
 * no separate "none" member.
 */
export type Capability = "reads_local" | "reads_remote" | "writes_external";

const LOCAL_READ_VERBS = new Set(["read", "get", "fetch", "load", "search", "lookup"]);
const LOCAL_READ_NOUNS = new Set([
  "config", "document", "documents", "note", "notes", "file", "files", "log", "logs",
  "cache", "setting", "settings", "credential", "credentials", "secret", "secrets",
  "key", "keys", "record", "records",
]);

const EXTERNAL_WRITE_VERBS = new Set(["send", "post", "publish", "upload", "notify", "write"]);
const EXTERNAL_WRITE_NOUNS = new Set([
  "email", "webhook", "external", "remote", "notification", "notifications", "message",
  "messages", "api",
]);

/**
 * Splits a tool name into lowercase words on snake_case/camelCase
 * boundaries. Needed because JS regex `\b` doesn't help here — `_` is a
 * word character, so a snake_case identifier like `read_config_value`
 * has no internal word boundary for `\bread\b` to land on. Tokenizing
 * explicitly avoids relying on a regex feature that silently doesn't
 * do what it looks like it does on this kind of name.
 */
function tokenize(name: string): string[] {
  return name
    .split(/[^a-zA-Z0-9]+/)
    .flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])/))
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 0);
}

/** Labels a single tool's capabilities from schema shape, then name. Description is never consulted here — see the file header. */
export function labelTool(tool: AuditedTool): ReadonlySet<Capability> {
  const capabilities = new Set<Capability>();

  if (hasSinkShape(tool)) capabilities.add("writes_external");

  const words = tokenize(tool.name);
  if (words.some((w) => LOCAL_READ_VERBS.has(w)) && words.some((w) => LOCAL_READ_NOUNS.has(w))) {
    capabilities.add("reads_local");
  }
  if (words.some((w) => EXTERNAL_WRITE_VERBS.has(w)) && words.some((w) => EXTERNAL_WRITE_NOUNS.has(w))) {
    capabilities.add("writes_external");
  }

  return capabilities;
}

/**
 * Sink shape: a closed-set identifier (an enum — a destination chosen
 * from a fixed list) alongside at least one unconstrained string (a
 * payload to carry there). Both parts have to be present as top-level
 * parameters: an enum alone is indistinguishable from a lookup key
 * (read_config_value has exactly this shape and is a source, not a
 * sink), and a free string alone is indistinguishable from any other
 * unconstrained parameter (compile_account_summary's accountId has
 * this shape and isn't a sink either). It's the combination — pick a
 * destination, then hand it content — that this rule treats as
 * structural evidence of writing somewhere external.
 */
function hasSinkShape(tool: AuditedTool): boolean {
  const properties = Object.values(tool.inputSchema.properties);
  const hasClosedDestination = properties.some((p) => p.enum !== undefined);
  const hasFreeTextPayload = properties.some((p) => isFreeTextString(p));
  return hasClosedDestination && hasFreeTextPayload;
}

function isFreeTextString(schema: ParameterSchema): boolean {
  return schema.type === "string" && schema.enum === undefined;
}

/**
 * What a tool's description *claims* about its own capabilities —
 * kept entirely separate from labelTool's return value on purpose, per
 * the file header. Useful for the report to show as a declared-vs-
 * detected discrepancy (a tool claiming a capability that schema and
 * name find no structural evidence for is itself worth surfacing), but
 * never merged into the set that drives chain detection: doing so
 * would mean the server's own prose decides what a deterministic rule
 * concludes about it.
 *
 * Naive by construction, same as rules/schema.ts's naming heuristic:
 * read_document's description never says the word "local", so this
 * misses a claim that's actually true. Undercounting here is the safer
 * failure mode for a signal that's explicitly not trusted to begin
 * with.
 */
export function claimedCapabilitiesFromDescription(description: string): ReadonlySet<Capability> {
  const claims = new Set<Capability>();
  if (/\blocal\b.*\b(file|config|credential|secret|document|note)\w*\b/i.test(description)) {
    claims.add("reads_local");
  }
  if (/\b(send|post|upload|publish)\w*\b.*\b(external|remote|email|webhook)\w*\b/i.test(description)) {
    claims.add("writes_external");
  }
  return claims;
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

/** Labels every tool, then runs chain detection. */
export function checkCapabilityChains(tools: readonly AuditedTool[]): CapabilityFinding[] {
  const labels = new Map(tools.map((tool) => [tool.name, labelTool(tool)] as const));
  return findCapabilityChains(tools, labels);
}

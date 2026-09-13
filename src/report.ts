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

import type { CapabilityFinding, Finding, InjectionFinding, SchemaFinding } from "./findings.js";
import type { PromptVersion } from "./llm/classify.js";

export interface ProbeResult {
  tool: string;
  /** The tool's own description — carried alongside the probe result so the HTML report (formatReportHtml) can show it next to what was actually observed, without a fourth function parameter. */
  description: string;
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
      "One tool's failure doesn't drop the rest of the run — recorded here rather than silently omitted.",
    );
    for (const error of errors) lines.push(`- ${error}`);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * formatReportHtml — a static HTML rendering of the same three inputs
 * formatReport already turns into text. Built for one reason: three
 * things read better drawn or counted at a glance than listed —
 * mechanism provenance (most findings here came from 0-model-call
 * rules, not the LLM), a capability chain (sources arrowing into a
 * sink), and a deep probe's claimed-vs-observed pairing. Everything
 * else stays exactly as plain as the text version.
 *
 * Self-contained on purpose, same as every other artifact this project
 * ships: inline CSS, no framework, no build step, no JS at all — this
 * is a demo artifact (cli.ts writes it when --out ends in .html), not
 * a dashboard, so there's nothing here to filter, sort, or chart.
 * `escapeHtml` runs on every interpolated string because probe
 * `observed` output and injected descriptions are exactly the kind of
 * untrusted text this project exists to be suspicious of — the report
 * generator doesn't get to trust them either.
 */

// Copied here by hand from eval/results.md, not recomputed — this
// function only ever sees one run's own findings, never eval/run.ts's
// own batches. v1 and v2 both went through eval/run.ts's frozen
// 10-run-per-tool protocol on the 12-tool fixture; v3 didn't (there is
// no run-v3.json) — its evidence is single live-server runs instead, a
// different and weaker kind of measurement, stated as such rather than
// squeezed into the same precision/recall shape as v1/v2. Update this
// block if results.md's numbers change; nothing here re-derives them.
const PROMPT_VERSION_SUMMARY: Record<PromptVersion, string> = {
  v1: "one frozen 12-tool run — precision 71.4% (25/35), recall 86.2% (25/29), disagreement 8.3% (1/12 tools); 10/120 calls produced no verdict.",
  v2: "one frozen 12-tool run — precision 100.0% (30/30 successful calls), recall 100.0% (30/30 successful calls), disagreement 0.0% (0/12 tools); 10/120 calls produced no verdict.",
  v3: "not run through eval/run.ts's frozen protocol — single live-server runs only (fixture, filesystem, memory, server-everything): both previously diagnosed false positives stopped reproducing (two of those cases are now v3's own worked examples, so that's limited evidence of generalizing), 0 false positives on the entirely unseen server-everything, and all 3 fixture injections caught correctly in that one run.",
};

const MECHANISM_LABEL: Record<Finding["mechanism"], string> = {
  schema: "Schema",
  capability: "Capability",
  llm: "LLM",
};

const MECHANISM_COLOR: Record<Finding["mechanism"], string> = {
  schema: "#64748b",
  capability: "#d97706",
  llm: "#dc2626",
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function formatReportHtml(
  findings: readonly Finding[],
  probes: readonly ProbeResult[] = [],
  errors: readonly string[] = [],
  promptVersion: PromptVersion = "v3",
): string {
  const byMechanism = {
    schema: findings.filter((f): f is SchemaFinding => f.mechanism === "schema"),
    capability: findings.filter((f): f is CapabilityFinding => f.mechanism === "capability"),
    llm: findings.filter((f): f is InjectionFinding => f.mechanism === "llm"),
  };
  const deterministicCount = byMechanism.schema.length + byMechanism.capability.length;

  const body = [
    `<header>
      <h1>mcp-auditor report</h1>
      <p class="subtitle">${findings.length} finding${plural(findings.length)} — grouped by the mechanism that produced them.</p>
    </header>`,
    `<section class="stats">
      ${renderStatTile("schema", byMechanism.schema.length)}
      ${renderStatTile("capability", byMechanism.capability.length)}
      ${renderStatTile("llm", byMechanism.llm.length)}
    </section>`,
    `<p class="argument"><strong>${deterministicCount}</strong> of ${findings.length} finding${plural(findings.length)} came from deterministic rules — <strong>0 model calls</strong>. Only <strong>${byMechanism.llm.length}</strong> came from the classifier.</p>`,
    renderMechanismSection("schema", byMechanism.schema),
    renderMechanismSection("capability", byMechanism.capability),
    renderCapabilityChainSvg(byMechanism.capability),
    renderLlmSection(byMechanism.llm),
    renderProbesSection(probes),
    renderErrorsSection(errors),
    `<footer>
      <p>Classifier's own measured behavior for prompt <code>${promptVersion}</code> (<code>eval/results.md</code>) —
      ${PROMPT_VERSION_SUMMARY[promptVersion]}
      Read as evidence about this classifier, not a general accuracy claim — a repeated v1 baseline alone moved 7.1 recall points between two identical runs.</p>
    </footer>`,
  ]
    .filter((section) => section.length > 0)
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mcp-auditor report</title>
<style>${REPORT_CSS}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

function plural(count: number): string {
  return count === 1 ? "" : "s";
}

function renderStatTile(mechanism: Finding["mechanism"], count: number): string {
  return `<div class="stat-tile" style="--accent:${MECHANISM_COLOR[mechanism]}">
    <div class="stat-count">${count}</div>
    <div class="stat-label">${MECHANISM_LABEL[mechanism]}</div>
  </div>`;
}

function renderMechanismSection(mechanism: "schema" | "capability", group: readonly Finding[]): string {
  if (group.length === 0) return "";
  const items = group.map((f) => `<li>${escapeHtml(f.detail)}</li>`).join("\n");
  return `<section class="mechanism-section" style="--accent:${MECHANISM_COLOR[mechanism]}">
    <h2>${MECHANISM_LABEL[mechanism]} <span class="count">(${group.length})</span></h2>
    <ul>${items}</ul>
  </section>`;
}

/**
 * Draws every reads_local source arrowing into the writes_external
 * sink(s) it could feed — the same (source, sink) pairs
 * findCapabilityChains produces, just laid out instead of listed.
 * Generic over however many distinct sources/sinks a given run has,
 * not hardcoded to this project's own fixture shape.
 */
function renderCapabilityChainSvg(findings: readonly CapabilityFinding[]): string {
  if (findings.length === 0) return "";

  const sources = [...new Set(findings.map((f) => f.source))];
  const sinks = [...new Set(findings.map((f) => f.sink))];
  const sourceRow = new Map(sources.map((s, i) => [s, i] as const));
  const sinkRow = new Map(sinks.map((s, i) => [s, i] as const));

  const rowHeight = 44;
  const nodeWidth = 150;
  const width = 560;
  const topPad = 24;
  const leftX = 12;
  const rightX = width - nodeWidth - 12;
  const height = topPad * 2 + Math.max(sources.length, sinks.length) * rowHeight;

  const nodeSvg = (name: string, x: number, row: number, cls: string): string => {
    const y = topPad + row * rowHeight;
    return `<rect x="${x}" y="${y}" width="${nodeWidth}" height="30" rx="6" class="node ${cls}" />
      <text x="${x + nodeWidth / 2}" y="${y + 19}" text-anchor="middle" class="node-label">${escapeHtml(name)}</text>`;
  };

  const edges = findings
    .map((f) => {
      const sy = topPad + (sourceRow.get(f.source) ?? 0) * rowHeight + 15;
      const ty = topPad + (sinkRow.get(f.sink) ?? 0) * rowHeight + 15;
      const x1 = leftX + nodeWidth;
      const x2 = rightX;
      return `<path d="M ${x1} ${sy} C ${x1 + 60} ${sy}, ${x2 - 60} ${ty}, ${x2} ${ty}" class="edge" marker-end="url(#arrow)" />`;
    })
    .join("\n");

  const sourceNodes = sources.map((name, i) => nodeSvg(name, leftX, i, "source")).join("\n");
  const sinkNodes = sinks.map((name, i) => nodeSvg(name, rightX, i, "sink")).join("\n");

  return `<section class="chain-section">
    <h2>Capability chains <span class="count">(${findings.length})</span></h2>
    <p class="chain-caption">Every <code>reads_local</code> source that could feed a <code>writes_external</code> sink.</p>
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Capability chain diagram: sources arrowing into sinks">
      <defs>
        <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6 Z" class="arrowhead" />
        </marker>
      </defs>
      ${edges}
      ${sourceNodes}
      ${sinkNodes}
    </svg>
  </section>`;
}

/**
 * The one section that departs from formatReport's flat bullet list:
 * a bare "injected" verdict reads as authoritative, and this project's
 * whole argument is that it's a probabilistic judgment sitting on top
 * of deterministic rules, not a source of truth. Showing confidence as
 * a value *and* a fill bar is what makes "uncertain" visible instead
 * of implied.
 */
function renderLlmSection(findings: readonly InjectionFinding[]): string {
  if (findings.length === 0) return "";
  const items = findings
    .map((f) => {
      const pct = Math.round(f.confidence * 100);
      const skills =
        f.skills.length > 0
          ? `<p class="skills">skills: ${f.skills.map(escapeHtml).join(", ")}</p>`
          : "";
      return `<li class="llm-finding">
        <div class="llm-head">
          <strong>${escapeHtml(f.tool)}</strong>
          <span class="confidence-value">confidence ${f.confidence.toFixed(2)}</span>
        </div>
        <div class="confidence-bar"><div class="confidence-fill" style="width:${pct}%"></div></div>
        <p class="evidence">&ldquo;${escapeHtml(f.evidence)}&rdquo;</p>
        ${skills}
      </li>`;
    })
    .join("\n");
  return `<section class="mechanism-section" style="--accent:${MECHANISM_COLOR.llm}">
    <h2>${MECHANISM_LABEL.llm} <span class="count">(${findings.length})</span></h2>
    <ul class="llm-list">${items}</ul>
  </section>`;
}

/** Claimed (the tool's own description) next to observed (what the approved invocation actually returned) — the pairing the text report makes you scroll to compare by hand. */
function renderProbesSection(probes: readonly ProbeResult[]): string {
  if (probes.length === 0) return "";
  const rows = probes
    .map((p) => {
      const observedText = p.approved ? (p.observed ?? "(no output)") : "not approved — invocation skipped";
      return `<div class="probe-row">
        <div class="probe-tool">${escapeHtml(p.tool)}<div class="probe-args">args: ${escapeHtml(JSON.stringify(p.args))}</div></div>
        <div class="probe-col">
          <div class="probe-col-label">Claimed (description)</div>
          <div class="probe-text">${escapeHtml(p.description)}</div>
        </div>
        <div class="probe-col">
          <div class="probe-col-label">Observed${p.approved ? "" : " — skipped"}</div>
          <div class="probe-text${p.approved ? "" : " skipped"}">${escapeHtml(observedText)}</div>
        </div>
      </div>`;
    })
    .join("\n");
  return `<section class="probes-section">
    <h2>Deep probe <span class="count">(${probes.length})</span></h2>
    ${rows}
  </section>`;
}

function renderErrorsSection(errors: readonly string[]): string {
  if (errors.length === 0) return "";
  const items = errors.map((e) => `<li>${escapeHtml(e)}</li>`).join("\n");
  return `<section class="errors-section">
    <h2>Errors <span class="count">(${errors.length})</span></h2>
    <p class="errors-caption">One tool's failure doesn't drop the rest of the run. Classifier failures can land on different tools across otherwise identical runs.</p>
    <ul>${items}</ul>
  </section>`;
}

const REPORT_CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 32px 24px 64px; max-width: 860px; margin-inline: auto;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color: #1e293b; background: #f8fafc; line-height: 1.5;
}
header h1 { margin-bottom: 4px; font-size: 1.6rem; }
.subtitle { color: #64748b; margin-top: 0; }
.stats { display: flex; gap: 12px; margin: 24px 0; flex-wrap: wrap; }
.stat-tile { flex: 1 1 120px; border-top: 4px solid var(--accent); background: #fff; border-radius: 8px; padding: 14px 16px; box-shadow: 0 1px 2px rgba(0,0,0,.06); }
.stat-count { font-size: 2rem; font-weight: 700; }
.stat-label { color: #64748b; font-size: .85rem; text-transform: uppercase; letter-spacing: .04em; }
.argument { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px 16px; margin-bottom: 28px; }
.mechanism-section, .chain-section, .probes-section, .errors-section {
  background: #fff; border: 1px solid #e2e8f0; border-left: 4px solid var(--accent, #94a3b8);
  border-radius: 8px; padding: 16px 20px; margin-bottom: 20px;
}
.mechanism-section h2, .chain-section h2, .probes-section h2, .errors-section h2 { margin-top: 0; font-size: 1.05rem; }
.count { color: #94a3b8; font-weight: 400; }
ul { margin: 8px 0 0; padding-left: 20px; }
li { margin-bottom: 6px; }
.chain-caption, .errors-caption { color: #64748b; font-size: .9rem; margin-top: -4px; }
svg { width: 100%; height: auto; margin-top: 12px; }
.node.source { fill: #ecfdf5; stroke: #059669; stroke-width: 1.5; }
.node.sink { fill: #fef2f2; stroke: #dc2626; stroke-width: 1.5; }
.node-label { font-size: 12px; fill: #1e293b; }
.edge { fill: none; stroke: #94a3b8; stroke-width: 1.5; }
.arrowhead { fill: #94a3b8; }
.llm-list { list-style: none; padding-left: 0; }
.llm-finding { border: 1px solid #fecaca; border-radius: 6px; padding: 10px 14px; margin-bottom: 10px; }
.llm-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
.confidence-value { font-size: .85rem; color: #64748b; white-space: nowrap; }
.confidence-bar { height: 6px; background: #fee2e2; border-radius: 3px; margin: 6px 0; overflow: hidden; }
.confidence-fill { height: 100%; background: #dc2626; }
.evidence { font-style: italic; color: #475569; margin: 6px 0 0; }
.skills { font-size: .8rem; color: #94a3b8; margin: 4px 0 0; }
.probe-row { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; padding: 12px 0; border-bottom: 1px solid #f1f5f9; }
.probe-row:last-child { border-bottom: none; }
.probe-tool { font-weight: 600; }
.probe-args { font-weight: 400; font-size: .8rem; color: #94a3b8; margin-top: 4px; }
.probe-col-label { font-size: .75rem; text-transform: uppercase; letter-spacing: .04em; color: #94a3b8; margin-bottom: 4px; }
.probe-text { font-size: .9rem; white-space: pre-wrap; }
.probe-text.skipped { color: #94a3b8; font-style: italic; }
footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid #e2e8f0; color: #64748b; font-size: .85rem; }
footer code { background: #f1f5f9; padding: 1px 5px; border-radius: 4px; }
@media (max-width: 600px) { .probe-row { grid-template-columns: 1fr; } }
`;

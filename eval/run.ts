/**
 * eval/run.ts — Phase 4's eval loop.
 *
 * Per PLAN.md: 10 runs at temperature 0 across every tool in
 * target-server, compared against ground-truth.yaml's `injection`
 * field. Three numbers come out: precision, recall, and disagreement
 * rate — the last one is why this runs 10 times per tool instead of
 * once. Temperature 0 doesn't guarantee identical outputs even on
 * models that accept it; disagreement rate is what measures that,
 * not something the protocol expects to find zero of by construction.
 *
 * Skill selection matches production, not an isolated "prompt only"
 * path: each tool's capabilities (rules/capability.ts) decide its
 * skill(s) (llm/skills.ts) exactly the way buildInjectionFinding's
 * real call site would. The eval measures the system as it actually
 * runs, not a stripped-down version of it.
 *
 * Concurrency is bounded via concurrency.ts's mapWithConcurrency — the
 * first real caller for it, per that file's own header comment. That
 * function is fail-fast on its own (see its doc comment); the try/catch
 * around each task below, not mapWithConcurrency, is what turns a
 * failed call (SlowError/RefusingError/MalformedError, even after
 * retry.ts's retries) into a recorded error outcome instead of an
 * exception that would abort the whole batch. Errors are reported, not
 * silently dropped from the denominator.
 *
 * Usage: npx tsx eval/run.ts [v1|v2|v3]  (default v1)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { listAuditedTools } from "../src/mcp/client.js";
import { labelTool } from "../src/rules/capability.js";
import { selectSkills } from "../src/llm/skills.js";
import { classifyDescription, PROMPT_VERSIONS, type PromptVersion } from "../src/llm/classify.js";
import { mapWithConcurrency, DEFAULT_CONCURRENCY_LIMIT } from "../src/concurrency.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const RUNS_PER_TOOL = 10;

interface GroundTruthEntry {
  name: string;
  injection: boolean;
}

function loadGroundTruth(): Map<string, boolean> {
  const raw = readFileSync(join(REPO_ROOT, "target-server", "ground-truth.yaml"), "utf-8");
  const entries = parseYaml(raw) as GroundTruthEntry[];
  return new Map(entries.map((e) => [e.name, e.injection]));
}

interface RunOutcome {
  tool: string;
  runIndex: number;
  skills: readonly string[];
  result:
    | { ok: true; verdict: "injected" | "not_injected"; confidence: number; evidence: string }
    | { ok: false; errorKind: string; message: string };
}

async function main() {
  const promptVersion = (process.argv[2] ?? "v1") as PromptVersion;
  if (!PROMPT_VERSIONS.includes(promptVersion)) {
    throw new Error(
      `eval/run.ts: unknown prompt version "${promptVersion}" (expected one of ${PROMPT_VERSIONS.join(", ")})`,
    );
  }

  const groundTruth = loadGroundTruth();
  const tools = await listAuditedTools({
    command: "npx",
    args: ["tsx", "target-server/server.ts"],
    cwd: REPO_ROOT,
  });

  console.log(
    `${tools.length} tools, ${RUNS_PER_TOOL} runs each = ${tools.length * RUNS_PER_TOOL} calls, prompt ${promptVersion}, concurrency ${DEFAULT_CONCURRENCY_LIMIT}.\n`,
  );

  const tasks = tools.flatMap((tool) => {
    const skills = selectSkills(labelTool(tool));
    return Array.from({ length: RUNS_PER_TOOL }, (_, runIndex) => ({ tool, skills, runIndex }));
  });

  const startedAt = Date.now();
  const outcomes = await mapWithConcurrency(tasks, DEFAULT_CONCURRENCY_LIMIT, async (task) => {
    try {
      const verdict = await classifyDescription(task.tool.description, {
        skills: task.skills,
        temperature: 0,
        promptVersion,
      });
      const outcome: RunOutcome = {
        tool: task.tool.name,
        runIndex: task.runIndex,
        skills: task.skills,
        result: { ok: true, ...verdict },
      };
      return outcome;
    } catch (error) {
      const kind = (error as { kind?: string }).kind ?? "unknown";
      const message = error instanceof Error ? error.message : String(error);
      const outcome: RunOutcome = {
        tool: task.tool.name,
        runIndex: task.runIndex,
        skills: task.skills,
        result: { ok: false, errorKind: kind, message },
      };
      return outcome;
    }
  });
  const elapsedMs = Date.now() - startedAt;

  // --- Metrics ---
  let truePositives = 0;
  let falsePositives = 0;
  let trueNegatives = 0;
  let falseNegatives = 0;
  let errorCount = 0;

  const byTool = new Map<string, RunOutcome[]>();
  for (const outcome of outcomes) {
    if (!byTool.has(outcome.tool)) byTool.set(outcome.tool, []);
    byTool.get(outcome.tool)!.push(outcome);

    if (!outcome.result.ok) {
      errorCount++;
      continue;
    }
    const expected = groundTruth.get(outcome.tool);
    if (expected === undefined) continue; // shouldn't happen; every fixture tool has a ground-truth entry
    const predictedInjected = outcome.result.verdict === "injected";
    if (predictedInjected && expected) truePositives++;
    else if (predictedInjected && !expected) falsePositives++;
    else if (!predictedInjected && expected) falseNegatives++;
    else trueNegatives++;
  }

  const precision =
    truePositives + falsePositives > 0 ? truePositives / (truePositives + falsePositives) : NaN;
  const recall =
    truePositives + falseNegatives > 0 ? truePositives / (truePositives + falseNegatives) : NaN;

  // Disagreement rate: per PLAN.md, "how often identical input gave
  // different verdicts" — measured per tool (did its 10 identical
  // calls ever produce more than one distinct verdict), not per call,
  // since the thing being measured is instability under repetition,
  // not raw accuracy.
  let disagreeingTools = 0;
  const disagreementDetail: string[] = [];
  for (const [tool, results] of byTool) {
    const verdicts = results.filter((r) => r.result.ok).map((r) => (r.result as any).verdict);
    const distinct = new Set(verdicts);
    if (distinct.size > 1) {
      disagreeingTools++;
      disagreementDetail.push(`${tool}: ${verdicts.join(", ")}`);
    }
  }
  const toolsWithAnyResult = [...byTool.values()].filter((rs) =>
    rs.some((r) => r.result.ok),
  ).length;
  const disagreementRate = toolsWithAnyResult > 0 ? disagreeingTools / toolsWithAnyResult : NaN;

  console.log(`Done in ${(elapsedMs / 1000).toFixed(1)}s.\n`);
  console.log(`Precision: ${truePositives}/${truePositives + falsePositives} = ${(precision * 100).toFixed(1)}%`);
  console.log(`Recall:    ${truePositives}/${truePositives + falseNegatives} = ${(recall * 100).toFixed(1)}%`);
  console.log(
    `Disagreement rate: ${disagreeingTools}/${toolsWithAnyResult} tools = ${(disagreementRate * 100).toFixed(1)}%`,
  );
  console.log(`Errors: ${errorCount}/${outcomes.length} calls`);
  console.log(
    `Confusion: TP=${truePositives} FP=${falsePositives} TN=${trueNegatives} FN=${falseNegatives}`,
  );
  if (disagreementDetail.length > 0) {
    console.log(`\nDisagreeing tools:`);
    for (const line of disagreementDetail) console.log(`  ${line}`);
  }

  console.log(`\nPer-tool breakdown:`);
  for (const [tool, results] of byTool) {
    const expected = groundTruth.get(tool);
    const verdicts = results.map((r) =>
      r.result.ok ? r.result.verdict : `ERROR(${r.result.errorKind})`,
    );
    console.log(`  ${tool.padEnd(28)} expected=${String(expected).padEnd(6)} ${verdicts.join(",")}`);
  }

  const outPath = join(__dirname, `run-${promptVersion}.json`);
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        promptVersion,
        runsPerTool: RUNS_PER_TOOL,
        concurrency: DEFAULT_CONCURRENCY_LIMIT,
        elapsedMs,
        metrics: {
          precision,
          recall,
          disagreementRate,
          truePositives,
          falsePositives,
          trueNegatives,
          falseNegatives,
          errorCount,
        },
        outcomes,
      },
      null,
      2,
    ),
  );
  console.log(`\nRaw results written to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

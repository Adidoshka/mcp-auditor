/**
 * cli.ts — runs the Phase 5 graph against a target MCP server.
 *
 * Same thread_id across invocations resumes a previous run rather than
 * starting a new one: on startup this checks the checkpoint for
 * pending interrupts via `compiled.getState()` *before* invoking with
 * fresh input — confirmed empirically (two genuinely separate process
 * invocations, no shared memory) that a killed process's pending
 * interrupts are fully recoverable from the SQLite checkpoint alone.
 * That's the actual mechanism behind PLAN.md's "kill mid-run, resume,
 * prove state persisted" — not a claim, a tested one.
 *
 * Usage:
 *   npx tsx src/cli.ts [--thread <id>] [--db <path>] [--out <path>] [--prompt-version <v1|v2|v3>] [--target <command> [...args]]
 *
 * Default thread id is stable ("default") so re-running without
 * --thread naturally continues an interrupted prior run. Completed
 * threads are rejected because reducer-backed state would otherwise
 * accumulate; pass a new --thread to start another audit. --out saves the final report to a file in
 * addition to printing it — for a live demo, so the report doesn't
 * scroll off with the approval prompts, and so a committed example
 * report shows the real output to anyone browsing the repo instead of
 * requiring them to run it or infer it from report.ts.
 *
 * --prompt-version picks which prompts/*.md the classify node runs
 * (default "v2", matching graph/nodes.ts's own default) — the CLI is
 * the one place a person actually chooses, so it's the one place this
 * needs to be a flag rather than a hardcoded call site.
 *
 * --out's bare-filename handling (filed and prefixed by prompt version)
 * is documented at resolveOutPath below, next to the code that does it.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { Command } from "@langchain/langgraph";
import { buildAuditGraph } from "./graph/graph.js";
import { formatReportHtml, type ProbeResult } from "./report.js";
import type { Finding } from "./findings.js";
import type { StdioServerTarget } from "./mcp/client.js";
import { PROMPT_VERSIONS, type PromptVersion } from "./llm/classify.js";

// node:readline/promises's question(), called repeatedly, stalls
// forever on the second call against piped (non-TTY) stdin — confirmed
// directly, not assumed, and not specific to this file: a minimal
// two-line repro hangs identically. The async-iterator form of the
// plain callback-based readline module doesn't have this bug, so the
// prompt loop below drives one shared iterator by hand instead of
// calling .question() per prompt.
const stdinInterface = createInterface({ input: process.stdin });
const stdinLines = stdinInterface[Symbol.asyncIterator]();
async function nextLine(): Promise<string> {
  const { value, done } = await stdinLines.next();
  return done ? "" : value;
}

const REPO_ROOT = process.cwd();

interface CliOptions {
  threadId: string;
  dbPath: string;
  outPath: string | undefined;
  promptVersion: PromptVersion;
  target: StdioServerTarget;
}

function parseArgs(argv: string[]): CliOptions {
  let threadId = "default";
  let dbPath = `${REPO_ROOT}/.mcp-auditor-checkpoints.sqlite`;
  let outPath: string | undefined;
  let promptVersion: PromptVersion = "v2";
  let target: StdioServerTarget = {
    command: "npx",
    args: ["tsx", "target-server/server.ts"],
    cwd: REPO_ROOT,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--thread" && argv[i + 1] !== undefined) threadId = argv[++i]!;
    if (argv[i] === "--db" && argv[i + 1] !== undefined) dbPath = argv[++i]!;
    if (argv[i] === "--out" && argv[i + 1] !== undefined) outPath = argv[++i]!;
    if (argv[i] === "--prompt-version" && argv[i + 1] !== undefined) {
      const value = argv[++i]!;
      if (!PROMPT_VERSIONS.includes(value as PromptVersion)) {
        throw new Error(`--prompt-version must be one of ${PROMPT_VERSIONS.join(", ")}, got "${value}"`);
      }
      promptVersion = value as PromptVersion;
    }
    if (argv[i] === "--target") {
      const command = argv[i + 1];
      if (command === undefined) throw new Error("--target requires a command");
      target = { command, args: argv.slice(i + 2), cwd: REPO_ROOT };
      break;
    }
  }
  return { threadId, dbPath, outPath, promptVersion, target };
}

/**
 * A bare filename (no `/` or `\`) is filed under results/<promptVersion>/
 * with the version prefixed onto the filename itself (e.g. `fixture.html`
 * with `--prompt-version v2` becomes `results/v2/v2_fixture.html`) — so the
 * version is still legible if the file is later moved, opened as a bare
 * tab, or copied out of its folder, not only encoded in the directory.
 * Already-prefixed names aren't prefixed twice, so this stays a no-op on
 * a name that's already `v1_...`/`v2_...`/`v3_...`. Anything containing a
 * separator is an explicit path and passes through unchanged. Creates the
 * destination directory if needed — results/v1, results/v2, results/v3
 * aren't all guaranteed to exist yet.
 */
function resolveOutPath(outPath: string, promptVersion: PromptVersion): string {
  const isBareFilename = !outPath.includes("/") && !outPath.includes("\\") && !isAbsolute(outPath);
  const prefix = `${promptVersion}_`;
  const fileName = isBareFilename && !outPath.startsWith(prefix) ? `${prefix}${outPath}` : outPath;
  const resolved = isBareFilename ? join(REPO_ROOT, "results", promptVersion, fileName) : outPath;
  mkdirSync(dirname(resolved), { recursive: true });
  return resolved;
}

interface PendingInterrupt {
  id: string;
  value: { tool: string; description: string; proposedArgs: Record<string, unknown> };
}

async function promptForApprovals(pending: PendingInterrupt[]): Promise<Record<string, boolean>> {
  const resumeMap: Record<string, boolean> = {};
  for (const p of pending) {
    console.log(`\nFlagged: ${p.value.tool}`);
    console.log(`  description: ${p.value.description}`);
    console.log(`  proposed probe args: ${JSON.stringify(p.value.proposedArgs)}`);
    process.stdout.write(`  invoke ${p.value.tool} with these args for real? [y/N] `);
    const answer = await nextLine();
    resumeMap[p.id] = answer.trim().toLowerCase() === "y";
  }
  return resumeMap;
}

async function main() {
  const { threadId, dbPath, outPath, promptVersion, target } = parseArgs(process.argv.slice(2));
  const graph = buildAuditGraph(target, dbPath, promptVersion);
  const config = { configurable: { thread_id: threadId } };

  console.log(`thread "${threadId}", checkpoint db "${dbPath}", prompt version "${promptVersion}"`);

  const snapshot = await graph.getState(config);
  let result: Record<string, unknown>;

  if (snapshot.next.length > 0) {
    console.log(`Resuming a prior run — found ${snapshot.next.length} pending step(s) on disk.`);
    const pending = snapshot.tasks.flatMap((t) => t.interrupts ?? []) as PendingInterrupt[];
    const resumeMap = await promptForApprovals(pending);
    result = (await graph.invoke(new Command({ resume: resumeMap }), config)) as Record<
      string,
      unknown
    >;
  } else if (typeof snapshot.values.report === "string" && snapshot.values.report.length > 0) {
    throw new Error(`Thread "${threadId}" already completed; start a new run with a new --thread value.`);
  } else {
    console.log("Starting a new run.");
    result = (await graph.invoke({}, config)) as Record<string, unknown>;
  }

  // The graph shape here only interrupts once (at deepProbe), but loop
  // rather than assume — a future graph change adding a second
  // interrupt point shouldn't silently need this file rewritten too.
  while (Array.isArray(result.__interrupt__) && result.__interrupt__.length > 0) {
    const pending = result.__interrupt__ as PendingInterrupt[];
    const resumeMap = await promptForApprovals(pending);
    result = (await graph.invoke(new Command({ resume: resumeMap }), config)) as Record<
      string,
      unknown
    >;
  }

  console.log("\n" + (result.report as string));
  if (outPath !== undefined) {
    // Format is picked from --out's own extension, not a separate flag —
    // one output path, one obvious format. Anything but .html stays the
    // same plain text formatReport already produced above.
    const content = outPath.toLowerCase().endsWith(".html")
      ? formatReportHtml(
          (result.findings as Finding[] | undefined) ?? [],
          (result.probes as ProbeResult[] | undefined) ?? [],
          (result.errors as string[] | undefined) ?? [],
        )
      : (result.report as string);
    const resolvedOutPath = resolveOutPath(outPath, promptVersion);
    writeFileSync(resolvedOutPath, content);
    console.log(`\nReport also written to ${resolvedOutPath}`);
  }
  stdinInterface.close();
}

main().catch((err) => {
  stdinInterface.close();
  console.error(err);
  process.exitCode = 1;
});

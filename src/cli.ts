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
 *   npx tsx src/cli.ts [--thread <id>] [--db <path>] [--out <path>]
 *
 * Default thread id is stable ("default") so re-running without
 * --thread naturally continues an interrupted prior run; pass a new
 * --thread to start over. --out saves the final report to a file in
 * addition to printing it — for a live demo, so the report doesn't
 * scroll off with the approval prompts, and so a committed example
 * report shows the real output to anyone browsing the repo instead of
 * requiring them to run it or infer it from report.ts.
 */

import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { Command } from "@langchain/langgraph";
import { buildAuditGraph } from "./graph/graph.js";
import { formatReportHtml, type ProbeResult } from "./report.js";
import type { Finding } from "./findings.js";

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

function parseArgs(argv: string[]): { threadId: string; dbPath: string; outPath: string | undefined } {
  let threadId = "default";
  let dbPath = `${REPO_ROOT}/.mcp-auditor-checkpoints.sqlite`;
  let outPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--thread" && argv[i + 1] !== undefined) threadId = argv[++i]!;
    if (argv[i] === "--db" && argv[i + 1] !== undefined) dbPath = argv[++i]!;
    if (argv[i] === "--out" && argv[i + 1] !== undefined) outPath = argv[++i]!;
  }
  return { threadId, dbPath, outPath };
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
  const { threadId, dbPath, outPath } = parseArgs(process.argv.slice(2));
  const target = { command: "npx", args: ["tsx", "target-server/server.ts"], cwd: REPO_ROOT };
  const graph = buildAuditGraph(target, dbPath);
  const config = { configurable: { thread_id: threadId } };

  console.log(`thread "${threadId}", checkpoint db "${dbPath}"`);

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
    writeFileSync(outPath, content);
    console.log(`\nReport also written to ${outPath}`);
  }
  stdinInterface.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

/**
 * graph/graph.ts — wires the audit graph together and compiles it.
 *
 * Shape: listTools -> (fan out per tool) -> analyzeTool -> collect ->
 * (flagged tools fan out, or straight through) -> deepProbe -> report.
 *
 * Checkpointer: SqliteSaver, not MemorySaver — a durable, file-backed
 * checkpoint is the minimum that can actually prove state survives a
 * killed process, which is PLAN.md's Phase 5 "done when." MemorySaver
 * lives in the process; killing the process erases it, which would
 * make the kill-and-resume demo prove nothing. better-sqlite3's
 * native build was tested before committing to this — it used a
 * prebuilt binary cleanly on this machine, no native toolchain needed.
 */

import { StateGraph, START, END } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import type { StdioServerTarget } from "../mcp/client.js";
import type { PromptVersion } from "../llm/classify.js";
import { AuditState } from "./state.js";
import { buildNodes } from "./nodes.js";

export function buildAuditGraph(
  target: StdioServerTarget,
  checkpointDbPath: string,
  promptVersion?: PromptVersion,
) {
  const nodes = buildNodes(target, promptVersion);

  const graph = new StateGraph(AuditState)
    .addNode("listTools", nodes.listTools)
    .addNode("analyzeTool", nodes.analyzeTool)
    .addNode("collect", nodes.collect)
    .addNode("deepProbe", nodes.deepProbe)
    .addNode("writeReport", nodes.report)
    .addEdge(START, "listTools")
    .addConditionalEdges("listTools", nodes.fanOutToAnalyze)
    .addEdge("analyzeTool", "collect")
    .addConditionalEdges("collect", nodes.routeAfterCollect)
    .addEdge("deepProbe", "writeReport")
    .addEdge("writeReport", END);

  const checkpointer = SqliteSaver.fromConnString(checkpointDbPath);
  return graph.compile({ checkpointer });
}

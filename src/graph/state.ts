/**
 * graph/state.ts — the audit graph's shared state.
 *
 * Per PLAN.md: `{ tools[], findings[], flagged[], approvals{} }`, plus
 * `probes[]` — added so the deep branch has somewhere to put what it
 * actually observed, not just whether it was approved.
 *
 * `findings`, `probes`, and `approvals` use ReducedValue with a merge
 * reducer rather than a plain field: multiple Send-dispatched node
 * instances write to each of these in the same superstep (one write
 * per tool from the classify fan-out, one per flagged tool from the
 * deep-probe fan-out), and a plain field would have each write
 * clobber the others rather than accumulate them — confirmed
 * empirically before relying on it, not assumed from the docs example
 * alone. `tools` and `flagged` are plain fields: each is written
 * exactly once, by one node, never fanned out into.
 */

import { StateSchema, ReducedValue } from "@langchain/langgraph";
import { z } from "zod";
import type { AuditedTool } from "../mcp/client.js";
import type { Finding } from "../findings.js";
import type { ProbeResult } from "../report.js";

const auditedTool = z.custom<AuditedTool>();
const finding = z.custom<Finding>();
const probeResult = z.custom<ProbeResult>();

export const AuditState = new StateSchema({
  tools: z.array(auditedTool).default(() => []),
  findings: new ReducedValue(z.array(finding).default(() => []), {
    inputSchema: z.array(finding),
    reducer: (current, next) => [...current, ...next],
  }),
  flagged: z.array(auditedTool).default(() => []),
  probes: new ReducedValue(z.array(probeResult).default(() => []), {
    inputSchema: z.array(probeResult),
    reducer: (current, next) => [...current, ...next],
  }),
  /**
   * Per-tool classify failures (SlowError/RefusingError/MalformedError,
   * even after retry.ts's retries) — recorded, not silently dropped,
   * same principle eval/run.ts's error-outcome tracking already
   * established. A malformed response from one tool's classification
   * call shouldn't lose the rest of an audit run.
   */
  errors: new ReducedValue(z.array(z.string()).default(() => []), {
    inputSchema: z.array(z.string()),
    reducer: (current, next) => [...current, ...next],
  }),
  /** Written once, by the final `report` node. */
  report: z.string().default(() => ""),
});

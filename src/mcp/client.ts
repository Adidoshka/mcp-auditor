/**
 * mcp/client.ts — connect to an MCP server over stdio and list its tools.
 *
 * Phase 1 constraint: zero model calls anywhere in this file. Its only
 * job is turning a live `tools/list` response into typed objects the
 * deterministic rules (schema.ts, capability.ts) can run against without
 * re-deriving the MCP SDK's shapes themselves.
 *
 * One-shot by design: connect, list, close. The auditor doesn't hold a
 * session open across the rules pass — there's no reason to, since
 * nothing after this point calls back into the server.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";

/** JSON Schema fragment for a single input parameter — the subset the rules inspect. */
export interface ParameterSchema {
  type?: string | string[];
  enum?: readonly unknown[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  items?: ParameterSchema;
  description?: string;
}

/** A tool's `inputSchema`, narrowed from the SDK's `object`-typed properties. */
export interface InputSchema {
  type: "object";
  properties: Record<string, ParameterSchema>;
  required: string[];
}

/** A tool as reported by `tools/list`, narrowed to what the rules need. */
export interface AuditedTool {
  name: string;
  description: string;
  inputSchema: InputSchema;
}

export interface StdioServerTarget {
  /** Command to spawn the server, e.g. "npx". */
  command: string;
  args?: string[];
  cwd?: string;
}

/**
 * Connects to an MCP server over stdio, lists its tools, and closes the
 * connection.
 */
export async function listAuditedTools(target: StdioServerTarget): Promise<AuditedTool[]> {
  const transport = new StdioClientTransport({
    command: target.command,
    args: target.args ?? [],
    ...(target.cwd !== undefined ? { cwd: target.cwd } : {}),
  });

  const client = new Client({ name: "mcp-auditor", version: "0.1.0" });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    return tools.map(toAuditedTool);
  } finally {
    await client.close();
  }
}

function toAuditedTool(tool: McpTool): AuditedTool {
  return {
    name: tool.name,
    // Missing description is itself worth flagging elsewhere, but that's
    // a rules concern, not this module's — it just refuses to hand the
    // rules an `undefined` to juggle.
    description: tool.description ?? "",
    inputSchema: {
      type: "object",
      properties: (tool.inputSchema.properties ?? {}) as Record<string, ParameterSchema>,
      required: tool.inputSchema.required ?? [],
    },
  };
}

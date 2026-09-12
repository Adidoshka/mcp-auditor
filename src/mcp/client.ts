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
 *
 * Timeouts (Phase 3): connect and listTools get separate timeouts —
 * the MCP SDK's `RequestOptions.timeout` accepts one per call, on both
 * `client.connect()` and `client.listTools()` — because "the process
 * never came up" and "the process is up but tools/list hangs" are
 * different failures worth distinguishing, same reasoning as
 * llm/classify.ts's connect/response split. No retry here: unlike an
 * HTTP status code, nothing in a spawn failure or a stdio handshake
 * says "try again" the way a 429 does — see retry.ts's header for why
 * that project's retry policy is deliberately status-code-scoped, not
 * "retry anything that looks transient."
 *
 * Errors are mapped to SlowError/RefusingError/MalformedError
 * (errors.ts) rather than left as raw McpError/ZodError — confirmed
 * empirically (not assumed) that a nonexistent command surfaces as
 * `McpError` code `ConnectionClosed`, the same code a genuine timeout
 * or dropped connection produces, so both land as SlowError. Any other
 * McpError is the server responding with a real JSON-RPC error, on
 * purpose — RefusingError. A response that parses as JSON-RPC but
 * doesn't match the expected tool-list shape is MalformedError.
 *
 * callTool (Phase 5): a second one-shot operation, same connect/close
 * pattern and error mapping as listAuditedTools, added for the graph's
 * deep-probe node — actually invoking a flagged tool with a benign
 * argument to observe its real behavior, per capability.ts's own
 * forward-reference to "the sandboxed probe (Phase 5)." Each call gets
 * its own connection rather than reusing one across a run; the target
 * servers here are cheap local mocks, and a fresh connection per call
 * keeps this function as simple and self-contained as
 * listAuditedTools rather than introducing session lifetime management
 * for a modest efficiency gain.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { SlowError, RefusingError, MalformedError, type ClassifiedError } from "../errors.js";

// A local subprocess handshake and an in-process tools/list call should
// both be fast; there's no network round-trip to justify the MCP SDK's
// own 60s default (protocol.ts's DEFAULT_REQUEST_TIMEOUT_MSEC, sized for
// a general-purpose remote server). Kept separate, not because either
// value is large, but because a server that spawns fine and then hangs
// specifically on tools/list is a distinct, diagnosable failure from one
// that never comes up at all.
const CONNECT_TIMEOUT_MS = 10_000;
const LIST_TOOLS_TIMEOUT_MS = 15_000;

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
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
    const { tools } = await client.listTools(undefined, { timeout: LIST_TOOLS_TIMEOUT_MS });
    return tools.map(toAuditedTool);
  } catch (error) {
    throw toClassifiedError(error, "listAuditedTools");
  } finally {
    await client.close();
  }
}

/**
 * Invokes one tool with the given arguments and returns its result
 * content as text (joining multiple content blocks, since the rules
 * this feeds only need to compare against a description, not render
 * rich content). Same timeout/error-mapping treatment as
 * listAuditedTools — see the file header.
 */
export async function callTool(
  target: StdioServerTarget,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const transport = new StdioClientTransport({
    command: target.command,
    args: target.args ?? [],
    ...(target.cwd !== undefined ? { cwd: target.cwd } : {}),
  });

  const client = new Client({ name: "mcp-auditor", version: "0.1.0" });

  try {
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
    const result = await client.callTool(
      { name: toolName, arguments: args },
      undefined,
      { timeout: LIST_TOOLS_TIMEOUT_MS },
    );
    const content = Array.isArray(result.content) ? result.content : [];
    return content
      .map((block: { type: string; text?: string }) =>
        block.type === "text" ? (block.text ?? "") : `[${block.type} content]`,
      )
      .join("\n");
  } catch (error) {
    throw toClassifiedError(error, "callTool");
  } finally {
    await client.close();
  }
}

function toClassifiedError(error: unknown, context: string): ClassifiedError {
  if (error instanceof z.ZodError) {
    return new MalformedError(`${context}: server response did not match the expected shape`, {
      cause: error,
    });
  }
  if (error instanceof McpError) {
    // ConnectionClosed and RequestTimeout both mean "nothing usable came
    // back" — confirmed empirically that a nonexistent spawn command
    // also surfaces as ConnectionClosed, not a distinct error shape.
    if (error.code === ErrorCode.ConnectionClosed || error.code === ErrorCode.RequestTimeout) {
      return new SlowError(`${context}: server did not respond in time`, { cause: error });
    }
    // Any other McpError is the server responding with a real JSON-RPC
    // error, on purpose.
    return new RefusingError(`${context}: server refused (${error.code})`, {
      cause: error,
    });
  }
  return new MalformedError(`${context}: unexpected failure`, { cause: error });
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

import { createHash } from 'node:crypto';
import type { ResolvedTool } from './config.js';
import type { Trace } from './events.js';
import type { McpCaller, ToolResult } from './mcp-client.js';
import { getStage } from './pipeline.js';

export class ToolDeniedError extends Error {}
export class McpNotConfiguredError extends Error {}

export interface BrokerDeps {
  /** One caller per configured MCP server, keyed by the server name in the config. */
  callers: Record<string, McpCaller>;
  /** Logical tool name -> server, real tool name, argument renames. */
  tools: Record<string, ResolvedTool>;
  trace: Trace;
  /** Defaults to the stage definition in the pipeline. */
  allowlist?: (stageId: string) => string[];
}

function renameKeys(args: Record<string, unknown>, map?: Record<string, string>): Record<string, unknown> {
  if (!map) return args;
  return Object.fromEntries(Object.entries(args).map(([k, v]) => [map[k] ?? k, v]));
}

/**
 * The only way Jira, Confluence and Bitbucket are reached. Each stage may call only the tools in its
 * allowlist, every call is traced (arguments masked and hashed), and tokens are never part of an event.
 */
export class ToolBroker {
  constructor(private d: BrokerDeps) {}

  /** Is this logical tool mapped to a configured server? Used for optional steps such as Confluence. */
  has(logicalTool: string): boolean {
    const t = this.d.tools[logicalTool];
    return Boolean(t && this.d.callers[t.server]);
  }

  async call(runId: string, stageId: string, logicalTool: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return this.run(runId, stageId, logicalTool, args, (c, tool, a) => c.callTool(tool, a));
  }

  /** Same as call, but returns the raw MCP result (images and other binary content). */
  async callRaw(runId: string, stageId: string, logicalTool: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    return this.run(runId, stageId, logicalTool, args, (c, tool, a) => c.callRaw(tool, a));
  }

  private async run<T>(
    runId: string, stageId: string, logicalTool: string, args: Record<string, unknown>,
    exec: (c: McpCaller, tool: string, a: Record<string, unknown>) => Promise<T>,
  ): Promise<T> {
    const allowed = (this.d.allowlist ?? ((id: string) => getStage(id).mcpTools))(stageId);
    if (!allowed.includes(logicalTool)) {
      this.d.trace.emit(runId, 'mcp_denied', stageId, { tool: logicalTool });
      throw new ToolDeniedError(`Stage "${stageId}" may not call "${logicalTool}"`);
    }
    const entry = this.d.tools[logicalTool];
    if (!entry) throw new McpNotConfiguredError(`No MCP tool is mapped for "${logicalTool}". Add it under mcp.tools in the config.`);
    const caller = this.d.callers[entry.server];
    if (!caller) throw new McpNotConfiguredError(`MCP server "${entry.server}" is not configured`);
    const mapped = renameKeys(args, entry.args);

    const started = Date.now();
    const base = {
      tool: logicalTool,
      server: entry.server,
      mcpTool: entry.tool,
      argsHash: createHash('sha256').update(JSON.stringify(mapped)).digest('hex').slice(0, 16),
      args: mapped,
    };
    try {
      const result = await exec(caller, entry.tool, mapped);
      this.d.trace.emit(runId, 'mcp_call', stageId, { ...base, ok: true, durationMs: Date.now() - started });
      return result;
    } catch (e) {
      this.d.trace.emit(runId, 'mcp_call', stageId, {
        ...base, ok: false, durationMs: Date.now() - started, error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }
}

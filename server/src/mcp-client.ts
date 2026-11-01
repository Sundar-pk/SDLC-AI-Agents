import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export interface ToolResult {
  content?: { type: string; text?: string; data?: string; mimeType?: string; resource?: { blob?: string; text?: string; mimeType?: string; uri?: string } }[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  /** Names of the input arguments. */
  params: string[];
}

export interface McpCaller {
  /** Result as a plain value: structured content, parsed JSON text, or text. */
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** The untouched MCP result, for binary content such as images. */
  callRaw(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  listTools(): Promise<McpToolInfo[]>;
  close(): Promise<void>;
}

export function resultText(res: ToolResult): string {
  return (res.content ?? [])
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n');
}

/** Turns an MCP tool result into a plain value: structured content, parsed JSON text, or text. */
export function unwrapToolResult(res: ToolResult): unknown {
  const text = resultText(res);
  if (res.isError) throw new Error(text || 'MCP tool returned an error');
  if (res.structuredContent !== undefined) return res.structuredContent;
  try { return JSON.parse(text); } catch { return text; }
}

export interface HttpMcpOptions {
  url: string;
  token?: string;
  headers?: Record<string, string>;
}

/**
 * MCP client over streamable HTTP. The Jira, Confluence and Bitbucket API tokens live in the MCP
 * server. The optional bearer or headers only authenticate this service to the MCP server.
 */
export function createHttpMcpCaller(opts: HttpMcpOptions): McpCaller {
  let client: Client | null = null;
  let connecting: Promise<Client> | null = null;

  const connect = async (): Promise<Client> => {
    const c = new Client({ name: 'sdlc-agents', version: '0.2.0' });
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.token && !Object.keys(headers).some((h) => h.toLowerCase() === 'authorization')) headers.Authorization = `Bearer ${opts.token}`;
    const transport = new StreamableHTTPClientTransport(new URL(opts.url), { requestInit: { headers } });
    await c.connect(transport);
    return c;
  };
  const get = async (): Promise<Client> => {
    if (!client) {
      connecting ??= connect().catch((e) => { connecting = null; throw e; });
      client = await connecting;
    }
    return client;
  };

  return {
    async callTool(name, args) {
      const res = (await (await get()).callTool({ name, arguments: args })) as ToolResult;
      return unwrapToolResult(res);
    },
    async callRaw(name, args) {
      const res = (await (await get()).callTool({ name, arguments: args })) as ToolResult;
      if (res.isError) throw new Error(resultText(res) || 'MCP tool returned an error');
      return res;
    },
    async listTools() {
      const c = await get();
      const out: McpToolInfo[] = [];
      let cursor: string | undefined;
      do {
        const page = await c.listTools(cursor ? { cursor } : undefined);
        for (const t of page.tools) {
          const props = (t.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
          out.push({ name: t.name, description: t.description, params: Object.keys(props) });
        }
        cursor = page.nextCursor;
      } while (cursor);
      return out;
    },
    async close() {
      await client?.close();
      client = null;
      connecting = null;
    },
  };
}

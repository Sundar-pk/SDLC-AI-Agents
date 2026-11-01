import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createHttpMcpCaller } from '../src/mcp-client.js';

let http: Server;
let url = '';
let sawAuth = '';

beforeAll(async () => {
  http = createServer(async (req, res) => {
    sawAuth = String(req.headers.authorization ?? '');
    const server = new McpServer({ name: 'fake-jira', version: '1' });
    server.tool('getIssue', { key: z.string() }, async ({ key }) => ({
      content: [{ type: 'text', text: JSON.stringify({ key, summary: 'Round trip' }) }],
    }));
    server.tool('boom', {}, async () => ({ isError: true, content: [{ type: 'text', text: 'Jira is down' }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    let body = '';
    for await (const c of req) body += c;
    await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
});
afterAll(() => { http.close(); });

describe('MCP over streamable HTTP', () => {
  it('calls a tool, parses the JSON result and sends the bearer', async () => {
    const c = createHttpMcpCaller({ url, token: 'svc-token' });
    expect(await c.callTool('getIssue', { key: 'ABC-1' })).toEqual({ key: 'ABC-1', summary: 'Round trip' });
    expect(sawAuth).toBe('Bearer svc-token');
    await c.close();
  });
  it('turns a tool error into a thrown error', async () => {
    const c = createHttpMcpCaller({ url });
    await expect(c.callTool('boom', {})).rejects.toThrow('Jira is down');
    await c.close();
  });
});

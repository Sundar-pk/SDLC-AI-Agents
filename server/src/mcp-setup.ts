import { LOGICAL_TOOLS, matchParam, scoreTool } from './mcp-tools.js';
import type { McpToolInfo } from './mcp-client.js';

export interface Proposal {
  tools: Record<string, { server: string; tool: string; args?: Record<string, string> }>;
  report: { logical: string; required: boolean; picked?: string; score?: number; alternatives: string[]; unmatchedArgs: string[] }[];
}

/**
 * Looks at the tools your MCP servers expose and proposes the logical-to-real mapping, including
 * argument renames. A person reviews it; "doctor" then verifies it against the live servers.
 */
export function proposeToolMap(listed: Record<string, McpToolInfo[]>): Proposal {
  const tools: Proposal['tools'] = {};
  const report: Proposal['report'] = [];
  for (const lt of LOGICAL_TOOLS) {
    const scored = Object.entries(listed)
      .flatMap(([server, ts]) => ts.map((t) => ({ server, ...t, score: scoreTool(lt.name, { server, tool: t.name, params: t.params, description: t.description }) })))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (!best || best.score < 2.5) {
      report.push({ logical: lt.name, required: lt.required, alternatives: scored.slice(0, 3).map((s) => `${s.server}:${s.name}`), unmatchedArgs: [] });
      continue;
    }
    const args: Record<string, string> = {};
    const unmatched: string[] = [];
    for (const a of lt.args) {
      const real = matchParam(a, best.params);
      if (!real) { if (lt.mustHave.includes(a)) unmatched.push(a); continue; }
      if (real !== a) args[a] = real;
    }
    tools[lt.name] = { server: best.server, tool: best.name, ...(Object.keys(args).length ? { args } : {}) };
    report.push({
      logical: lt.name, required: lt.required, picked: `${best.server}:${best.name}`, score: Math.round(best.score * 10) / 10,
      alternatives: scored.slice(1, 3).map((s) => `${s.server}:${s.name}`), unmatchedArgs: unmatched,
    });
  }
  return { tools, report };
}

export interface ImportedServers {
  servers: Record<string, { url: string; headers?: Record<string, string>; token?: string }>;
  /** Secret values moved out of the JSON, to be written to .env. */
  env: Record<string, string>;
  skipped: string[];
}

const SECRET_HEADER = /authorization|token|key|secret|cookie/i;

/** Converts a Claude-style .mcp.json ({ mcpServers: { name: { url, headers } } }) and moves secrets to env references. */
export function importMcpJson(json: unknown): ImportedServers {
  const root = (json && typeof json === 'object' ? json : {}) as Record<string, any>;
  const src = (root.mcpServers ?? root.servers ?? root) as Record<string, any>;
  const out: ImportedServers = { servers: {}, env: {}, skipped: [] };
  for (const [name, def] of Object.entries(src)) {
    if (!def || typeof def !== 'object') continue;
    if (typeof def.url !== 'string') { out.skipped.push(`${name} (${def.command ? 'stdio server: the service needs an HTTP url' : 'no url'})`); continue; }
    const prefix = `MCP_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
    const headers: Record<string, string> = {};
    let token: string | undefined;
    for (const [h, v] of Object.entries((def.headers ?? {}) as Record<string, unknown>)) {
      if (typeof v !== 'string') continue;
      if (SECRET_HEADER.test(h)) {
        const bearer = /^bearer\s+(.+)$/i.exec(v);
        if (h.toLowerCase() === 'authorization' && bearer) {
          const key = `${prefix}_TOKEN`;
          out.env[key] = bearer[1]!;
          token = `\${env:${key}}`;
        } else {
          const key = `${prefix}_${h.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
          out.env[key] = v;
          headers[h] = `\${env:${key}}`;
        }
      } else headers[h] = v;
    }
    out.servers[name] = { url: def.url, ...(token ? { token } : {}), ...(Object.keys(headers).length ? { headers } : {}) };
  }
  return out;
}

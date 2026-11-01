import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, interpolate, loadConfig, parseDotenv } from '../src/config.js';

const dir = () => { const d = mkdtempSync(join(tmpdir(), 'cfg-')); mkdirSync(join(d, 'config')); return d; };
const write = (d: string, cfg: unknown, env?: string) => {
  writeFileSync(join(d, 'config', 'agents.config.json'), JSON.stringify(cfg));
  if (env !== undefined) writeFileSync(join(d, 'config', '.env'), env);
  return join(d, 'config', 'agents.config.json');
};

describe('config', () => {
  it('has working defaults with no file', () => {
    const c = loadConfig({}, { rootDir: dir() });
    expect(c.configFile).toBeNull();
    expect(c.runner.kind).toBe('claude');
    expect(c.mutation.threshold).toBe(70);
  });
  it('reads .env secrets, interpolates them, and lets real env win', () => {
    const d = dir();
    const file = write(d, { mcp: { servers: { a: { url: 'https://a.example/mcp', token: '${env:A_TOKEN}' } } }, git: { auth: { token: '${env:GIT_TOKEN}' } } }, 'A_TOKEN=from-file\nGIT_TOKEN="quoted"\n');
    const c = loadConfig({ GIT_TOKEN: 'from-env' }, { file, rootDir: d });
    expect(c.mcp.servers.a!.token).toBe('from-file');
    expect(c.git.auth?.token).toBe('from-env');
  });
  it('lists every missing variable at once and treats ${env:X?} as optional', () => {
    const d = dir();
    const file = write(d, { llm: { env: { A: '${env:ONE}', B: '${env:TWO}', C: '${env:THREE?}' } } });
    expect(() => loadConfig({}, { file, rootDir: d })).toThrow(/ONE, TWO/);
    const m = new Set<string>();
    expect(interpolate('${env:THREE?}', {}, m)).toBe('');
    expect(m.size).toBe(0);
  });
  it('resolves tools to servers, with shorthand and a single-server default', () => {
    const d = dir();
    const file = write(d, {
      mcp: { servers: { jira: { url: 'https://j/mcp' }, scm: { url: 'https://s/mcp' } },
        tools: { 'jira.get_issue': 'jira:get_issue', 'bitbucket.get_diff': { server: 'scm', tool: 'diff' } } },
    });
    const c = loadConfig({}, { file, rootDir: d });
    expect(c.mcp.tools['jira.get_issue']).toMatchObject({ server: 'jira', tool: 'get_issue' });
    expect(c.mcp.tools['bitbucket.get_diff']!.server).toBe('scm');
    const one = write(dir(), { mcp: { servers: { x: { url: 'https://x/mcp' } }, tools: { 'jira.get_issue': 'get_issue' } } });
    expect(loadConfig({}, { file: one }).mcp.tools['jira.get_issue']!.server).toBe('x');
  });
  it('rejects ambiguous tools, unknown servers and invalid values with readable messages', () => {
    const d = dir();
    const two = { servers: { a: { url: 'https://a/mcp' }, b: { url: 'https://b/mcp' } } };
    expect(() => loadConfig({}, { file: write(d, { mcp: { ...two, tools: { 'jira.get_issue': 'get' } } }) })).toThrow(/needs a server/);
    expect(() => loadConfig({}, { file: write(d, { mcp: { ...two, tools: { 'jira.get_issue': { server: 'zzz', tool: 'x' } } } }) })).toThrow(/unknown server "zzz"/);
    expect(() => loadConfig({}, { file: write(d, { llm: { runner: 'nope' } }) })).toThrow(/Invalid config: llm.runner/);
    expect(() => loadConfig({}, { file: '/nonexistent.json' })).toThrow(ConfigError);
  });
  it('resolves repos relative to the config and derives workspaces', () => {
    const d = dir();
    const c = loadConfig({}, { file: write(d, { git: { workspacesDir: '../ws' }, repos: [{ name: 'orders', project: 'SHOP', url: 'https://bb/x.git' }] }) });
    expect(c.repos[0]).toMatchObject({ name: 'orders', slug: 'orders', baseBranch: 'main', workspace: join(d, 'ws', 'orders') });
  });
  it('parses dotenv', () => {
    expect(parseDotenv("# c\nA=1\nexport B='two words'\n\nC = \"3\"")).toEqual({ A: '1', B: 'two words', C: '3' });
  });
  it('ships an example config that loads once its variables are set', () => {
    const env = Object.fromEntries(['LLM_BASE_URL','LLM_API_KEY','MCP_ATLASSIAN_URL','MCP_SCM_URL','GIT_TOKEN'].map((k) => [k, k === 'MCP_ATLASSIAN_URL' || k === 'MCP_SCM_URL' || k === 'LLM_BASE_URL' ? 'https://x.example/mcp' : 'tok']));
    const c = loadConfig(env, { file: join(__dirname, '../../config/agents.config.example.json') });
    expect(Object.keys(c.mcp.servers)).toEqual(['atlassian', 'scm']);
    expect(c.mcp.tools['bitbucket.create_pull_request']!.server).toBe('scm');
    expect(c.repos.length).toBe(2);
  });
});

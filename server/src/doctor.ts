import { accessSync, constants, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from './config.js';
import type { ShellGit } from './git.js';
import { createHttpMcpCaller, type McpCaller, type McpToolInfo } from './mcp-client.js';
import { LOGICAL_TOOLS, matchParam } from './mcp-tools.js';
import { STAGES } from './pipeline.js';
import { spawnCapture, type Exec } from './proc.js';

export interface Check {
  group: string;
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  fix?: string;
}

export interface DoctorDeps {
  exec?: Exec;
  git?: Pick<ShellGit, 'lsRemote'>;
  /** Override MCP callers (tests). */
  callers?: Record<string, McpCaller>;
}

const ok = (group: string, name: string, detail: string): Check => ({ group, name, status: 'ok', detail });
const warn = (group: string, name: string, detail: string, fix?: string): Check => ({ group, name, status: 'warn', detail, fix });
const fail = (group: string, name: string, detail: string, fix?: string): Check => ({ group, name, status: 'fail', detail, fix });

/** Everything a new environment needs, checked in one pass. Safe to run any time. */
export async function runDoctor(config: AppConfig, deps: DoctorDeps = {}): Promise<Check[]> {
  const exec = deps.exec ?? spawnCapture;
  const out: Check[] = [];

  // --- config and files
  out.push(config.configFile
    ? ok('Config', 'Config file', config.configFile)
    : warn('Config', 'Config file', 'No agents.config.json found. Running on defaults.', 'Copy config/agents.config.example.json to config/agents.config.json'));
  const missingRoles = [...new Set(STAGES.filter((s) => s.role).map((s) => s.role!))].filter((r) => !existsSync(join(config.rolesDir, `${r}.md`)));
  out.push(missingRoles.length ? fail('Config', 'Role files', `Missing: ${missingRoles.join(', ')}`, `Add them under ${config.rolesDir}`) : ok('Config', 'Role files', `All agent roles found in ${config.rolesDir}`));
  const missingWt = ['feature', 'bug', 'change'].filter((w) => !existsSync(join(config.worktypesDir, `${w}.md`)));
  out.push(missingWt.length ? warn('Config', 'Work type guides', `Missing: ${missingWt.join(', ')}`) : ok('Config', 'Work type guides', 'feature, bug, change'));
  try {
    mkdirSync(config.dataDir, { recursive: true });
    accessSync(config.dataDir, constants.W_OK);
    out.push(ok('Config', 'Data folder', config.dataDir));
  } catch {
    out.push(fail('Config', 'Data folder', `${config.dataDir} is not writable`, 'Set server.dataDir to a writable folder'));
  }
  out.push(existsSync(join(config.uiDir, 'index.html')) ? ok('Config', 'Web UI', 'Built') : warn('Config', 'Web UI', 'UI is not built; the API still works', 'cd ui && npm install && npm run build'));

  // --- agent runner
  const cmd = config.runner.kind === 'custom' ? config.runner.command : config.runner.kind;
  if (!cmd) out.push(fail('Agent tool', 'Runner', 'llm.runner is custom but llm.custom.command is missing'));
  else {
    const v = await exec(cmd, ['--version'], { cwd: process.cwd(), timeoutMs: 15_000 });
    out.push(v.exitCode === 0
      ? ok('Agent tool', `${cmd} CLI`, (v.stdout || v.stderr).trim().split('\n')[0]!.slice(0, 80))
      : fail('Agent tool', `${cmd} CLI`, `"${cmd} --version" failed (exit ${v.exitCode})`, `Install ${cmd} on this machine and make sure it is on PATH`));
  }
  const modelNote = config.runner.model ?? (config.runner.opencode?.models[0] ?? 'CLI default');
  out.push(ok('Agent tool', 'Model', `${modelNote}${Object.keys(config.runner.stageModels).length ? ` (+${Object.keys(config.runner.stageModels).length} stage overrides)` : ''}`));
  if (config.runner.kind === 'claude') {
    const e = { ...process.env, ...config.runner.env };
    const hasEndpoint = Boolean(e.ANTHROPIC_BASE_URL || e.ANTHROPIC_API_KEY || e.ANTHROPIC_AUTH_TOKEN || e.CLAUDE_CODE_USE_BEDROCK || e.CLAUDE_CODE_USE_VERTEX);
    out.push(hasEndpoint ? ok('Agent tool', 'LLM endpoint', e.ANTHROPIC_BASE_URL ?? 'direct') : warn('Agent tool', 'LLM endpoint', 'No ANTHROPIC_BASE_URL or credentials in llm.env. The CLI must already be logged in.', 'Set llm.env.ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN for your internal gateway'));
  }
  if (config.runner.kind === 'opencode') {
    out.push(config.runner.opencode ? ok('Agent tool', 'LLM endpoint', config.runner.opencode.baseURL) : warn('Agent tool', 'LLM endpoint', 'llm.opencode is not set, so opencode uses its own configuration', 'Add llm.opencode.baseURL and models'));
  }
  out.push(config.runner.vision ? ok('Agent tool', 'Vision', 'Images from Jira are given to the agents') : warn('Agent tool', 'Vision', 'llm.vision is false: UI mock-ups are saved but agents will not read them', 'Use a vision-capable model and set llm.vision to true'));

  // --- git
  const g = await exec('git', ['--version'], { cwd: process.cwd(), timeoutMs: 10_000 });
  out.push(g.exitCode === 0 ? ok('Git', 'git', g.stdout.trim()) : fail('Git', 'git', 'git is not installed', 'Install git'));
  out.push(config.git.auth ? ok('Git', 'Credentials', `${config.git.auth.type} token configured`) : warn('Git', 'Credentials', 'git.auth is not set. Push will use whatever git credentials the machine already has.', 'Add git.auth.token (an HTTP access token)'));
  if (!config.repos.length) out.push(warn('Git', 'Repos', 'No repos in the config; runs must pass a workspace explicitly', 'Add entries under "repos"'));
  for (const r of config.repos) {
    const present = existsSync(join(r.workspace, '.git'));
    if (r.url && deps.git) {
      const reach = await deps.git.lsRemote(r.url);
      out.push(reach.ok ? ok('Git', `Repo ${r.name}`, `${present ? 'checked out' : 'will be cloned'}, remote reachable`) : fail('Git', `Repo ${r.name}`, `Cannot read ${r.url}: ${reach.detail}`, 'Check git.auth and the clone url'));
    } else if (present) out.push(ok('Git', `Repo ${r.name}`, `checkout at ${r.workspace}`));
    else out.push(fail('Git', `Repo ${r.name}`, `No checkout at ${r.workspace} and no url to clone`, 'Set repos[].url or repos[].workspace'));
  }

  // --- MCP
  const names = Object.keys(config.mcp.servers);
  if (!names.length) out.push(fail('MCP', 'Servers', 'No MCP servers configured', 'Run: npm run cli -- import-mcp <your mcp json>'));
  const listed: Record<string, McpToolInfo[]> = {};
  for (const n of names) {
    const s = config.mcp.servers[n]!;
    const caller = deps.callers?.[n] ?? createHttpMcpCaller({ url: s.url, token: s.token, headers: s.headers });
    try {
      listed[n] = await caller.listTools();
      out.push(ok('MCP', `Server ${n}`, `${listed[n]!.length} tools at ${s.url}`));
    } catch (e) {
      out.push(fail('MCP', `Server ${n}`, `Cannot connect to ${s.url}: ${e instanceof Error ? e.message : String(e)}`, 'Check the url, the token and that the server speaks streamable HTTP'));
    } finally {
      if (!deps.callers) await caller.close().catch(() => {});
    }
  }
  for (const lt of LOGICAL_TOOLS) {
    const m = config.mcp.tools[lt.name];
    const label = `${lt.name}`;
    if (!m) {
      out.push(lt.required ? fail('MCP tools', label, `Not mapped (${lt.purpose})`, 'Run: npm run cli -- discover-mcp') : warn('MCP tools', label, `Not mapped: ${lt.purpose} will be skipped`));
      continue;
    }
    const tools = listed[m.server];
    if (!tools) { out.push(warn('MCP tools', label, `→ ${m.server}:${m.tool} (server not reachable, not verified)`)); continue; }
    const real = tools.find((t) => t.name === m.tool);
    if (!real) { out.push(fail('MCP tools', label, `${m.server} has no tool named "${m.tool}"`, 'Run: npm run cli -- discover-mcp')); continue; }
    const rename = m.args ?? {};
    const bad = lt.mustHave.filter((a) => !real.params.includes(rename[a] ?? a));
    if (bad.length) {
      const hints = bad.map((a) => `${a} → ${matchParam(a, real.params) ?? '?'}`).join(', ');
      out.push(fail('MCP tools', label, `${m.tool} lacks parameter(s) ${bad.join(', ')}. Its parameters: ${real.params.join(', ') || 'none'}`, `Add args mapping, for example: ${hints}`));
    } else out.push(ok('MCP tools', label, `→ ${m.server}:${m.tool}`));
  }
  return out;
}

export function summarize(checks: Check[]): { ok: number; warn: number; fail: number } {
  return { ok: checks.filter((c) => c.status === 'ok').length, warn: checks.filter((c) => c.status === 'warn').length, fail: checks.filter((c) => c.status === 'fail').length };
}

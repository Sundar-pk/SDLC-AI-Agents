import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** Package root: the folder holding server/, ui/, .agents/ and config/. Works from src/ and dist/. */
export const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export class ConfigError extends Error {}

// ---------- schema (this is what the one config file looks like) ----------

const McpServerSchema = z.object({
  url: z.string().url(),
  /** Sent as "Authorization: Bearer <token>". */
  token: z.string().optional(),
  /** Any extra headers (the same shape as a Claude/Cursor .mcp.json "headers" block). */
  headers: z.record(z.string(), z.string()).default({}),
});

const ToolEntrySchema = z.union([
  z.string(),
  z.object({
    server: z.string().optional(),
    tool: z.string(),
    /** Logical argument name -> the name this MCP server expects. */
    args: z.record(z.string(), z.string()).optional(),
  }),
]);

const RepoSchema = z.object({
  name: z.string().min(1),
  /** Bitbucket project key (or workspace). */
  project: z.string().min(1),
  /** Bitbucket repo slug. Defaults to name. */
  slug: z.string().optional(),
  /** Clone URL. Needed when the service should clone the repo itself. */
  url: z.string().optional(),
  baseBranch: z.string().default('main'),
  /** Existing checkout. Defaults to <workspacesDir>/<name>. */
  workspace: z.string().optional(),
});

const Schema = z.object({
  server: z
    .object({
      host: z.string().default('127.0.0.1'),
      port: z.number().int().default(8080),
      dataDir: z.string().default('./data'),
      requireUser: z.boolean().default(false),
    })
    .default({ host: '127.0.0.1', port: 8080, dataDir: './data', requireUser: false }),
  llm: z
    .object({
      runner: z.enum(['claude', 'opencode', 'custom']).default('claude'),
      model: z.string().optional(),
      /** Stage id -> model. Use a cheaper model for review stages, a stronger one for coding. */
      stageModels: z.record(z.string(), z.string()).default({}),
      timeoutMinutes: z.number().positive().default(20),
      /** Can the configured model look at images? Controls how UI mockups are handled. */
      vision: z.boolean().default(true),
      allowedTools: z.string().default('Read,Edit,Write,Glob,Grep,Bash'),
      /** Extra environment for the agent CLI, for example ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN. */
      env: z.record(z.string(), z.string()).default({}),
      /** For runner=opencode: an OpenAI-compatible endpoint. A config file is generated from this. */
      opencode: z
        .object({
          providerId: z.string().default('internal'),
          baseURL: z.string().url(),
          apiKey: z.string().optional(),
          models: z.array(z.string()).min(1),
        })
        .optional(),
      custom: z
        .object({ command: z.string(), args: z.array(z.string()), parser: z.enum(['claude-json', 'text']).default('text') })
        .optional(),
      budgets: z
        .object({ perStageTokens: z.number().default(150_000), perRunTokens: z.number().default(1_500_000) })
        .default({ perStageTokens: 150_000, perRunTokens: 1_500_000 }),
    })
    .default({
      runner: 'claude', stageModels: {}, timeoutMinutes: 20, vision: true,
      allowedTools: 'Read,Edit,Write,Glob,Grep,Bash', env: {},
      budgets: { perStageTokens: 150_000, perRunTokens: 1_500_000 },
    }),
  mcp: z
    .object({
      servers: z.record(z.string(), McpServerSchema).default({}),
      tools: z.record(z.string(), ToolEntrySchema).default({}),
    })
    .default({ servers: {}, tools: {} }),
  git: z
    .object({
      authorName: z.string().default('SDLC Agents'),
      authorEmail: z.string().default('sdlc-agents@localhost'),
      workspacesDir: z.string().default('./workspaces'),
      /** Credentials for clone, fetch and push. Never written to the remote URL or to logs. */
      auth: z
        .object({ type: z.enum(['bearer', 'basic']).default('bearer'), username: z.string().optional(), token: z.string() })
        .optional(),
    })
    .default({ authorName: 'SDLC Agents', authorEmail: 'sdlc-agents@localhost', workspacesDir: './workspaces' }),
  repos: z.array(RepoSchema).default([]),
  jira: z
    .object({
      /** Jira issue type names that map to each work type. Anything else is a feature. */
      workTypes: z
        .object({
          bug: z.array(z.string()).default(['Bug', 'Defect', 'Incident']),
          change: z.array(z.string()).default(['Change Request', 'Change', 'Improvement', 'Enhancement']),
        })
        .default({ bug: ['Bug', 'Defect', 'Incident'], change: ['Change Request', 'Change', 'Improvement', 'Enhancement'] }),
    })
    .default({ workTypes: { bug: ['Bug', 'Defect', 'Incident'], change: ['Change Request', 'Change', 'Improvement', 'Enhancement'] } }),
  quality: z
    .object({
      mutationThreshold: z.number().min(0).max(100).default(70),
      commands: z.array(z.object({ name: z.string(), command: z.string(), args: z.array(z.string()).default([]) })).default([]),
    })
    .default({ mutationThreshold: 70, commands: [] }),
  attachments: z
    .object({ maxCount: z.number().int().default(10), maxBytes: z.number().int().default(5 * 1024 * 1024) })
    .default({ maxCount: 10, maxBytes: 5 * 1024 * 1024 }),
  index: z
    .object({ mapTokens: z.number().int().default(6000), contextFiles: z.number().int().default(15) })
    .default({ mapTokens: 6000, contextFiles: 15 }),
});

export type RawConfig = z.input<typeof Schema>;

// ---------- resolved config used by the service ----------

export interface ResolvedTool {
  server: string;
  tool: string;
  args?: Record<string, string>;
}

export interface RepoConfig {
  name: string;
  project: string;
  slug: string;
  url?: string;
  baseBranch: string;
  workspace: string;
}

export interface QualityCommand {
  name: string;
  command: string;
  args: string[];
}

export interface AppConfig {
  rootDir: string;
  configFile: string | null;
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  rolesDir: string;
  worktypesDir: string;
  uiDir: string;
  requireUser: boolean;
  runner: {
    kind: 'claude' | 'opencode' | 'custom';
    model?: string;
    stageModels: Record<string, string>;
    timeoutMs: number;
    allowedTools: string;
    vision: boolean;
    env: Record<string, string>;
    opencode?: { providerId: string; baseURL: string; apiKey?: string; models: string[] };
    command?: string;
    args?: string[];
    parser?: 'claude-json' | 'text';
  };
  budgets: { perStageTokens: number; perRunTokens: number };
  mcp: { servers: Record<string, { url: string; token?: string; headers: Record<string, string> }>; tools: Record<string, ResolvedTool> };
  mutation: { threshold: number };
  qualityCommands: QualityCommand[];
  git: { authorName: string; authorEmail: string; workspacesDir: string; auth?: { type: 'bearer' | 'basic'; username?: string; token: string } };
  repos: RepoConfig[];
  jira: { workTypes: { bug: string[]; change: string[] } };
  attachments: { maxCount: number; maxBytes: number };
  index: { mapTokens: number; contextFiles: number };
}

// ---------- loading ----------

/** Minimal .env parser: KEY=VALUE lines, optional quotes, # comments. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2]!;
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]!] = v;
  }
  return out;
}

/** Replaces ${env:NAME} (required) and ${env:NAME?} (optional, empty when unset). Collects missing names. */
export function interpolate(value: unknown, env: Record<string, string | undefined>, missing: Set<string>): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)(\?)?\}/g, (_m, name: string, optional?: string) => {
      const v = env[name];
      if (v === undefined || v === '') {
        if (!optional) missing.add(name);
        return '';
      }
      return v;
    });
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, env, missing));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, env, missing)]));
  }
  return value;
}

function abs(base: string, p: string): string {
  return isAbsolute(p) ? p : resolve(base, p);
}

function resolveTools(raw: Record<string, z.infer<typeof ToolEntrySchema>>, servers: string[]): Record<string, ResolvedTool> {
  const out: Record<string, ResolvedTool> = {};
  for (const [logical, entry] of Object.entries(raw)) {
    let server: string | undefined;
    let tool: string;
    let args: Record<string, string> | undefined;
    if (typeof entry === 'string') {
      const i = entry.indexOf(':');
      if (i > 0 && servers.includes(entry.slice(0, i))) { server = entry.slice(0, i); tool = entry.slice(i + 1); } else tool = entry;
    } else {
      server = entry.server; tool = entry.tool; args = entry.args;
    }
    if (!server) {
      if (servers.length === 1) server = servers[0];
      else throw new ConfigError(`mcp.tools["${logical}"] needs a server (one of: ${servers.join(', ') || 'none configured'})`);
    }
    if (!servers.includes(server!)) throw new ConfigError(`mcp.tools["${logical}"] names unknown server "${server}"`);
    out[logical] = { server: server!, tool, args };
  }
  return out;
}

export interface LoadOptions {
  /** Config file path. Defaults to $AGENTS_CONFIG or <root>/config/agents.config.json when it exists. */
  file?: string;
  rootDir?: string;
}

/**
 * Loads the one config file plus .env secrets. Real environment variables win over .env.
 * PORT, HOST and DATA_DIR in the environment override the file (handy in containers).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, opts: LoadOptions = {}): AppConfig {
  const rootDir = opts.rootDir ?? ROOT_DIR;
  const candidate = opts.file ?? env.AGENTS_CONFIG ?? resolve(rootDir, 'config', 'agents.config.json');
  const configFile = existsSync(candidate) ? resolve(candidate) : null;
  if ((opts.file ?? env.AGENTS_CONFIG) && !configFile) throw new ConfigError(`Config file not found: ${candidate}`);
  const base = configFile ? dirname(configFile) : rootDir;

  const envFile = env.AGENTS_ENV_FILE ?? resolve(base, '.env');
  const merged: Record<string, string | undefined> = { ...(existsSync(envFile) ? parseDotenv(readFileSync(envFile, 'utf8')) : {}), ...env };

  let raw: unknown = {};
  if (configFile) {
    try { raw = JSON.parse(readFileSync(configFile, 'utf8')); }
    catch (e) { throw new ConfigError(`${configFile} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`); }
  }
  const missing = new Set<string>();
  const filled = interpolate(raw, merged, missing);
  if (missing.size) {
    throw new ConfigError(`These environment variables are referenced in the config but not set: ${[...missing].join(', ')}. Put them in ${envFile} or the environment.`);
  }
  const parsed = Schema.safeParse(filled);
  if (!parsed.success) {
    throw new ConfigError(`Invalid config: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
  }
  const c = parsed.data;

  const dataDir = abs(base, merged.DATA_DIR ?? c.server.dataDir);
  const workspacesDir = abs(base, c.git.workspacesDir);
  const serverNames = Object.keys(c.mcp.servers);
  const servers = Object.fromEntries(
    serverNames.map((n) => {
      const s = c.mcp.servers[n]!;
      return [n, { url: s.url, token: s.token || undefined, headers: s.headers }];
    }),
  );

  return {
    rootDir,
    configFile,
    host: merged.HOST ?? c.server.host,
    port: merged.PORT ? Number(merged.PORT) : c.server.port,
    dataDir,
    dbPath: resolve(dataDir, 'agents.sqlite'),
    rolesDir: resolve(rootDir, '.agents', 'roles'),
    worktypesDir: resolve(rootDir, '.agents', 'worktypes'),
    uiDir: resolve(rootDir, 'ui', 'dist', 'ui', 'browser'),
    requireUser: c.server.requireUser,
    runner: {
      kind: c.llm.runner,
      model: c.llm.model || undefined,
      stageModels: c.llm.stageModels,
      timeoutMs: Math.round(c.llm.timeoutMinutes * 60_000),
      allowedTools: c.llm.allowedTools,
      vision: c.llm.vision,
      env: c.llm.env,
      opencode: c.llm.opencode,
      command: c.llm.custom?.command,
      args: c.llm.custom?.args,
      parser: c.llm.custom?.parser,
    },
    budgets: c.llm.budgets,
    mcp: { servers, tools: resolveTools(c.mcp.tools, serverNames) },
    mutation: { threshold: c.quality.mutationThreshold },
    qualityCommands: c.quality.commands,
    git: {
      authorName: c.git.authorName,
      authorEmail: c.git.authorEmail,
      workspacesDir,
      auth: c.git.auth && c.git.auth.token ? c.git.auth : undefined,
    },
    repos: c.repos.map((r) => ({
      name: r.name,
      project: r.project,
      slug: r.slug ?? r.name,
      url: r.url,
      baseBranch: r.baseBranch,
      workspace: r.workspace ? abs(base, r.workspace) : resolve(workspacesDir, r.name),
    })),
    jira: c.jira,
    attachments: c.attachments,
    index: c.index,
  };
}

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { runDoctor, summarize } from '../src/doctor.js';
import { importMcpJson, proposeToolMap } from '../src/mcp-setup.js';
import { worktypeSection, buildPromptFile } from '../src/runners/prompt.js';
import { getStage } from '../src/pipeline.js';

const T = (name: string, params: string[], description = '') => ({ name, params, description });
const atlassian = [
  T('jira_get_issue', ['issue_key', 'fields'], 'Get a Jira issue'),
  T('jira_search', ['jql'], 'Search Jira issues'),
  T('jira_add_comment', ['issue_key', 'comment'], 'Add a comment to a Jira issue'),
  T('jira_get_issue_comments', ['issue_key'], 'Get Jira comments'),
  T('jira_list_attachments', ['issue_key'], 'List Jira attachments'),
  T('jira_download_attachment', ['attachment_id'], 'Download a Jira attachment'),
  T('jira_get_issue_links', ['issue_key'], 'Linked Jira issues'),
  T('confluence_get_page', ['page_id'], 'Get a Confluence page'),
  T('confluence_search', ['query'], 'Search Confluence'),
];
const scm = [
  T('bitbucket_create_pull_request', ['project_key', 'repo_slug', 'title', 'description', 'source_branch', 'destination_branch', 'is_draft'], 'Create a Bitbucket pull request'),
  T('bitbucket_get_pull_request_diff', ['project_key', 'repo_slug', 'pr_id'], 'Bitbucket diff'),
  T('bitbucket_list_repos', ['project_key'], 'List repos'),
];

describe('MCP discovery', () => {
  it('proposes server, tool and argument names for each logical tool', () => {
    const p = proposeToolMap({ atlassian, scm });
    expect(p.tools['jira.get_issue']).toMatchObject({ server: 'atlassian', tool: 'jira_get_issue', args: { issueKey: 'issue_key' } });
    expect(p.tools['jira.add_comment']).toMatchObject({ tool: 'jira_add_comment', args: { issueKey: 'issue_key', body: 'comment' } });
    expect(p.tools['jira.get_comments']!.tool).toBe('jira_get_issue_comments');
    expect(p.tools['jira.get_attachments']!.tool).toBe('jira_list_attachments');
    expect(p.tools['jira.download_attachment']).toMatchObject({ tool: 'jira_download_attachment', args: { attachmentId: 'attachment_id' } });
    expect(p.tools['jira.get_linked_issues']!.tool).toBe('jira_get_issue_links');
    expect(p.tools['confluence.get_page']).toMatchObject({ tool: 'confluence_get_page', args: { pageId: 'page_id' } });
    expect(p.tools['bitbucket.create_pull_request']).toMatchObject({
      server: 'scm', tool: 'bitbucket_create_pull_request',
      args: { project: 'project_key', repo: 'repo_slug', fromBranch: 'source_branch', toBranch: 'destination_branch', draft: 'is_draft' },
    });
    expect(p.tools['bitbucket.get_diff']!.tool).toBe('bitbucket_get_pull_request_diff');
  });
  it('reports what it could not match instead of guessing', () => {
    const p = proposeToolMap({ x: [T('ping', [])] });
    expect(Object.keys(p.tools)).toEqual([]);
    expect(p.report.find((r) => r.logical === 'jira.get_issue')!.picked).toBeUndefined();
  });
});

describe('import-mcp', () => {
  it('converts a .mcp.json, moves secrets out and skips stdio servers', () => {
    const r = importMcpJson({ mcpServers: {
      'atlassian-mcp': { type: 'http', url: 'https://a/mcp', headers: { Authorization: 'Bearer sekret-123', 'X-Team': 'shop' } },
      scm: { url: 'https://s/mcp', headers: { 'X-Api-Key': 'k-999' } },
      local: { command: 'npx', args: ['x'] },
    } });
    expect(r.servers['atlassian-mcp']).toEqual({ url: 'https://a/mcp', token: '${env:MCP_ATLASSIAN_MCP_TOKEN}', headers: { 'X-Team': 'shop' } });
    expect(r.servers.scm!.headers).toEqual({ 'X-Api-Key': '${env:MCP_SCM_X_API_KEY}' });
    expect(r.env).toEqual({ MCP_ATLASSIAN_MCP_TOKEN: 'sekret-123', MCP_SCM_X_API_KEY: 'k-999' });
    expect(JSON.stringify(r.servers)).not.toContain('sekret');
    expect(r.skipped[0]).toContain('local');
  });
});

describe('doctor', () => {
  const caller = (tools: any[], fail = false) => ({
    callTool: async () => ({}), callRaw: async () => ({ content: [] }), close: async () => {},
    listTools: async () => { if (fail) throw new Error('ECONNREFUSED'); return tools; },
  });
  const exec = async (cmd: string) => ({ exitCode: cmd === 'missing-cli' ? 127 : 0, stdout: `${cmd} 1.0`, stderr: '', durationMs: 1, timedOut: false, aborted: false });
  const mk = (tools: Record<string, any>, extra: any = {}) => {
    const d = mkdtempSync(join(tmpdir(), 'doc-'));
    mkdirSync(join(d, 'config'));
    const file = join(d, 'config', 'agents.config.json');
    writeFileSync(file, JSON.stringify({ server: { dataDir: '../data' }, mcp: { servers: { atlassian: { url: 'https://a/mcp' }, scm: { url: 'https://s/mcp' } }, tools }, ...extra }));
    return loadConfig({}, { file });
  };
  const proposal = proposeToolMap({ atlassian, scm }).tools;

  it('passes a correct setup and verifies tool and parameter names against the live servers', async () => {
    const checks = await runDoctor(mk(proposal), { exec: exec as any, callers: { atlassian: caller(atlassian) as any, scm: caller(scm) as any } });
    expect(checks.filter((c) => c.status === 'fail')).toEqual([]);
    expect(checks.find((c) => c.name === 'jira.get_issue')!.detail).toContain('atlassian:jira_get_issue');
  });
  it('fails with a specific fix when a parameter name is wrong or a tool is missing', async () => {
    const bad = { ...proposal, 'jira.get_issue': { server: 'atlassian', tool: 'jira_get_issue' }, 'jira.add_comment': { server: 'atlassian', tool: 'jira_nope' } };
    const checks = await runDoctor(mk(bad), { exec: exec as any, callers: { atlassian: caller(atlassian) as any, scm: caller(scm) as any } });
    const gi = checks.find((c) => c.name === 'jira.get_issue')!;
    expect(gi.status).toBe('fail');
    expect(gi.fix).toContain('issueKey → issue_key');
    expect(checks.find((c) => c.name === 'jira.add_comment')!.detail).toContain('no tool named "jira_nope"');
    expect(summarize(checks).fail).toBe(2);
  });
  it('reports an unreachable server, a missing CLI and unmapped required tools', async () => {
    const checks = await runDoctor(mk({}, { llm: { runner: 'custom', custom: { command: 'missing-cli', args: [] } } }), {
      exec: exec as any, callers: { atlassian: caller([], true) as any, scm: caller(scm) as any },
    });
    expect(checks.find((c) => c.name === 'Server atlassian')!.status).toBe('fail');
    expect(checks.find((c) => c.name === 'missing-cli CLI')!.status).toBe('fail');
    expect(checks.find((c) => c.name === 'jira.get_issue')!.status).toBe('fail');
    expect(checks.find((c) => c.name === 'confluence.get_page')!.status).toBe('warn');
  });
});

describe('prompt', () => {
  const wtDir = join(__dirname, '../../.agents/worktypes');
  it('adds only the section for the stage role', () => {
    const bug = worktypeSection(wtDir, 'bug', 'test_author')!;
    expect(bug).toContain('This is a defect');
    expect(bug).toContain('reproduces the bug');
    expect(bug).not.toContain('Root cause hypothesis');
    expect(worktypeSection(wtDir, 'change', 'spec_agent')).toContain('**Unchanged**');
    expect(worktypeSection(wtDir, 'auto', 'spec_agent')).toBeNull();
  });
  it('puts work type, navigation and image rules into the prompt file', () => {
    const d = mkdtempSync(join(tmpdir(), 'pr-'));
    writeFileSync(join(d, 'attachments.json'), JSON.stringify([{ kind: 'image', filename: 'a.png' }]));
    const run: any = { ticket: 'A-1', work_type: 'bug', title: 'Crash on save', workspace: '/ws', branch: 'agents/a-1', base_branch: 'main' };
    const base = { stage: getStage('spec'), run, rolesDir: join(__dirname, '../../.agents/roles'), runDir: d, attempt: 1, worktypesDir: wtDir, navigation: { repoMap: '/ws/.agents/index/repo-map.md', findCommand: 'node cli.js find' } };
    const withVision = readFileSync(buildPromptFile({ ...base, vision: true }), 'utf8');
    expect(withVision).toContain('## Work type: Bug fix');
    expect(withVision).toContain('Title: Crash on save');
    expect(withVision).toContain('node cli.js find <term>');
    expect(withVision).toContain('Open the image files');
    expect(readFileSync(buildPromptFile({ ...base, vision: false }), 'utf8')).toContain('cannot view images');
  });
});

describe('git credentials', () => {
  it('never leaks the token in an error message', async () => {
    const { ShellGit } = await import('../src/git.js');
    const exec: any = async (_c: string, args: string[]) => ({ exitCode: 128, stdout: '', stderr: `fatal: bad credentials ${args.join(' ').includes('Bearer') ? 'Bearer tok-SECRET-123' : ''} tok-SECRET-123`, durationMs: 1, timedOut: false, aborted: false });
    const git = new ShellGit({ name: 'b', email: 'b@x' }, exec, { type: 'bearer', token: 'tok-SECRET-123' });
    const err = await git.push('/tmp', 'agents/x').catch((e) => e as Error);
    expect(String(err.message)).toContain('failed (128)');
    expect(String(err.message)).not.toContain('SECRET');
    const seen: string[][] = [];
    const spy: any = async (_c: string, args: string[]) => { seen.push(args); return { exitCode: 0, stdout: '', stderr: '', durationMs: 1, timedOut: false, aborted: false }; };
    const g2 = new ShellGit({ name: 'b', email: 'b@x' }, spy, { type: 'basic', username: 'svc', token: 'tok-SECRET-123' });
    await g2.push('/tmp', 'b');
    await g2.commitAll('/tmp', 'm');
    expect(seen[0]!.join(' ')).toContain('http.extraHeader=Authorization: Basic ');
    expect(seen.slice(1).flat().join(' ')).not.toContain('extraHeader');
  });
});

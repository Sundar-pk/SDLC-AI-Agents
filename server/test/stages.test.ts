import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolBroker } from '../src/broker.js';
import { loadConfig } from '../src/config.js';
import { agentHandler, draftMrHandler, intakeHandler } from '../src/stages.js';
import { getStage } from '../src/pipeline.js';
import { resultPath } from '../src/runners/prompt.js';
import { runDirFor } from '../src/types.js';
import type { AgentResult, AgentRunner } from '../src/runners/types.js';
import { setup, start } from './helpers.js';

const ok: AgentResult = { exitCode: 0, output: 'done', tokensIn: 10, tokensOut: 5, cacheReadTokens: 0, costUsd: null, turns: 1, durationMs: 1, estimated: true, timedOut: false, aborted: false };

function env(onRun: (req: any) => void | Promise<void>, mcp: Record<string, any> = {}) {
  const t = setup();
  const rolesDir = join(t.dir, 'roles');
  mkdirSync(rolesDir, { recursive: true });
  for (const r of ['jira_reader', 'coder', 'mr_agent']) writeFileSync(join(rolesDir, `${r}.md`), `# ${r}\n`);
  const config = { ...loadConfig({}), rolesDir };
  const runner: AgentRunner = { name: 'fake', run: async (req) => { await onRun(req); return ok; } };
  const calls: any[] = [];
  const caller = { callTool: async (n: string, a: any) => { calls.push([n, a]); return mcp[n] ?? {}; }, callRaw: async () => ({ content: [] }), listTools: async () => [], close: async () => {} };
  const tools = Object.fromEntries(['jira.get_issue','jira.get_comments','jira.get_attachments','jira.get_linked_issues','jira.add_comment','bitbucket.create_pull_request','bitbucket.get_diff'].map((k) => [k, { server: 's', tool: k.replace('.', '_') }]));
  const broker = new ToolBroker({ callers: { s: caller }, tools, trace: t.trace });
  const deps = { runner, broker, git: t.git, exec: async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 0, timedOut: false }) as any, config, store: t.store };
  const ctxFor = async (stageId: string) => {
    const run = await start(t.orchestrator, t.workspace);
    t.orchestrator.cancel(run.id, 't');
    const r = t.store.getRun(run.id)!;
    mkdirSync(runDirFor(r), { recursive: true });
    return { run: r, stage: getStage(stageId), runDir: runDirFor(r), attempt: 1, signal: new AbortController().signal, trace: t.trace, store: t.store };
  };
  return { t, deps, ctxFor, calls };
}

describe('stage handlers', () => {
  it('reads the result file the agent wrote and records an llm_call', async () => {
    let dir = '';
    const e = env(() => { writeFileSync(resultPath(dir, 'green'), JSON.stringify({ status: 'pass', summary: 'implemented' })); });
    const ctx = await e.ctxFor('green');
    dir = ctx.runDir;
    const res = await agentHandler(e.deps)(ctx);
    expect(res).toMatchObject({ outcome: 'pass', summary: 'implemented' });
    expect(e.t.store.countEvents(ctx.run.id, 'llm_call', 'green')).toBe(1);
  });

  it('reverts test-file edits during green and fails the stage', async () => {
    const e = env(() => {});
    e.deps.git.dirtyFiles = async () => [{ path: 'src/test/java/FooTest.java', untracked: false }, { path: 'src/main/java/Foo.java', untracked: false }];
    let reverted: string[] = [];
    e.deps.git.revertFiles = async (_c, f) => { reverted = f.map((x) => x.path); };
    const res = await agentHandler(e.deps)(await e.ctxFor('green'));
    expect(res.outcome).toBe('fail');
    expect(reverted).toEqual(['src/test/java/FooTest.java']);
  });

  it('intake: stores ticket.json and, when ambiguous, comments on Jira and blocks', async () => {
    const e = env(() => {}, { jira_get_issue: { key: 'ABC-1', summary: 's' } });
    const ctx = await e.ctxFor('intake');
    mkdirSync(join(ctx.runDir, 'results'), { recursive: true });
    writeFileSync(join(ctx.runDir, 'results', 'intake.result.json'), JSON.stringify({ status: 'pass', summary: 'x', ambiguous: true, questions: ['Which currency?'] }));
    const deps = { ...e.deps, runner: { name: 'fake', run: async () => ok } };
    // result file is cleared before the run, so have the fake runner write it
    deps.runner.run = async () => { writeFileSync(join(ctx.runDir, 'results', 'intake.result.json'), JSON.stringify({ status: 'pass', summary: 'x', ambiguous: true, questions: ['Which currency?'] })); return ok; };
    const res = await intakeHandler(deps)(ctx);
    expect(res.outcome).toBe('blocked');
    expect(JSON.parse(readFileSync(join(ctx.runDir, 'ticket.json'), 'utf8')).issue.key).toBe('ABC-1');
    const comment = e.calls.find((c) => c[0] === 'jira_add_comment');
    expect(comment[1].body).toContain('Which currency?');
  });

  it('draft MR: pushes, opens a draft PR through MCP and stores the URL', async () => {
    const e = env(() => {}, { bitbucket_create_pull_request: { links: { html: { href: 'https://bb/pr/1' } } } });
    const ctx = await e.ctxFor('draft_mr');
    writeFileSync(join(ctx.runDir, 'mr-description.md'), '# Add rounding\n\nbody');
    let pushed = '';
    e.deps.git.push = async (_c, b) => { pushed = b; };
    const res = await draftMrHandler(e.deps)(ctx);
    expect(res.outcome).toBe('pass');
    expect(pushed).toBe(ctx.run.branch);
    const pr = e.calls.find((c) => c[0] === 'bitbucket_create_pull_request')[1];
    expect(pr).toMatchObject({ draft: true, title: '[ABC-1] Add rounding' });
    expect(e.t.store.getRun(ctx.run.id)?.mr_url).toBe('https://bb/pr/1');
  });
});

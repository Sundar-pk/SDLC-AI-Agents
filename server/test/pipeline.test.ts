import { describe, expect, it } from 'vitest';
import { redact } from '../src/events.js';
import { resolveNext, STAGES, TRANSITIONS } from '../src/pipeline.js';
import { ToolBroker, ToolDeniedError } from '../src/broker.js';
import { Trace } from '../src/events.js';
import { Store } from '../src/db.js';

describe('pipeline', () => {
  it('has a transition for every non-end stage and only known targets', () => {
    const ids = new Set(STAGES.map((s) => s.id));
    for (const s of STAGES.filter((x) => x.kind !== 'end')) {
      const t = TRANSITIONS[s.id];
      expect(t, s.id).toBeDefined();
      expect(ids.has(t!.pass)).toBe(true);
      if (t!.fail) expect(ids.has(t!.fail)).toBe(true);
    }
  });
  it('bounds fail edges and routes exhausted mutation loop to code review', () => {
    expect(resolveNext('red_check', 'fail', 0)).toMatchObject({ kind: 'goto', stage: 'red' });
    expect(resolveNext('red_check', 'fail', 2)).toMatchObject({ kind: 'blocked' });
    expect(resolveNext('mutation_run', 'fail', 2)).toMatchObject({ kind: 'goto', stage: 'code_review', exhausted: true });
    expect(resolveNext('g1', 'fail', 2)).toMatchObject({ kind: 'goto', stage: 'plan' });
    expect(resolveNext('g1', 'fail', 3)).toMatchObject({ kind: 'blocked' });
  });
  it('only intake and draft_mr may use MCP', () => {
    expect(STAGES.filter((s) => s.mcpTools.length).map((s) => s.id)).toEqual(['intake', 'draft_mr']);
  });
});

describe('redact', () => {
  it('masks secret keys, bearer tokens and key=value', () => {
    const out = redact({ token: 'abc', note: 'Authorization: Bearer abcdefghijkl1234', cmd: 'run password=hunter2' }) as any;
    expect(out.token).toBe('***');
    expect(out.note).not.toContain('abcdefghijkl1234');
    expect(out.cmd).not.toContain('hunter2');
  });
});

describe('broker', () => {
  const fake = (log: any[], reply: any = {}) => ({
    callTool: async (n: string, a: any) => { log.push([n, a]); return reply; },
    callRaw: async () => ({ content: [] }), listTools: async () => [], close: async () => {},
  });
  const mk = (callers: any, tools: any) => {
    const store = new Store(':memory:');
    const run = store.createRun({ ticket: 'A-1', workType: 'auto', baseBranch: 'main', project: 'p', repo: 'r', workspace: '/x', branch: 'b', createdBy: 'u', firstStage: 'intake' });
    const trace = new Trace(store);
    return { run, store, broker: new ToolBroker({ callers, trace, tools }) };
  };
  it('denies tools outside the stage allowlist and traces it', async () => {
    const { run, store, broker } = mk({ a: fake([]) }, { 'jira.get_issue': { server: 'a', tool: 'getIssue' } });
    await expect(broker.call(run.id, 'spec', 'jira.get_issue')).rejects.toBeInstanceOf(ToolDeniedError);
    expect(store.countEvents(run.id, 'mcp_denied')).toBe(1);
  });
  it('routes each tool to its own server, renames tool and arguments, and traces the call', async () => {
    const jira: any[] = []; const scm: any[] = [];
    const { run, store, broker } = mk(
      { atlassian: fake(jira, { ok: 1 }), scm: fake(scm, { pr: 2 }) },
      {
        'jira.get_issue': { server: 'atlassian', tool: 'getIssue', args: { issueKey: 'key' } },
        'bitbucket.create_pull_request': { server: 'scm', tool: 'createPr' },
      },
    );
    expect(await broker.call(run.id, 'intake', 'jira.get_issue', { issueKey: 'A-1' })).toEqual({ ok: 1 });
    expect(await broker.call(run.id, 'draft_mr', 'bitbucket.create_pull_request', { title: 't' })).toEqual({ pr: 2 });
    expect(jira).toEqual([['getIssue', { key: 'A-1' }]]);
    expect(scm).toEqual([['createPr', { title: 't' }]]);
    expect(store.countEvents(run.id, 'mcp_call')).toBe(2);
    expect(broker.has('jira.get_issue')).toBe(true);
    expect(broker.has('confluence.get_page')).toBe(false);
  });
  it('explains an unmapped tool', async () => {
    const { run, broker } = mk({}, {});
    await expect(broker.call(run.id, 'intake', 'jira.get_issue')).rejects.toThrow(/mcp.tools/);
  });
});

describe('redact keeps metrics', () => {
  it('does not mask token counts, only secret text', () => {
    const out = redact({ tokensIn: 120, tokensOut: 30, cacheReadTokens: 5, token: 'abc', apiKey: 'k', ok: true }) as any;
    expect(out).toMatchObject({ tokensIn: 120, tokensOut: 30, cacheReadTokens: 5, token: '***', apiKey: '***', ok: true });
  });
  it('token counts reach the store and the budget math', () => {
    const store = new Store(':memory:');
    const run = store.createRun({ ticket: 'A-1', workType: 'auto', baseBranch: 'main', project: 'p', repo: 'r', workspace: '/x', branch: 'b', createdBy: 'u', firstStage: 'intake' });
    new Trace(store).emit(run.id, 'llm_call', 'spec', { tokensIn: 1000, tokensOut: 200, costUsd: 0.5 });
    expect(store.tokensFor(run.id, 'spec')).toBe(1200);
    expect(store.metrics(run.id)).toMatchObject({ tokensIn: 1000, tokensOut: 200, costUsd: 0.5 });
  });
});

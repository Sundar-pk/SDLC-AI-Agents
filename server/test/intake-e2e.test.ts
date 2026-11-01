import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolBroker } from '../src/broker.js';
import { loadConfig } from '../src/config.js';
import { buildHandlers } from '../src/stages.js';
import { getStage } from '../src/pipeline.js';
import { runDirFor } from '../src/types.js';
import { setup } from './helpers.js';

const PNG = Buffer.from('89504e470d0a1a0a' + '00'.repeat(200), 'hex');
const ok = { exitCode: 0, output: 'done', tokensIn: 1, tokensOut: 1, cacheReadTokens: 0, costUsd: null, turns: 1, durationMs: 1, estimated: true, timedOut: false, aborted: false };

describe('intake end to end', () => {
  it('detects a bug, saves the mock-up, reads Confluence, and the agent prompt carries it all', async () => {
    const t = setup();
    const rolesDir = join(__dirname, '../../.agents/roles');
    const config = { ...loadConfig({}), rolesDir, worktypesDir: join(__dirname, '../../.agents/worktypes') };
    const calls: string[] = [];
    const data: Record<string, any> = {
      jira_get_issue: { key: 'ABC-1', fields: { summary: 'Total wrong in cart', issuetype: { name: 'Bug' }, description: 'See https://wiki.x/spaces/S/pages/55555/Pricing for rules' } },
      jira_get_comments: [], jira_get_links: [],
      jira_list_attachments: [{ id: 10, filename: 'cart.png', mimeType: 'image/png', size: 208 }, { id: 11, filename: 'huge.png', mimeType: 'image/png', size: 99999999 }, { id: 12, filename: 'a.zip', mimeType: 'application/zip' }],
      confluence_get_page: { title: 'Pricing', body: { storage: { value: '<p>Discount applies before tax</p>' } } },
    };
    const caller: any = {
      callTool: async (n: string) => { calls.push(n); return data[n]; },
      callRaw: async (n: string, a: any) => { calls.push(`${n}:${a.attachment_id}`); return { content: [{ type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' }] }; },
      listTools: async () => [], close: async () => {},
    };
    const tools = {
      'jira.get_issue': { server: 's', tool: 'jira_get_issue' }, 'jira.get_comments': { server: 's', tool: 'jira_get_comments' },
      'jira.get_linked_issues': { server: 's', tool: 'jira_get_links' }, 'jira.get_attachments': { server: 's', tool: 'jira_list_attachments' },
      'jira.download_attachment': { server: 's', tool: 'jira_download_attachment', args: { attachmentId: 'attachment_id' } },
      'confluence.get_page': { server: 's', tool: 'confluence_get_page' },
    };
    const broker = new ToolBroker({ callers: { s: caller }, tools, trace: t.trace });
    let prompt = '';
    const runner = { name: 'fake', run: async (req: any) => { prompt = readFileSync(req.promptFile, 'utf8'); return ok; } };
    const deps = { runner, broker, git: t.git, exec: (async () => ok) as any, config, store: t.store };
    const handlers = buildHandlers(deps as any);

    const run = await t.orchestrator.startRun({ ticket: 'ABC-1', workspace: t.workspace, project: 'P', repo: 'r', createdBy: 'u' });
    t.orchestrator.cancel(run.id, 'u');
    const fresh = t.store.getRun(run.id)!;
    expect(fresh.work_type).toBe('auto');
    const ctx = { run: fresh, stage: getStage('intake'), runDir: runDirFor(fresh), attempt: 1, signal: new AbortController().signal, trace: t.trace, store: t.store };
    mkdirSync(ctx.runDir, { recursive: true });
    const res = await handlers.intake!(ctx);

    expect(res.outcome).toBe('pass');
    const after = t.store.getRun(run.id)!;
    expect(after).toMatchObject({ work_type: 'bug', title: 'Total wrong in cart' });
    expect(t.store.countEvents(run.id, 'worktype_set')).toBe(1);
    const files = JSON.parse(readFileSync(join(ctx.runDir, 'attachments.json'), 'utf8'));
    expect(files.map((f: any) => [f.filename, Boolean(f.file), f.skipped ?? null])).toEqual([
      ['cart.png', true, null], ['huge.png', false, expect.stringContaining('larger')], ['a.zip', false, expect.stringContaining('not useful')],
    ]);
    expect(existsSync(join(ctx.runDir, 'attachments', '10-cart.png'))).toBe(true);
    expect(readFileSync(join(ctx.runDir, 'attachments', '10-cart.png')).equals(PNG)).toBe(true);
    expect(calls).toContain('jira_download_attachment:10');
    expect(calls).not.toContain('jira_download_attachment:11');
    expect(readFileSync(join(ctx.runDir, 'confluence.md'), 'utf8')).toContain('Discount applies before tax');
    expect(prompt).toContain('## Work type: Bug fix');
    expect(prompt).toContain('Steps to reproduce'.toLowerCase().slice(0, 5));
    expect(prompt).toContain('Open the image files');
  });
});

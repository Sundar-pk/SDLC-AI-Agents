import { describe, expect, it } from 'vitest';
import { setup, start } from './helpers.js';

describe('orchestrator', () => {
  it('runs to G1, pauses, then to G2, pauses, then completes at the draft MR', async () => {
    const t = setup();
    const run = await start(t.orchestrator, t.workspace);
    await t.orchestrator.settle(run.id);
    expect(t.store.getRun(run.id)).toMatchObject({ status: 'awaiting_gate', current_stage: 'g1' });
    expect(t.calls).toEqual(['intake', 'spec', 'plan']);

    await t.orchestrator.decideGate(run.id, 'G1', 'approved', 'alice');
    await t.orchestrator.settle(run.id);
    expect(t.store.getRun(run.id)).toMatchObject({ status: 'awaiting_gate', current_stage: 'g2' });

    await t.orchestrator.decideGate(run.id, 'G2', 'approved', 'bob');
    await t.orchestrator.settle(run.id);
    expect(t.store.getRun(run.id)?.status).toBe('completed');
    expect(t.calls.at(-1)).toBe('draft_mr');
    expect(t.git.commits.length).toBeGreaterThan(0);
  });

  it('rejection at G1 needs a comment and loops back to plan', async () => {
    const t = setup();
    const run = await start(t.orchestrator, t.workspace);
    await t.orchestrator.settle(run.id);
    await expect(t.orchestrator.decideGate(run.id, 'G1', 'rejected', 'alice')).rejects.toThrow(/comment/);
    await t.orchestrator.decideGate(run.id, 'G1', 'rejected', 'alice', 'cover the null case');
    await t.orchestrator.settle(run.id);
    expect(t.calls.filter((c) => c === 'plan')).toHaveLength(2);
    expect(t.store.getRun(run.id)?.current_stage).toBe('g1');
  });

  it('blocks when a fail edge is exhausted, and retry continues', async () => {
    const f = { outcome: 'fail', summary: 'nope' } as const;
    const t = setup({ red_check: [f, f, f] });
    const run = await start(t.orchestrator, t.workspace);
    await t.orchestrator.settle(run.id);
    await t.orchestrator.decideGate(run.id, 'G1', 'approved', 'a');
    await t.orchestrator.settle(run.id);
    const r = t.store.getRun(run.id)!;
    expect(r.status).toBe('blocked');
    expect(r.blocked_reason).toMatch(/Loop limit/);
    expect(t.calls.filter((c) => c === 'red')).toHaveLength(3);
    t.orchestrator.retry(run.id, 'a');
    await t.orchestrator.settle(run.id);
    expect(t.store.getRun(run.id)?.current_stage).toBe('g2');
  });

  it('survivors left after the mutation loop budget go on to code review', async () => {
    const f = { outcome: 'fail', summary: 'survivors' } as const;
    const t = setup({ mutation_run: [f, f, f] });
    const run = await start(t.orchestrator, t.workspace);
    await t.orchestrator.settle(run.id);
    await t.orchestrator.decideGate(run.id, 'G1', 'approved', 'a');
    await t.orchestrator.settle(run.id);
    expect(t.calls.filter((c) => c === 'kill_survivors')).toHaveLength(2);
    expect(t.store.getRun(run.id)?.current_stage).toBe('g2');
    expect(t.store.countEvents(run.id, 'limit_breach')).toBe(1);
  });

  it('a handler that throws blocks the run instead of crashing', async () => {
    const t = setup();
    t.orchestrator['d'].handlers.spec = async () => { throw new Error('boom'); };
    const run = await start(t.orchestrator, t.workspace);
    await t.orchestrator.settle(run.id);
    expect(t.store.getRun(run.id)).toMatchObject({ status: 'blocked', blocked_reason: 'boom' });
  });

  it('cancel stops the run and aborts the stage', async () => {
    const t = setup();
    t.orchestrator['d'].handlers.spec = (ctx) => new Promise((res) => ctx.signal.addEventListener('abort', () => res({ outcome: 'blocked', reason: 'cancelled' })));
    const run = await start(t.orchestrator, t.workspace);
    await new Promise((r) => setTimeout(r, 50));
    t.orchestrator.cancel(run.id, 'a');
    await t.orchestrator.settle(run.id);
    expect(t.store.getRun(run.id)?.status).toBe('cancelled');
  });

  it('rejects bad ticket keys and a busy workspace', async () => {
    const t = setup();
    await expect(t.orchestrator.startRun({ ticket: 'nope', workspace: t.workspace, project: 'p', repo: 'r', createdBy: 'a' })).rejects.toThrow(/Jira issue key/);
    await start(t.orchestrator, t.workspace);
    await expect(start(t.orchestrator, t.workspace)).rejects.toThrow(/already used/);
  });
});

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/api.js';
import { loadConfig } from '../src/config.js';
import { setup } from './helpers.js';

describe('api', () => {
  const mk = () => {
    const t = setup();
    const app = buildApp({ config: loadConfig({}), store: t.store, trace: t.trace, orchestrator: t.orchestrator });
    return { t, app };
  };
  it('serves the pipeline and health', async () => {
    const { app } = mk();
    expect((await app.inject('/api/health')).json().ok).toBe(true);
    expect((await app.inject('/api/pipeline')).json().stages).toHaveLength(17);
  });
  it('starts a run, shows the gate, approves it with x-user, rejects bad input', async () => {
    const { t, app } = mk();
    const bad = await app.inject({ method: 'POST', url: '/api/runs', payload: { ticket: 'x' } });
    expect(bad.statusCode).toBe(400);
    const res = await app.inject({ method: 'POST', url: '/api/runs', payload: { ticket: 'ABC-9', workspace: t.workspace, project: 'P', repo: 'r' }, headers: { 'x-user': 'alice' } });
    expect(res.statusCode).toBe(201);
    const id = res.json().run.id;
    await t.orchestrator.settle(id);
    const view = (await app.inject(`/api/runs/${id}`)).json();
    expect(view.pendingGate.gate).toBe('G1');
    expect(view.stages.find((s: any) => s.id === 'g1').status).toBe('waiting');
    const wrong = await app.inject({ method: 'POST', url: `/api/runs/${id}/gates/G2`, payload: { decision: 'approved' } });
    expect(wrong.statusCode).toBe(409);
    const ok = await app.inject({ method: 'POST', url: `/api/runs/${id}/gates/G1`, payload: { decision: 'approved' }, headers: { 'x-user': 'bob' } });
    expect(ok.statusCode).toBe(200);
    const ev = (await app.inject(`/api/runs/${id}/events`)).json().events;
    expect(ev.find((e: any) => e.type === 'gate_decided').data.by).toBe('bob');
    expect((await app.inject('/api/runs/nope')).statusCode).toBe(404);
  });
  it('blocks path traversal in artifacts', async () => {
    const { t, app } = mk();
    const id = (await app.inject({ method: 'POST', url: '/api/runs', payload: { ticket: 'ABC-9', workspace: t.workspace, project: 'P', repo: 'r' } })).json().run.id;
    await t.orchestrator.settle(id);
    const r = await app.inject(`/api/runs/${id}/artifacts/..%2F..%2Fsecret`);
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(r.statusCode).toBeLessThan(500);
  });
});

describe('api: repos, doctor, work type, repo registry', () => {
  it('lists repos, serves doctor, and starts a run from a configured repo name', async () => {
    const t = setup();
    const cfg = { ...loadConfig({}), repos: [{ name: 'orders', project: 'SHOP', slug: 'orders-svc', baseBranch: 'develop', workspace: t.workspace, url: undefined }] };
    t.orchestrator['d'].repos = cfg.repos;
    const app = buildApp({ config: cfg, store: t.store, trace: t.trace, orchestrator: t.orchestrator, doctor: async () => [{ group: 'g', name: 'n', status: 'ok', detail: 'd' }] });
    expect((await app.inject('/api/repos')).json().repos).toEqual([{ name: 'orders', project: 'SHOP', baseBranch: 'develop' }]);
    expect((await app.inject('/api/doctor')).json().checks).toHaveLength(1);
    const bad = await app.inject({ method: 'POST', url: '/api/runs', payload: { ticket: 'ABC-2', repo: 'nope' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toContain('Known repos: orders');
    const res = await app.inject({ method: 'POST', url: '/api/runs', payload: { ticket: 'ABC-2', repo: 'orders', workType: 'bug' } });
    expect(res.statusCode).toBe(201);
    expect(res.json().run).toMatchObject({ repo: 'orders-svc', project: 'SHOP', base_branch: 'develop', work_type: 'bug' });
  });
  it('serves a fallback page when the UI is not built', async () => {
    const t = setup();
    const app = buildApp({ config: { ...loadConfig({}), uiDir: join(t.dir, 'no-ui') }, store: t.store, trace: t.trace, orchestrator: t.orchestrator });
    const r = await app.inject('/');
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('API is running');
    expect((await app.inject('/api/nothing')).statusCode).toBe(404);
  });
});

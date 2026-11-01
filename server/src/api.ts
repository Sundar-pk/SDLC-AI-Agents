import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { AppConfig } from './config.js';
import type { Check } from './doctor.js';
import type { Store } from './db.js';
import type { Trace } from './events.js';
import type { Orchestrator } from './orchestrator.js';
import { STAGES, TRANSITIONS } from './pipeline.js';
import { buildRunView } from './runView.js';
import { runDirFor, UserError } from './types.js';

export interface ApiDeps {
  config: AppConfig;
  store: Store;
  trace: Trace;
  orchestrator: Orchestrator;
  doctor?: () => Promise<Check[]>;
}

const StartBody = z.object({
  ticket: z.string().min(3),
  /** Name of a repo from the config. */
  repo: z.string().min(1).optional(),
  workspace: z.string().min(1).optional(),
  project: z.string().min(1).optional(),
  slug: z.string().min(1).optional(),
  baseBranch: z.string().min(1).optional(),
  workType: z.enum(['auto', 'feature', 'bug', 'change']).optional(),
});
const GateBody = z.object({ decision: z.enum(['approved', 'rejected']), comment: z.string().max(5000).optional() });

const MAX_ARTIFACT_BYTES = 512 * 1024;

export function buildApp(d: ApiDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  const who = (headers: Record<string, unknown>): string => {
    const u = headers['x-user'];
    const name = typeof u === 'string' ? u.trim() : '';
    if (!name && d.config.requireUser) throw new UserError('Missing x-user header', 401);
    return name || 'anonymous';
  };

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof UserError) return reply.status(err.status).send({ error: err.message });
    if (err instanceof z.ZodError) {
      return reply.status(400).send({ error: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    }
    const status = (err as { statusCode?: number }).statusCode;
    return reply.status(status && status < 500 ? status : 500).send({ error: err instanceof Error ? err.message : 'Internal error' });
  });

  const getRun = (id: string) => {
    const run = d.store.getRun(id);
    if (!run) throw new UserError('Run not found', 404);
    return run;
  };

  app.get('/api/health', async () => ({
    ok: true,
    runner: d.config.runner.kind,
    mcpServers: Object.keys(d.config.mcp.servers),
    vision: d.config.runner.vision,
    mutationThreshold: d.config.mutation.threshold,
    budgets: d.config.budgets,
  }));

  app.get('/api/repos', async () => ({
    repos: d.config.repos.map((r) => ({ name: r.name, project: r.project, baseBranch: r.baseBranch })),
  }));

  let doctorCache: { at: number; checks: Check[] } | null = null;
  app.get<{ Querystring: { refresh?: string } }>('/api/doctor', async (req) => {
    if (!d.doctor) return { checks: [] };
    if (!doctorCache || Date.now() - doctorCache.at > 30_000 || req.query.refresh) doctorCache = { at: Date.now(), checks: await d.doctor() };
    return { checks: doctorCache.checks, at: new Date(doctorCache.at).toISOString() };
  });

  app.get('/api/pipeline', async () => ({
    stages: STAGES.map(({ id, n, label, kind, phase, role, gate, inputs, outputs, mcpTools }) => ({
      id, n, label, kind, phase, role, gate, inputs, outputs, mcpTools,
    })),
    transitions: TRANSITIONS,
  }));

  app.post('/api/runs', async (req, reply) => {
    const body = StartBody.parse(req.body);
    const run = await d.orchestrator.startRun({ ...body, createdBy: who(req.headers) });
    return reply.status(201).send(buildRunView(d.store, run));
  });

  app.get('/api/runs', async () => ({ runs: d.store.listRuns(100) }));

  app.get<{ Params: { id: string } }>('/api/runs/:id', async (req) => buildRunView(d.store, getRun(req.params.id)));

  app.get<{ Params: { id: string }; Querystring: { after?: string; limit?: string } }>('/api/runs/:id/events', async (req) => {
    const run = getRun(req.params.id);
    const after = Number(req.query.after ?? 0) || 0;
    const limit = Math.min(Number(req.query.limit ?? 500) || 500, 2000);
    return { events: d.store.listEvents(run.id, after, limit) };
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id/stream', async (req, reply) => {
    const run = getRun(req.params.id);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const send = (e: { id: number }) => res.write(`id: ${e.id}\nevent: trace\ndata: ${JSON.stringify(e)}\n\n`);
    // Subscribe first, then replay from Last-Event-ID, and drop duplicates by id.
    let last = Number(req.headers['last-event-id'] ?? 0) || 0;
    const queue: { id: number }[] = [];
    let replaying = true;
    const unsub = d.trace.subscribe(run.id, (e) => {
      if (replaying) queue.push(e);
      else if (e.id > last) { last = e.id; send(e); }
    });
    for (const e of d.store.listEvents(run.id, last, 5000)) { last = e.id; send(e); }
    for (const e of queue) if (e.id > last) { last = e.id; send(e); }
    replaying = false;
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.raw.on('close', () => { clearInterval(ping); unsub(); });
  });

  app.post<{ Params: { id: string; gate: string } }>('/api/runs/:id/gates/:gate', async (req) => {
    const body = GateBody.parse(req.body);
    const gate = req.params.gate.toUpperCase();
    if (gate !== 'G1' && gate !== 'G2') throw new UserError('Gate must be G1 or G2');
    getRun(req.params.id);
    const run = await d.orchestrator.decideGate(req.params.id, gate, body.decision, who(req.headers), body.comment);
    return buildRunView(d.store, run);
  });

  app.post<{ Params: { id: string } }>('/api/runs/:id/cancel', async (req) =>
    buildRunView(d.store, d.orchestrator.cancel(req.params.id, who(req.headers))));

  app.post<{ Params: { id: string } }>('/api/runs/:id/retry', async (req) =>
    buildRunView(d.store, d.orchestrator.retry(req.params.id, who(req.headers))));

  app.get<{ Params: { id: string } }>('/api/runs/:id/artifacts', async (req) => {
    const dir = runDirFor(getRun(req.params.id));
    if (!existsSync(dir)) return { artifacts: [] };
    const artifacts = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => ({ name: e.name, bytes: statSync(join(dir, e.name)).size }));
    return { artifacts };
  });

  app.get<{ Params: { id: string; name: string } }>('/api/runs/:id/artifacts/:name', async (req, reply) => {
    const dir = resolve(runDirFor(getRun(req.params.id)));
    const file = resolve(dir, req.params.name);
    if (relative(dir, file).startsWith('..') || !file.startsWith(dir + sep)) throw new UserError('Invalid artifact name');
    if (!existsSync(file) || !statSync(file).isFile()) throw new UserError('Artifact not found', 404);
    if (statSync(file).size > MAX_ARTIFACT_BYTES) throw new UserError('Artifact is too large to show', 413);
    return reply.type('text/plain; charset=utf-8').send(readFileSync(file, 'utf8'));
  });

  const IMG: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };
  app.get<{ Params: { id: string; name: string } }>('/api/runs/:id/attachments/:name', async (req, reply) => {
    const dir = resolve(runDirFor(getRun(req.params.id)), 'attachments');
    const file = resolve(dir, req.params.name);
    if (!file.startsWith(dir + sep)) throw new UserError('Invalid attachment name');
    if (!existsSync(file) || !statSync(file).isFile()) throw new UserError('Attachment not found', 404);
    const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
    // Only images are shown inline; anything else is sent as a download so it can never run in the page.
    return reply
      .type(IMG[ext] ?? 'application/octet-stream')
      .header('content-disposition', IMG[ext] ? 'inline' : 'attachment')
      .header('x-content-type-options', 'nosniff')
      .send(readFileSync(file));
  });

  // The built Angular UI, if present. Unknown paths fall back to index.html (client-side routing).
  const ui = resolve(d.config.uiDir);
  const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain',
  };
  app.get('/*', async (req, reply) => {
    if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'Not found' });
    if (!existsSync(join(ui, 'index.html'))) {
      return reply.status(200).type('text/plain').send('SDLC agents API is running. The web UI is not built yet (cd ui && npm install && npm run build).');
    }
    const path = decodeURIComponent(req.url.split('?')[0]!);
    let file = resolve(ui, `.${path}`);
    if (!file.startsWith(ui + sep) || !existsSync(file) || !statSync(file).isFile()) file = join(ui, 'index.html');
    const ext = file.slice(file.lastIndexOf('.'));
    return reply.type(MIME[ext] ?? 'application/octet-stream').header('cache-control', file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable').send(readFileSync(file));
  });

  return app;
}

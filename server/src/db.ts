import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { EventType, TraceEvent } from './events.js';

export type RunStatus = 'running' | 'awaiting_gate' | 'blocked' | 'completed' | 'failed' | 'cancelled';

export type WorkType = 'auto' | 'feature' | 'bug' | 'change';

export interface RunRow {
  id: string;
  ticket: string;
  work_type: WorkType;
  title: string | null;
  base_branch: string;
  project: string;
  repo: string;
  workspace: string;
  branch: string;
  status: RunStatus;
  current_stage: string;
  blocked_reason: string | null;
  mr_url: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface NewRun {
  ticket: string;
  workType: WorkType;
  baseBranch: string;
  project: string;
  repo: string;
  workspace: string;
  branch: string;
  createdBy: string;
  firstStage: string;
}

export interface GateRow {
  id: number;
  run_id: string;
  gate: string;
  status: 'pending' | 'approved' | 'rejected';
  decided_by: string | null;
  comment: string | null;
  created_at: string;
  decided_at: string | null;
}

export interface Metrics {
  llmCalls: number;
  toolCalls: number;
  mcpCalls: number;
  scriptRuns: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  loops: number;
  limitBreaches: number;
}

const now = () => new Date().toISOString();

export class Store {
  readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.createTables();
    const cols = (this.db.prepare('PRAGMA table_info(runs)').all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes('work_type')) this.db.exec(`ALTER TABLE runs ADD COLUMN work_type TEXT NOT NULL DEFAULT 'feature'`);
    if (!cols.includes('title')) this.db.exec('ALTER TABLE runs ADD COLUMN title TEXT');
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        ticket TEXT NOT NULL,
        work_type TEXT NOT NULL DEFAULT 'auto',
        title TEXT,
        base_branch TEXT NOT NULL,
        project TEXT NOT NULL,
        repo TEXT NOT NULL,
        workspace TEXT NOT NULL,
        branch TEXT NOT NULL,
        status TEXT NOT NULL,
        current_stage TEXT NOT NULL,
        blocked_reason TEXT,
        mr_url TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        ts TEXT NOT NULL,
        type TEXT NOT NULL,
        stage TEXT,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, id);
      CREATE TABLE IF NOT EXISTS gates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        gate TEXT NOT NULL,
        status TEXT NOT NULL,
        decided_by TEXT,
        comment TEXT,
        created_at TEXT NOT NULL,
        decided_at TEXT
      );
      CREATE TABLE IF NOT EXISTS run_loops (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        edge TEXT NOT NULL,
        count INTEGER NOT NULL,
        PRIMARY KEY (run_id, edge)
      );
    `);
  }

  // ---- runs ----

  createRun(input: NewRun): RunRow {
    const id = randomUUID();
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO runs (id, ticket, work_type, base_branch, project, repo, workspace, branch, status, current_stage, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
      )
      .run(id, input.ticket, input.workType, input.baseBranch, input.project, input.repo, input.workspace, input.branch, input.firstStage, input.createdBy, ts, ts);
    return this.getRun(id)!;
  }

  getRun(id: string): RunRow | undefined {
    return this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
  }

  listRuns(limit = 50): RunRow[] {
    return this.db.prepare('SELECT * FROM runs ORDER BY created_at DESC LIMIT ?').all(limit) as RunRow[];
  }

  runsByStatus(status: RunStatus): RunRow[] {
    return this.db.prepare('SELECT * FROM runs WHERE status = ?').all(status) as RunRow[];
  }

  updateRun(id: string, patch: Partial<Pick<RunRow, 'status' | 'current_stage' | 'blocked_reason' | 'mr_url' | 'work_type' | 'title'>>): void {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = @${k}`).join(', ');
    this.db.prepare(`UPDATE runs SET ${sets}, updated_at = @updated_at WHERE id = @id`).run({ ...patch, updated_at: now(), id });
  }

  // ---- events ----

  addEvent(runId: string, type: EventType, stage: string | null, data: Record<string, unknown>): TraceEvent {
    const ts = now();
    const info = this.db
      .prepare('INSERT INTO events (run_id, ts, type, stage, data) VALUES (?, ?, ?, ?, ?)')
      .run(runId, ts, type, stage, JSON.stringify(data));
    return { id: Number(info.lastInsertRowid), runId, ts, type, stage, data };
  }

  listEvents(runId: string, afterId = 0, limit = 2000): TraceEvent[] {
    const rows = this.db
      .prepare('SELECT id, run_id, ts, type, stage, data FROM events WHERE run_id = ? AND id > ? ORDER BY id LIMIT ?')
      .all(runId, afterId, limit) as { id: number; run_id: string; ts: string; type: EventType; stage: string | null; data: string }[];
    return rows.map((r) => ({ id: r.id, runId: r.run_id, ts: r.ts, type: r.type, stage: r.stage, data: JSON.parse(r.data) }));
  }

  countEvents(runId: string, type: EventType, stage?: string): number {
    const row = stage
      ? this.db.prepare('SELECT COUNT(*) AS n FROM events WHERE run_id = ? AND type = ? AND stage = ?').get(runId, type, stage)
      : this.db.prepare('SELECT COUNT(*) AS n FROM events WHERE run_id = ? AND type = ?').get(runId, type);
    return (row as { n: number }).n;
  }

  stageExits(runId: string): { stage: string; outcome: string; n: number }[] {
    return this.db
      .prepare(
        `SELECT stage, json_extract(data, '$.outcome') AS outcome, COUNT(*) AS n
         FROM events WHERE run_id = ? AND type = 'stage_exit' GROUP BY stage, outcome`,
      )
      .all(runId) as { stage: string; outcome: string; n: number }[];
  }

  metrics(runId: string): Metrics {
    const r = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(type = 'llm_call'), 0) AS llmCalls,
           COALESCE(SUM(type = 'tool_call'), 0) AS toolCalls,
           COALESCE(SUM(type = 'mcp_call'), 0) AS mcpCalls,
           COALESCE(SUM(type = 'script_run'), 0) AS scriptRuns,
           COALESCE(SUM(CASE WHEN type = 'llm_call' THEN json_extract(data, '$.tokensIn') END), 0) AS tokensIn,
           COALESCE(SUM(CASE WHEN type = 'llm_call' THEN json_extract(data, '$.tokensOut') END), 0) AS tokensOut,
           COALESCE(SUM(CASE WHEN type = 'llm_call' THEN json_extract(data, '$.costUsd') END), 0) AS costUsd,
           COALESCE(SUM(type = 'loop_used'), 0) AS loops,
           COALESCE(SUM(type = 'limit_breach'), 0) AS limitBreaches
         FROM events WHERE run_id = ?`,
      )
      .get(runId) as Metrics;
    return r;
  }

  tokensFor(runId: string, stage?: string): number {
    const sql = `SELECT COALESCE(SUM(COALESCE(json_extract(data, '$.tokensIn'), 0) + COALESCE(json_extract(data, '$.tokensOut'), 0)), 0) AS t
                 FROM events WHERE run_id = ? AND type = 'llm_call'${stage ? ' AND stage = ?' : ''}`;
    const row = (stage ? this.db.prepare(sql).get(runId, stage) : this.db.prepare(sql).get(runId)) as { t: number };
    return row.t;
  }

  // ---- gates ----

  createGate(runId: string, gate: string): GateRow {
    const info = this.db
      .prepare(`INSERT INTO gates (run_id, gate, status, created_at) VALUES (?, ?, 'pending', ?)`)
      .run(runId, gate, now());
    return this.db.prepare('SELECT * FROM gates WHERE id = ?').get(info.lastInsertRowid) as GateRow;
  }

  pendingGate(runId: string): GateRow | undefined {
    return this.db.prepare(`SELECT * FROM gates WHERE run_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1`).get(runId) as GateRow | undefined;
  }

  decideGate(id: number, decision: 'approved' | 'rejected', by: string, comment: string | null): void {
    this.db
      .prepare(`UPDATE gates SET status = ?, decided_by = ?, comment = ?, decided_at = ? WHERE id = ?`)
      .run(decision, by, comment, now(), id);
  }

  listGates(runId: string): GateRow[] {
    return this.db.prepare('SELECT * FROM gates WHERE run_id = ? ORDER BY id').all(runId) as GateRow[];
  }

  // ---- loop counters ----

  loopCount(runId: string, edge: string): number {
    const row = this.db.prepare('SELECT count FROM run_loops WHERE run_id = ? AND edge = ?').get(runId, edge) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  incLoop(runId: string, edge: string): number {
    this.db
      .prepare(`INSERT INTO run_loops (run_id, edge, count) VALUES (?, ?, 1)
                ON CONFLICT(run_id, edge) DO UPDATE SET count = count + 1`)
      .run(runId, edge);
    return this.loopCount(runId, edge);
  }

  resetLoops(runId: string, edgePrefix: string): void {
    this.db.prepare(`DELETE FROM run_loops WHERE run_id = ? AND edge LIKE ? ESCAPE '\\'`).run(runId, `${edgePrefix.replace(/[%_\\]/g, '\\$&')}%`);
  }
}

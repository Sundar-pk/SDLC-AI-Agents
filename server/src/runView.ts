import type { GateRow, Metrics, RunRow, Store } from './db.js';
import { STAGES, stageIndex } from './pipeline.js';

export type StageStatus = 'done' | 'current' | 'waiting' | 'blocked' | 'pending';

export interface StageView {
  id: string;
  n: string;
  label: string;
  kind: string;
  phase: string;
  status: StageStatus;
  /** Times this stage exited with each outcome. */
  passes: number;
  fails: number;
  tokens: number;
}

export interface RunView {
  run: RunRow;
  stages: StageView[];
  metrics: Metrics;
  gates: GateRow[];
  pendingGate: GateRow | null;
  loops: { edge: string; count: number }[];
}

export function buildRunView(store: Store, run: RunRow): RunView {
  const exits = store.stageExits(run.id);
  const cur = stageIndex(run.current_stage);
  const stages = STAGES.map((s, i): StageView => {
    const passes = exits.filter((e) => e.stage === s.id && e.outcome === 'pass').reduce((a, e) => a + e.n, 0);
    const fails = exits.filter((e) => e.stage === s.id && e.outcome === 'fail').reduce((a, e) => a + e.n, 0);
    let status: StageStatus;
    if (run.status === 'completed') status = 'done';
    else if (i < cur) status = passes > 0 || s.kind === 'gate' ? 'done' : 'pending';
    else if (i === cur) {
      status = run.status === 'awaiting_gate' ? 'waiting' : run.status === 'blocked' || run.status === 'failed' ? 'blocked' : 'current';
    } else status = 'pending';
    return { id: s.id, n: s.n, label: s.label, kind: s.kind, phase: s.phase, status, passes, fails, tokens: store.tokensFor(run.id, s.id) };
  });
  const loops = store.db
    .prepare('SELECT edge, count FROM run_loops WHERE run_id = ? ORDER BY edge')
    .all(run.id) as { edge: string; count: number }[];
  return {
    run,
    stages,
    metrics: store.metrics(run.id),
    gates: store.listGates(run.id),
    pendingGate: store.pendingGate(run.id) ?? null,
    loops,
  };
}

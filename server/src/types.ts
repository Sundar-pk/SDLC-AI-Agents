import { join } from 'node:path';
import type { RunRow, Store } from './db.js';
import type { Trace } from './events.js';
import type { StageDef } from './pipeline.js';

export interface StageContext {
  run: RunRow;
  stage: StageDef;
  runDir: string;
  /** 1 for the first time the stage runs, 2 after a loop back, and so on. */
  attempt: number;
  signal: AbortSignal;
  trace: Trace;
  store: Store;
}

export type StageResult =
  | { outcome: 'pass' | 'fail'; summary?: string; data?: Record<string, unknown> }
  | { outcome: 'blocked'; reason: string };

export type StageHandler = (ctx: StageContext) => Promise<StageResult>;

/** Artifacts live in the checkout under .agents/runs/<TICKET>/ (git-excluded, never committed). */
export function runDirFor(run: Pick<RunRow, 'workspace' | 'ticket'>): string {
  return join(run.workspace, '.agents', 'runs', run.ticket);
}

export class UserError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

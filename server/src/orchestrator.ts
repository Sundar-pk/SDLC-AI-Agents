import { appendFeedback } from './runners/prompt.js';
import type { Store, RunRow, WorkType } from './db.js';
import type { RepoConfig } from './config.js';
import type { Trace } from './events.js';
import type { GitOps } from './git.js';
import { failEdgeKey, FIRST_STAGE, getStage, resolveNext, type StageDef } from './pipeline.js';
import { runDirFor, UserError, type StageHandler, type StageResult } from './types.js';

export interface OrchestratorDeps {
  store: Store;
  trace: Trace;
  git: GitOps;
  handlers: Record<string, StageHandler>;
  /** Repositories from the config. A run can name one of these instead of giving a workspace. */
  repos?: RepoConfig[];
}

export interface StartRunInput {
  ticket: string;
  /** Name of a repo from the config (preferred). */
  repo?: string;
  /** Explicit checkout. Needed only when the repo is not in the config. */
  workspace?: string;
  project?: string;
  slug?: string;
  baseBranch?: string;
  /** Defaults to "auto": decided from the Jira issue type at intake. */
  workType?: WorkType;
  createdBy: string;
}

const TICKET = /^[A-Z][A-Z0-9_]+-\d+$/;

/**
 * Drives one run at a time per run id: stage, outcome, next stage. Gates pause the run until a human
 * decides. Fail edges are bounded. The run ends when the draft MR exists.
 */
export class Orchestrator {
  private active = new Map<string, AbortController>();
  private driving = new Set<string>();

  constructor(private d: OrchestratorDeps) {}

  /** Creates the run, the branch, and starts driving in the background. */
  async startRun(input: StartRunInput): Promise<RunRow> {
    if (!TICKET.test(input.ticket)) throw new UserError(`"${input.ticket}" is not a Jira issue key (expected like ABC-123)`);
    const known = input.repo ? this.d.repos?.find((r) => r.name === input.repo) : undefined;
    if (input.repo && !known && !input.workspace) {
      throw new UserError(`Repo "${input.repo}" is not in the config. Known repos: ${(this.d.repos ?? []).map((r) => r.name).join(', ') || 'none'}`);
    }
    const workspace = input.workspace ?? known?.workspace;
    const project = input.project ?? known?.project;
    const slug = input.slug ?? known?.slug ?? input.repo;
    if (!workspace || !project || !slug) throw new UserError('Give a configured repo name, or workspace, project and slug');
    const baseBranch = input.baseBranch ?? known?.baseBranch ?? 'main';
    const branch = `agents/${input.ticket.toLowerCase()}`;
    const busy = this.d.store.listRuns(200).find(
      (r) => r.workspace === workspace && ['running', 'awaiting_gate', 'blocked'].includes(r.status),
    );
    if (busy) throw new UserError(`Workspace is already used by run ${busy.id} (${busy.status}). Finish or cancel it first.`, 409);

    try {
      await this.d.git.syncCheckout(workspace, known?.url);
      await this.d.git.ensureBranch(workspace, branch, baseBranch);
    } catch (e) {
      throw new UserError(`Could not prepare the repository: ${e instanceof Error ? e.message : String(e)}`);
    }
    const run = this.d.store.createRun({
      ticket: input.ticket, workType: input.workType ?? 'auto', baseBranch, project, repo: slug,
      workspace, branch, createdBy: input.createdBy, firstStage: FIRST_STAGE,
    });
    this.d.trace.emit(run.id, 'run_started', null, { ticket: run.ticket, branch, baseBranch, by: input.createdBy });
    this.kick(run.id);
    return run;
  }

  /** Starts the drive loop in the background unless one is already running for this run. */
  kick(runId: string): void {
    if (this.driving.has(runId)) return;
    this.driving.add(runId);
    void this.drive(runId)
      .catch((e) => this.fail(runId, e))
      .finally(() => this.driving.delete(runId));
  }

  /** Awaitable form, mainly for tests. */
  async settle(runId: string): Promise<void> {
    while (this.driving.has(runId)) await new Promise((r) => setTimeout(r, 5));
  }

  /** After a restart: runs that were mid-stage continue, and gates keep waiting. */
  resumePending(): void {
    for (const r of this.d.store.runsByStatus('running')) this.kick(r.id);
  }

  private fail(runId: string, e: unknown): void {
    const message = e instanceof Error ? e.message : String(e);
    this.d.trace.emit(runId, 'run_failed', null, { error: message });
    this.d.store.updateRun(runId, { status: 'failed', blocked_reason: message });
  }

  private block(run: RunRow, reason: string): void {
    this.d.store.updateRun(run.id, { status: 'blocked', blocked_reason: reason });
    this.d.trace.emit(run.id, 'run_blocked', run.current_stage, { reason });
  }

  private async drive(runId: string): Promise<void> {
    const { store, trace } = this.d;
    for (;;) {
      const run = store.getRun(runId);
      if (!run || run.status !== 'running') return;
      const stage = getStage(run.current_stage);

      if (stage.kind === 'end') {
        store.updateRun(run.id, { status: 'completed', blocked_reason: null });
        trace.emit(run.id, 'run_completed', 'end', { mrUrl: run.mr_url });
        return;
      }
      if (stage.kind === 'gate') {
        const pending = store.pendingGate(run.id) ?? store.createGate(run.id, stage.gate!);
        store.updateRun(run.id, { status: 'awaiting_gate' });
        trace.emit(run.id, 'gate_requested', stage.id, { gate: pending.gate, gateId: pending.id });
        return;
      }

      const ac = new AbortController();
      this.active.set(run.id, ac);
      let result: StageResult;
      const started = Date.now();
      const attempt = store.countEvents(run.id, 'stage_enter', stage.id) + 1;
      trace.emit(run.id, 'stage_enter', stage.id, { attempt, kind: stage.kind });
      try {
        const handler = this.d.handlers[stage.id];
        if (!handler) throw new Error(`No handler for stage "${stage.id}"`);
        result = await handler({
          run, stage, runDir: runDirFor(run), attempt, signal: ac.signal, trace, store,
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        trace.emit(run.id, 'stage_error', stage.id, { error: message });
        result = { outcome: 'blocked', reason: message };
      } finally {
        this.active.delete(run.id);
      }

      if (ac.signal.aborted || store.getRun(run.id)?.status === 'cancelled') return;

      const note = result.outcome === 'blocked' ? result.reason : result.summary;
      trace.emit(run.id, 'stage_exit', stage.id, {
        outcome: result.outcome,
        durationMs: Date.now() - started,
        summary: note,
      });

      if (result.outcome === 'blocked') {
        this.block(run, result.reason);
        return;
      }
      if (result.outcome === 'pass' && stage.commitAfter) await this.commit(run, stage);
      if (!(await this.advance(run, stage, result.outcome, note))) return;
    }
  }

  private async commit(run: RunRow, stage: StageDef): Promise<void> {
    const changed = await this.d.git.commitAll(run.workspace, `[${run.ticket}] ${stage.label}`);
    if (changed) this.d.trace.emit(run.id, 'git_commit', stage.id, { message: `[${run.ticket}] ${stage.label}` });
  }

  /** Moves the run along the pipeline. Returns false when the run stopped (blocked). */
  private async advance(run: RunRow, stage: StageDef, outcome: 'pass' | 'fail', feedback?: string): Promise<boolean> {
    const { store, trace } = this.d;
    const edge = outcome === 'fail' ? failEdgeKey(stage.id) : null;
    const used = edge ? store.loopCount(run.id, edge) : 0;
    const next = resolveNext(stage.id, outcome, used);

    if (next.kind === 'blocked') {
      if (next.exhausted) trace.emit(run.id, 'limit_breach', stage.id, { kind: 'loops', detail: next.reason });
      this.block(run, next.reason);
      return false;
    }
    if (next.exhausted) {
      trace.emit(run.id, 'limit_breach', stage.id, { kind: 'loops', detail: `Loop budget used up (max ${next.max}); continuing to ${next.stage}` });
    }
    if (next.loopEdge) {
      const count = store.incLoop(run.id, next.loopEdge);
      trace.emit(run.id, 'loop_used', stage.id, { edge: next.loopEdge, count, max: next.max });
      if (feedback) appendFeedback(runDirFor(run), stage.id, feedback);
    }
    if (outcome === 'pass') {
      // A clean pass resets the loops that led here, so a later regression gets a fresh budget.
      store.resetLoops(run.id, `${stage.id}->`);
    }
    store.updateRun(run.id, { current_stage: next.stage });
    return true;
  }

  /** A human decision on the pending gate. */
  async decideGate(runId: string, gate: string, decision: 'approved' | 'rejected', by: string, comment?: string): Promise<RunRow> {
    const { store, trace } = this.d;
    const run = store.getRun(runId);
    if (!run) throw new UserError('Run not found', 404);
    const pending = store.pendingGate(runId);
    if (run.status !== 'awaiting_gate' || !pending) throw new UserError('This run is not waiting for a gate', 409);
    if (pending.gate !== gate) throw new UserError(`The pending gate is ${pending.gate}, not ${gate}`, 409);
    if (decision === 'rejected' && !comment?.trim()) throw new UserError('A rejection needs a comment so the agents know what to change');

    store.decideGate(pending.id, decision, by, comment?.trim() || null);
    trace.emit(runId, 'gate_decided', run.current_stage, { gate, decision, by, comment: comment ?? null });

    store.updateRun(runId, { status: 'running' });
    const fresh = store.getRun(runId)!;
    const stage = getStage(fresh.current_stage);
    const ok = await this.advance(fresh, stage, decision === 'approved' ? 'pass' : 'fail');
    if (ok && decision === 'rejected') appendFeedback(runDirFor(fresh), `${gate} reviewer ${by}`, comment!);
    if (ok) this.kick(runId);
    return store.getRun(runId)!;
  }

  /** Continues a blocked run from the stage that blocked it. Loop counters are reset. */
  retry(runId: string, by: string): RunRow {
    const { store, trace } = this.d;
    const run = store.getRun(runId);
    if (!run) throw new UserError('Run not found', 404);
    if (run.status !== 'blocked' && run.status !== 'failed') throw new UserError('Only a blocked or failed run can be retried', 409);
    store.resetLoops(runId, '');
    store.updateRun(runId, { status: 'running', blocked_reason: null });
    trace.emit(runId, 'run_retry', run.current_stage, { by });
    this.kick(runId);
    return store.getRun(runId)!;
  }

  cancel(runId: string, by: string): RunRow {
    const { store, trace } = this.d;
    const run = store.getRun(runId);
    if (!run) throw new UserError('Run not found', 404);
    if (['completed', 'cancelled'].includes(run.status)) throw new UserError(`Run is already ${run.status}`, 409);
    store.updateRun(runId, { status: 'cancelled' });
    this.active.get(runId)?.abort();
    trace.emit(runId, 'run_cancelled', run.current_stage, { by });
    return store.getRun(runId)!;
  }
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolBroker } from './broker.js';
import type { AppConfig } from './config.js';
import type { Store } from './db.js';
import { isTestFile, type GitOps } from './git.js';
import { STAGES, type StageDef } from './pipeline.js';
import type { Exec } from './proc.js';
import { modelFor } from './runners/command-runner.js';
import { buildIndex, indexDir } from './indexer/index.js';
import { renderContext, renderRepoMap } from './indexer/render.js';
import {
  attachmentsMarkdown, confluencePageIds, detectWorkType, issueSummary, issueTypeName, normalizeAttachments,
  pageToMarkdown, saveAttachments, textOf, type SavedAttachment,
} from './intake.js';
import { clearResult, buildPromptFile, readResult } from './runners/prompt.js';
import type { AgentRunner } from './runners/types.js';
import { mutationRun, qualityGate, redCheck } from './scripts/handlers.js';
import type { StageHandler } from './types.js';

export interface StageDeps {
  runner: AgentRunner;
  broker: ToolBroker;
  git: GitOps;
  exec: Exec;
  config: AppConfig;
  store: Store;
  /** Code index access for agents. Omitted in tests. */
  navigation?: { repoMap: (workspace: string) => string; findCommand: string };
}

function tail(text: string, chars = 400): string {
  const t = text.trim();
  return t.length > chars ? `…${t.slice(-chars)}` : t;
}

/** Returns a reason when the token budget for this stage or run is used up. */
export function budgetBreach(store: Store, config: AppConfig, runId: string, stageId: string): string | null {
  const stageTokens = store.tokensFor(runId, stageId);
  if (stageTokens > config.budgets.perStageTokens) {
    return `Token budget for "${stageId}" used up (${stageTokens} of ${config.budgets.perStageTokens})`;
  }
  const runTokens = store.tokensFor(runId);
  if (runTokens > config.budgets.perRunTokens) {
    return `Token budget for the run used up (${runTokens} of ${config.budgets.perRunTokens})`;
  }
  return null;
}

/** Generic agent stage: build the prompt file, run the tool once, read the result file. */
export function agentHandler(deps: StageDeps): StageHandler {
  return async (ctx) => {
    const { run, stage, runDir } = ctx;
    mkdirSync(join(runDir, 'results'), { recursive: true });
    const promptFile = buildPromptFile({
      stage, run, rolesDir: deps.config.rolesDir, runDir, attempt: ctx.attempt,
      worktypesDir: deps.config.worktypesDir, vision: deps.config.runner.vision,
      navigation: deps.navigation && existsSync(deps.navigation.repoMap(run.workspace))
        ? { repoMap: deps.navigation.repoMap(run.workspace), findCommand: deps.navigation.findCommand }
        : undefined,
    });
    clearResult(runDir, stage.id);

    const res = await deps.runner.run({
      runId: run.id,
      stage: stage.id,
      promptFile,
      cwd: run.workspace,
      model: modelFor(deps.config.runner, stage.id),
      timeoutMs: deps.config.runner.timeoutMs,
      signal: ctx.signal,
    });
    ctx.trace.emit(run.id, 'llm_call', stage.id, {
      runner: deps.runner.name,
      model: modelFor(deps.config.runner, stage.id) ?? 'default',
      tokensIn: res.tokensIn,
      tokensOut: res.tokensOut,
      cacheReadTokens: res.cacheReadTokens,
      costUsd: res.costUsd,
      turns: res.turns,
      durationMs: res.durationMs,
      exitCode: res.exitCode,
      timedOut: res.timedOut,
      estimated: res.estimated,
      attempt: ctx.attempt,
    });

    if (res.aborted) return { outcome: 'blocked', reason: 'The run was cancelled' };
    const breach = budgetBreach(deps.store, deps.config, run.id, stage.id);
    if (breach) {
      ctx.trace.emit(run.id, 'limit_breach', stage.id, { kind: 'tokens', detail: breach });
      return { outcome: 'blocked', reason: breach };
    }
    if (res.exitCode !== 0) {
      return { outcome: 'fail', summary: `${deps.runner.name} exited with ${res.exitCode}${res.timedOut ? ' (timed out)' : ''}: ${tail(res.output)}` };
    }

    if (stage.lockTests) {
      const offenders = (await deps.git.dirtyFiles(run.workspace)).filter((f) => isTestFile(f.path));
      if (offenders.length) {
        await deps.git.revertFiles(run.workspace, offenders);
        ctx.trace.emit(run.id, 'guard_violation', stage.id, { files: offenders.map((o) => o.path) });
        return { outcome: 'fail', summary: `Test files must not change in this stage. Reverted: ${offenders.map((o) => o.path).join(', ')}` };
      }
    }

    const result = readResult(runDir, stage.id);
    if (!result) {
      ctx.trace.emit(run.id, 'result_missing', stage.id, {});
      return { outcome: 'pass', summary: tail(res.output) || 'No result file written; treated as pass because the tool exited cleanly' };
    }
    return { outcome: result.status, summary: result.summary, data: result };
  };
}

/** Intake: Jira and Confluence are read through the broker (no LLM), then the agent structures the ticket. */
export function intakeHandler(deps: StageDeps): StageHandler {
  const agent = agentHandler(deps);
  return async (ctx) => {
    const { run, runDir } = ctx;
    const key = run.ticket;
    const optional = async (tool: string) => {
      try { return await deps.broker.call(run.id, 'intake', tool, { issueKey: key }); }
      catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
    };
    const issue = await deps.broker.call(run.id, 'intake', 'jira.get_issue', { issueKey: key });
    const comments = await optional('jira.get_comments');
    const attachmentList = await optional('jira.get_attachments');
    const linkedIssues = await optional('jira.get_linked_issues');
    mkdirSync(runDir, { recursive: true });

    const title = issueSummary(issue);
    if (title) deps.store.updateRun(run.id, { title });
    if (run.work_type === 'auto') {
      const workType = detectWorkType(issue, deps.config.jira.workTypes);
      deps.store.updateRun(run.id, { work_type: workType });
      ctx.trace.emit(run.id, 'worktype_set', ctx.stage.id, { workType, issueType: issueTypeName(issue) ?? null });
    }

    const list = normalizeAttachments(attachmentList, issue);
    let saved: SavedAttachment[] = [];
    if (list.length) {
      saved = deps.broker.has('jira.download_attachment')
        ? await saveAttachments(deps.broker, run.id, key, list, runDir, deps.config.attachments)
        : list.map((a) => ({ ...a, skipped: 'jira.download_attachment is not mapped in the config' }));
      const images = saved.filter((s) => s.path && s.kind === 'image').length;
      ctx.trace.emit(run.id, 'attachments_saved', ctx.stage.id, { total: list.length, downloaded: saved.filter((s) => s.path).length, images });
      if (images && !deps.config.runner.vision) {
        ctx.trace.emit(run.id, 'warning', ctx.stage.id, { message: `${images} image(s) saved, but llm.vision is false. UI details must be confirmed by a person at G1.` });
      }
      if (saved.some((s) => s.skipped && s.kind !== 'other')) {
        ctx.trace.emit(run.id, 'warning', ctx.stage.id, { message: 'Some attachments could not be downloaded', files: saved.filter((s) => s.skipped && s.kind !== 'other').map((s) => `${s.filename}: ${s.skipped}`) });
      }
    }
    writeFileSync(join(runDir, 'attachments.json'), `${JSON.stringify(saved.map(({ path: p, ...rest }) => ({ ...rest, file: p })), null, 2)}\n`);
    writeFileSync(join(runDir, 'attachments.md'), attachmentsMarkdown(saved, deps.config.runner.vision));

    const pages: string[] = [];
    if (deps.broker.has('confluence.get_page')) {
      for (const id of confluencePageIds(textOf([issue, comments, linkedIssues]))) {
        try {
          pages.push(pageToMarkdown(id, await deps.broker.call(run.id, 'intake', 'confluence.get_page', { pageId: id })));
        } catch (e) {
          pages.push(`## Page ${id}\n\nCould not be read: ${e instanceof Error ? e.message : String(e)}\n`);
        }
      }
    }
    writeFileSync(join(runDir, 'confluence.md'), `# Confluence pages linked from the ticket\n\n${pages.join('\n') || 'None referenced.\n'}`);

    writeFileSync(join(runDir, 'ticket.json'), `${JSON.stringify({
      fetchedAt: new Date().toISOString(), issue, comments, attachments: list, linkedIssues,
    }, null, 2)}\n`);

    const result = await agent({ ...ctx, run: deps.store.getRun(run.id) ?? run });
    if (result.outcome === 'blocked') return result;
    const data = (result.data ?? {}) as { ambiguous?: boolean; questions?: unknown };
    if (data.ambiguous === true) {
      const questions = Array.isArray(data.questions) ? data.questions.map(String) : [];
      const body = [
        '[SDLC agents] This ticket needs clarification before work can start:',
        ...questions.map((q, i) => `${i + 1}. ${q}`),
      ].join('\n');
      await deps.broker.call(run.id, 'intake', 'jira.add_comment', { issueKey: key, body });
      return { outcome: 'blocked', reason: 'The ticket is ambiguous. The questions were posted to Jira. Retry once the ticket is updated.' };
    }
    return result;
  };
}

/**
 * Refreshes the code index before an agent stage (milliseconds when little changed) and, for the
 * spec and plan stages, picks the files most likely to matter for this ticket.
 */
export function indexed(deps: StageDeps, inner: StageHandler, context?: 'ticket' | 'ticket+spec'): StageHandler {
  return async (ctx) => {
    const { index, stats } = buildIndex(ctx.run.workspace);
    writeFileSync(join(indexDir(ctx.run.workspace), 'repo-map.md'), renderRepoMap(index, deps.config.index.mapTokens));
    ctx.trace.emit(ctx.run.id, 'index_built', ctx.stage.id, { ...stats });
    if (context) {
      const read = (f: string) => (existsSync(join(ctx.runDir, f)) ? readFileSync(join(ctx.runDir, f), 'utf8') : '');
      const text = [ctx.run.title ?? '', read('ticket.md'), context === 'ticket+spec' ? read('spec.md') : ''].join('\n');
      writeFileSync(join(ctx.runDir, 'context.md'), renderContext(index, text, deps.config.index.contextFiles));
    }
    return inner(ctx);
  };
}

function findUrl(value: unknown): string | null {
  if (typeof value === 'string') return /https?:\/\/\S+/.exec(value)?.[0] ?? null;
  if (value && typeof value === 'object') {
    const v = value as Record<string, any>;
    const direct = v.url ?? v.html_url ?? v.links?.self?.[0]?.href ?? v.links?.html?.href;
    if (typeof direct === 'string') return direct;
    for (const x of Object.values(v)) {
      const f = findUrl(x);
      if (f) return f;
    }
  }
  return null;
}

/** Draft MR: the agent writes the description, then the service pushes and opens the draft MR. */
export function draftMrHandler(deps: StageDeps): StageHandler {
  const agent = agentHandler(deps);
  return async (ctx) => {
    const { run, runDir } = ctx;
    const result = await agent(ctx);
    if (result.outcome !== 'pass') return result;

    const descFile = join(runDir, 'mr-description.md');
    if (!existsSync(descFile)) return { outcome: 'blocked', reason: 'The MR agent did not write mr-description.md' };
    const description = readFileSync(descFile, 'utf8');
    const heading = /^#\s+(.+)$/m.exec(description)?.[1]?.trim();
    const title = `[${run.ticket}] ${heading ?? 'Implementation by SDLC agents'}`;

    if (await deps.git.commitAll(run.workspace, `[${run.ticket}] final changes`)) {
      ctx.trace.emit(run.id, 'git_commit', ctx.stage.id, { message: 'final changes' });
    }
    await deps.git.push(run.workspace, run.branch);
    ctx.trace.emit(run.id, 'git_push', ctx.stage.id, { branch: run.branch });

    const pr = await deps.broker.call(run.id, 'draft_mr', 'bitbucket.create_pull_request', {
      project: run.project,
      repo: run.repo,
      title,
      description,
      fromBranch: run.branch,
      toBranch: run.base_branch,
      draft: true,
    });
    const url = findUrl(pr);
    if (url) deps.store.updateRun(run.id, { mr_url: url });
    ctx.trace.emit(run.id, 'mr_created', ctx.stage.id, { url, title });
    return { outcome: 'pass', summary: url ? `Draft MR created: ${url}` : 'Draft MR created' };
  };
}

/** Wires every non-gate, non-end stage to its handler. */
export function buildHandlers(deps: StageDeps): Record<string, StageHandler> {
  const scripts = { exec: deps.exec, config: deps.config, git: deps.git };
  const special: Record<string, StageHandler> = {
    intake: intakeHandler(deps),
    draft_mr: draftMrHandler(deps),
    red_check: redCheck(scripts),
    mutation_run: mutationRun(scripts),
    quality_gate: qualityGate(scripts),
  };
  const generic = agentHandler(deps);
  const withIndex = (id: string): StageHandler =>
    deps.navigation ? indexed(deps, generic, id === 'spec' ? 'ticket' : id === 'plan' ? 'ticket+spec' : undefined) : generic;
  const out: Record<string, StageHandler> = {};
  for (const s of STAGES as StageDef[]) {
    if (s.kind === 'gate' || s.kind === 'end') continue;
    out[s.id] = special[s.id] ?? (s.kind === 'agent' ? withIndex(s.id) : (() => { throw new Error(`No handler for ${s.id}`); }) as StageHandler);
  }
  return out;
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { AppConfig } from '../config.js';
import { isProductionLogic, isTestFile, type GitOps } from '../git.js';
import { failuresOnly, type Exec } from '../proc.js';
import type { StageContext, StageHandler, StageResult } from '../types.js';
import { detectModules, hasMutationConfig, moduleOf, mutationCommand, type Cmd, type ModuleInfo } from './detect.js';
import { evaluateMutation, mergeSummaries, parsePitXml, parseStrykerJson, type MutationSummary } from './mutation.js';
import { classifyRedRun } from './red-check.js';

export interface ScriptDeps {
  exec: Exec;
  config: AppConfig;
  git: GitOps;
}

function writeJson(runDir: string, name: string, data: unknown): void {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, name), `${JSON.stringify(data, null, 2)}\n`);
}

/** Runs one command and records it as a script_run event. No LLM is involved. */
async function run(ctx: StageContext, deps: ScriptDeps, label: string, cmd: Cmd, cwd: string, timeoutMs = 30 * 60 * 1000) {
  const r = await deps.exec(cmd.command, cmd.args, { cwd, timeoutMs, signal: ctx.signal });
  ctx.trace.emit(ctx.run.id, 'script_run', ctx.stage.id, {
    label,
    command: `${cmd.command} ${cmd.args.join(' ')}`,
    cwd: relative(ctx.run.workspace, cwd) || '.',
    exitCode: r.exitCode,
    durationMs: r.durationMs,
    timedOut: r.timedOut,
  });
  return r;
}

function modulesTouchedBy(modules: ModuleInfo[], files: string[]): ModuleInfo[] {
  return [...new Set(files.map((f) => moduleOf(modules, f)).filter((m): m is ModuleInfo => Boolean(m)))];
}

/** Step 5: the new tests must fail on behaviour, not on build errors. */
export function redCheck(deps: ScriptDeps): StageHandler {
  return async (ctx) => {
    const modules = detectModules(ctx.run.workspace);
    if (!modules.length) return { outcome: 'blocked', reason: 'No Maven, Gradle or npm module was found in the workspace' };
    const changed = await deps.git.changedFiles(ctx.run.workspace, ctx.run.base_branch);
    const testFiles = changed.filter(isTestFile);
    const touched = modulesTouchedBy(modules, testFiles);
    if (!touched.length) {
      writeJson(ctx.runDir, 'red-report.json', { pass: false, reason: 'No new or changed test files found', modules: [] });
      return { outcome: 'fail', summary: 'No new or changed test files were found. The RED stage must add tests.' };
    }
    const report = [];
    for (const m of touched) {
      const r = await run(ctx, deps, `tests:${m.dir}`, m.testCommand, m.abs);
      const output = `${r.stdout}\n${r.stderr}`;
      const verdict = classifyRedRun({ exitCode: r.exitCode, output, timedOut: r.timedOut });
      report.push({ dir: m.dir, kind: m.kind, exitCode: r.exitCode, ok: verdict.ok, reason: verdict.reason, tail: failuresOnly(output) });
    }
    const pass = report.every((x) => x.ok);
    writeJson(ctx.runDir, 'red-report.json', { pass, testFiles, modules: report });
    return pass
      ? { outcome: 'pass', summary: `Tests fail on behaviour in ${report.length} module(s), as expected` }
      : { outcome: 'fail', summary: report.filter((x) => !x.ok).map((x) => `${x.dir}: ${x.reason}`).join('; ') };
  };
}

function parseReport(m: ModuleInfo, file: string, changedRel: string[]): MutationSummary {
  const text = readFileSync(file, 'utf8');
  return m.mutationTool === 'pit' ? parsePitXml(text, changedRel) : parseStrykerJson(text, changedRel);
}

/** Step 9: PIT or StrykerJS on the changed code only. The report is trimmed to survivors. */
export function mutationRun(deps: ScriptDeps): StageHandler {
  return async (ctx): Promise<StageResult> => {
    const threshold = deps.config.mutation.threshold;
    const modules = detectModules(ctx.run.workspace);
    const changed = (await deps.git.changedFiles(ctx.run.workspace, ctx.run.base_branch)).filter(isProductionLogic);
    if (!changed.length) {
      writeJson(ctx.runDir, 'mutation-report.json', { skipped: true, reason: 'No production logic changed', score: 100, total: 0, threshold, survivors: [] });
      return { outcome: 'pass', summary: 'No production logic changed, mutation run skipped' };
    }
    const touched = modulesTouchedBy(modules, changed);
    if (!touched.length) return { outcome: 'blocked', reason: 'Changed files do not belong to a detected build module' };

    const parts: MutationSummary[] = [];
    for (const m of touched) {
      if (!hasMutationConfig(m)) {
        return {
          outcome: 'blocked',
          reason: `The mutation tool (${m.mutationTool === 'pit' ? 'PIT' : 'StrykerJS'}) is not configured in "${m.dir}". Add its config as a separate, human-approved commit, then retry.`,
        };
      }
      const rel = changed
        .filter((f) => moduleOf(modules, f) === m)
        .map((f) => (m.dir === '.' ? f : f.slice(m.dir.length + 1)));
      const r = await run(ctx, deps, `mutation:${m.dir}`, mutationCommand(m, rel), m.abs);
      const reportFile = join(m.abs, m.reportPath);
      if (!existsSync(reportFile)) {
        return { outcome: 'blocked', reason: `No mutation report at ${m.reportPath} in "${m.dir}" (exit ${r.exitCode}): ${failuresOnly(`${r.stdout}\n${r.stderr}`, 800)}` };
      }
      parts.push(parseReport(m, reportFile, rel));
    }
    const merged = mergeSummaries(parts);
    const verdict = evaluateMutation(merged, { threshold });
    writeJson(ctx.runDir, 'mutation-report.json', {
      tool: merged.tool, score: merged.score, total: merged.total, killed: merged.killed, timeout: merged.timeout,
      survived: merged.survived, noCoverage: merged.noCoverage, threshold, survivors: merged.survivors.slice(0, 100),
      survivorsOmitted: Math.max(0, merged.survivors.length - 100),
    });
    return verdict.pass
      ? { outcome: 'pass', summary: `Mutation score ${merged.score}% (threshold ${threshold}%)` }
      : { outcome: 'fail', summary: `${verdict.reasons.join('; ')}. ${merged.survivors.length} survivors.` };
  };
}

/** Step 13: build and tests, extra commands (for example Sonar), and the mutation ratchet. */
export function qualityGate(deps: ScriptDeps): StageHandler {
  return async (ctx) => {
    const modules = detectModules(ctx.run.workspace);
    const changed = await deps.git.changedFiles(ctx.run.workspace, ctx.run.base_branch);
    const touched = modulesTouchedBy(modules, changed);
    const checks: { name: string; ok: boolean; detail?: string }[] = [];

    for (const m of touched.length ? touched : modules) {
      const r = await run(ctx, deps, `tests:${m.dir}`, m.testCommand, m.abs);
      checks.push({ name: `tests:${m.dir}`, ok: r.exitCode === 0, detail: r.exitCode === 0 ? undefined : failuresOnly(`${r.stdout}\n${r.stderr}`, 1500) });
    }
    for (const q of deps.config.qualityCommands) {
      const r = await run(ctx, deps, q.name, { command: q.command, args: q.args }, ctx.run.workspace);
      checks.push({ name: q.name, ok: r.exitCode === 0, detail: r.exitCode === 0 ? undefined : failuresOnly(`${r.stdout}\n${r.stderr}`, 1500) });
    }

    let mutation: { score: number; total: number; threshold: number; baseline?: number; reasons: string[] } | undefined;
    const reportFile = join(ctx.runDir, 'mutation-report.json');
    if (existsSync(reportFile)) {
      const rep = JSON.parse(readFileSync(reportFile, 'utf8')) as { score: number; total: number };
      const baselineFile = join(ctx.run.workspace, '.agents', 'mutation-baseline.json');
      const baseline = existsSync(baselineFile) ? (JSON.parse(readFileSync(baselineFile, 'utf8')) as { score?: number }).score : undefined;
      const verdict = evaluateMutation(rep, { threshold: deps.config.mutation.threshold, baseline });
      mutation = { score: rep.score, total: rep.total, threshold: deps.config.mutation.threshold, baseline, reasons: verdict.reasons };
      checks.push({ name: 'mutation', ok: verdict.pass, detail: verdict.reasons.join('; ') || undefined });
    }

    const pass = checks.every((c) => c.ok);
    writeJson(ctx.runDir, 'quality-report.json', { pass, checks, mutation });
    return pass
      ? { outcome: 'pass', summary: `${checks.length} checks passed` }
      : { outcome: 'fail', summary: `Failed: ${checks.filter((c) => !c.ok).map((c) => c.name).join(', ')}` };
  };
}

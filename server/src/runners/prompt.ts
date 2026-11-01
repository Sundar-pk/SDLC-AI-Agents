import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunRow } from '../db.js';
import type { StageDef } from '../pipeline.js';

export interface PromptInput {
  stage: StageDef;
  run: RunRow;
  rolesDir: string;
  runDir: string;
  attempt: number;
  /** Folder with feature.md, bug.md and change.md. Each has one "## <role>" section per role. */
  worktypesDir?: string;
  /** Where the agent finds the code index. Omitted when no index was built. */
  navigation?: { repoMap: string; findCommand: string };
  /** Can the model look at images? */
  vision?: boolean;
}

const WORK_TYPE_TITLE: Record<string, string> = {
  feature: 'New requirement',
  bug: 'Bug fix',
  change: 'Change request',
};

/** Picks the "## <role>" section out of a work type file, so each stage only pays for its own guidance. */
export function worktypeSection(dir: string | undefined, workType: string, role: string): string | null {
  if (!dir || !WORK_TYPE_TITLE[workType]) return null;
  const file = join(dir, `${workType}.md`);
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');
  const parts = text.split(/^## /m);
  const mine = parts.find((p) => p.startsWith(`${role}\n`) || p.startsWith(`${role}\r\n`));
  const intro = parts[0]!.trim();
  if (!mine) return intro || null;
  const body = mine.slice(mine.indexOf('\n') + 1).trim();
  return [intro, body].filter(Boolean).join('\n\n');
}

export interface ResultFile {
  status: 'pass' | 'fail';
  summary?: string;
  [key: string]: unknown;
}

export function resultPath(runDir: string, stageId: string): string {
  return join(runDir, 'results', `${stageId}.result.json`);
}

export function clearResult(runDir: string, stageId: string): void {
  rmSync(resultPath(runDir, stageId), { force: true });
}

/** Reads the result file the agent was told to write. Returns null if missing or malformed. */
export function readResult(runDir: string, stageId: string): ResultFile | null {
  const p = resultPath(runDir, stageId);
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, 'utf8')) as ResultFile;
    return j && (j.status === 'pass' || j.status === 'fail') ? j : null;
  } catch {
    return null;
  }
}

export function appendFeedback(runDir: string, from: string, comment: string): void {
  mkdirSync(runDir, { recursive: true });
  const line = `\n## ${new Date().toISOString()} · ${from}\n${comment.trim()}\n`;
  writeFileSync(join(runDir, 'feedback.md'), line, { flag: 'a' });
}

function tail(text: string, chars: number): string {
  return text.length > chars ? `…${text.slice(-chars)}` : text;
}

/**
 * Builds the prompt file for one agent call: the role file plus the run context and the
 * result contract. Any tool can follow it, because it only needs to read one file.
 */
export function buildPromptFile(i: PromptInput): string {
  if (!i.stage.role) throw new Error(`Stage "${i.stage.id}" has no role`);
  const rolePath = join(i.rolesDir, `${i.stage.role}.md`);
  if (!existsSync(rolePath)) throw new Error(`Role file not found: ${rolePath}`);
  const role = readFileSync(rolePath, 'utf8').trim();

  const inputs = i.stage.inputs.map((f) => {
    const p = join(i.runDir, f);
    return `- ${p}${existsSync(p) ? '' : ' (not present)'}`;
  });
  const outputs = i.stage.outputs.map((f) => `- ${join(i.runDir, f)}`);
  const feedbackFile = join(i.runDir, 'feedback.md');
  const feedback = existsSync(feedbackFile) ? tail(readFileSync(feedbackFile, 'utf8').trim(), 3000) : '';
  const result = resultPath(i.runDir, i.stage.id);

  const wtSection = worktypeSection(i.worktypesDir, i.run.work_type, i.stage.role);
  const attachmentsFile = join(i.runDir, 'attachments.json');
  const hasImages = existsSync(attachmentsFile) && /"kind":\s*"image"/.test(readFileSync(attachmentsFile, 'utf8'));
  const nav = i.navigation && i.stage.kind === 'agent' && i.stage.id !== 'intake' && i.stage.id !== 'draft_mr';

  const doc = [
    role,
    ...(wtSection ? ['', `## Work type: ${WORK_TYPE_TITLE[i.run.work_type] ?? i.run.work_type}`, wtSection] : []),
    '',
    '---',
    '# Run context (written by the orchestrator)',
    `- Ticket: ${i.run.ticket}`,
    `- Stage: ${i.stage.n} · ${i.stage.label} (${i.stage.id}), attempt ${i.attempt}`,
    `- Workspace (your working directory): ${i.run.workspace}`,
    `- Artifacts directory: ${i.runDir}`,
    `- Branch: ${i.run.branch} (base: ${i.run.base_branch})`,
    '',
    ...(i.run.title ? [`- Title: ${i.run.title}`] : []),
    `- Work type: ${WORK_TYPE_TITLE[i.run.work_type] ?? i.run.work_type}`,
    '',
    '## Read these first',
    ...(inputs.length ? inputs : ['- (nothing specific)']),
    ...(nav
      ? [
          '',
          '## Finding code (do not scan the repository)',
          `- Repo map (key files, types, routes, covering tests): ${i.navigation!.repoMap}`,
          `- Search symbols and files: ${i.navigation!.findCommand} <term>`,
          '- Read only the lines you need from the files it points to.',
        ]
      : []),
    ...(hasImages
      ? [
          '',
          '## Attachments contain images (UI screens or diagrams)',
          i.vision
            ? `- Open the image files listed in ${join(i.runDir, 'attachments.md')} and use them. Treat them as the source of truth for layout and wording.`
            : '- The configured model cannot view images. Do not guess what they show. State in your output that the images were not inspected, and list the UI details a person must confirm.',
        ]
      : []),
    '',
    '## Write these',
    ...(outputs.length ? outputs : ['- (no artifact files)']),
    ...(feedback ? ['', '## Reviewer feedback to address', feedback] : []),
    '',
    '## Finishing',
    `When you are done, write exactly this file: ${result}`,
    '{"status": "pass" | "fail", "summary": "one or two sentences"}',
    'Use "fail" only if you could not complete the stage. Keep replies short and do not paste long logs.',
    '',
  ].join('\n');

  const promptDir = join(i.runDir, 'prompts');
  mkdirSync(promptDir, { recursive: true });
  const file = join(promptDir, `${i.stage.id}-${i.attempt}.md`);
  writeFileSync(file, doc);
  return file;
}

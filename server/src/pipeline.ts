/**
 * The 2S IT pipeline definition: Jira ticket -> draft merge request, then the run stops.
 * Mirrors page 1 of the design canvas. Stage ids are stable API; the UI renders from /api/pipeline.
 */

export type StageKind = 'agent' | 'script' | 'gate' | 'end';
export type Phase = 'define' | 'red' | 'green' | 'refactor' | 'mutate' | 'verify' | 'deliver';

export interface StageDef {
  id: string;
  /** Number shown in the UI: "1".."14", "G1", "G2", "END". */
  n: string;
  label: string;
  kind: StageKind;
  phase: Phase | 'gate' | 'end';
  /** Role file name (without .md) under the roles directory. Agent stages only. */
  role?: string;
  gate?: 'G1' | 'G2';
  /** Artifact file names (relative to the run directory) the agent should read. */
  inputs: string[];
  /** Artifact file names the agent should write. */
  outputs: string[];
  /** Logical MCP tool names this stage may call. Everything else is denied. */
  mcpTools: string[];
  /** Commit the workspace after this stage (work is saved between phases). */
  commitAfter?: boolean;
  /** Edits to test files during this stage are reverted and the stage fails. */
  lockTests?: boolean;
}

export const STAGES: StageDef[] = [
  {
    id: 'intake', n: '1', label: 'Intake', kind: 'agent', phase: 'define', role: 'jira_reader',
    inputs: ['ticket.json', 'attachments.md', 'confluence.md'], outputs: ['ticket.md'],
    mcpTools: [
      'jira.get_issue', 'jira.get_comments', 'jira.get_attachments', 'jira.download_attachment', 'jira.get_linked_issues',
      'jira.add_comment', 'confluence.get_page',
    ],
  },
  {
    id: 'spec', n: '2', label: 'Spec', kind: 'agent', phase: 'define', role: 'spec_agent',
    inputs: ['ticket.md', 'context.md', 'attachments.md'], outputs: ['spec.md'], mcpTools: [],
  },
  {
    id: 'plan', n: '3', label: 'Plan & strategy', kind: 'agent', phase: 'define', role: 'planner',
    inputs: ['spec.md', 'context.md'], outputs: ['plan.md', 'test-plan.md'], mcpTools: [],
  },
  {
    id: 'g1', n: 'G1', label: 'Approve strategy', kind: 'gate', phase: 'gate', gate: 'G1',
    inputs: ['spec.md', 'plan.md', 'test-plan.md'], outputs: [], mcpTools: [],
  },
  {
    id: 'red', n: '4', label: 'RED', kind: 'agent', phase: 'red', role: 'test_author',
    inputs: ['spec.md', 'test-plan.md'], outputs: ['red-notes.md'], mcpTools: [], commitAfter: true,
  },
  {
    id: 'red_check', n: '5', label: 'Red check', kind: 'script', phase: 'red',
    inputs: [], outputs: ['red-report.json'], mcpTools: [],
  },
  {
    id: 'test_review', n: '6', label: 'Test review', kind: 'agent', phase: 'red', role: 'test_reviewer',
    inputs: ['spec.md', 'test-plan.md', 'red-report.json'], outputs: ['test-review.md'], mcpTools: [],
  },
  {
    id: 'green', n: '7', label: 'GREEN', kind: 'agent', phase: 'green', role: 'coder',
    inputs: ['spec.md', 'plan.md', 'test-review.md'], outputs: ['green-notes.md'], mcpTools: [],
    commitAfter: true, lockTests: true,
  },
  {
    id: 'refactor', n: '8', label: 'REFACTOR', kind: 'agent', phase: 'refactor', role: 'refactorer',
    inputs: ['plan.md', 'green-notes.md'], outputs: ['refactor-notes.md'], mcpTools: [],
    commitAfter: true, lockTests: true,
  },
  {
    id: 'mutation_run', n: '9', label: 'Mutation run', kind: 'script', phase: 'mutate',
    inputs: [], outputs: ['mutation-report.json'], mcpTools: [],
  },
  {
    id: 'kill_survivors', n: '10', label: 'Kill survivors', kind: 'agent', phase: 'mutate', role: 'mutation_analyst',
    inputs: ['mutation-report.json', 'test-plan.md'], outputs: ['survivors.md'], mcpTools: [], commitAfter: true,
  },
  {
    id: 'code_review', n: '11', label: 'Code review', kind: 'agent', phase: 'verify', role: 'code_reviewer',
    inputs: ['spec.md', 'plan.md'], outputs: ['review.md'], mcpTools: [],
  },
  {
    id: 'reconcile', n: '12', label: 'Reconcile', kind: 'agent', phase: 'verify', role: 'integration_agent',
    inputs: ['plan.md', 'review.md'], outputs: ['reconcile.md'], mcpTools: [],
  },
  {
    id: 'quality_gate', n: '13', label: 'Quality gate', kind: 'script', phase: 'verify',
    inputs: [], outputs: ['quality-report.json'], mcpTools: [],
  },
  {
    id: 'g2', n: 'G2', label: 'Approve code', kind: 'gate', phase: 'gate', gate: 'G2',
    inputs: ['review.md', 'mutation-report.json', 'survivors.md', 'quality-report.json'], outputs: [], mcpTools: [],
  },
  {
    id: 'draft_mr', n: '14', label: 'Draft MR', kind: 'agent', phase: 'deliver', role: 'mr_agent',
    inputs: ['spec.md', 'review.md', 'mutation-report.json', 'quality-report.json'],
    outputs: ['mr-description.md'],
    mcpTools: ['bitbucket.get_diff', 'bitbucket.create_pull_request'],
  },
  {
    id: 'end', n: 'END', label: 'MR created, run ends', kind: 'end', phase: 'end',
    inputs: [], outputs: [], mcpTools: [],
  },
];

export const FIRST_STAGE = STAGES[0]!.id;
export const DEFAULT_MAX_LOOPS = 2;

export interface Transition {
  /** Next stage on success (for gates: approved). */
  pass: string;
  /** Next stage on failure (for gates: rejected). No fail edge means the run blocks. */
  fail?: string;
  /** Times the fail edge may be taken per run. Default 2. */
  maxLoops?: number;
  /** What to do when the fail edge is exhausted. Default: block and ask a human. */
  onExhausted?: 'block' | { goto: string };
}

export const TRANSITIONS: Record<string, Transition> = {
  intake: { pass: 'spec' },
  spec: { pass: 'plan' },
  plan: { pass: 'g1' },
  g1: { pass: 'red', fail: 'plan', maxLoops: 3 },
  red: { pass: 'red_check', fail: 'red' },
  red_check: { pass: 'test_review', fail: 'red' },
  test_review: { pass: 'green', fail: 'red' },
  green: { pass: 'refactor', fail: 'green' },
  refactor: { pass: 'mutation_run' },
  // Survivors that remain after the loop budget go to the human at G2 (survivors.md) instead of blocking.
  mutation_run: { pass: 'code_review', fail: 'kill_survivors', onExhausted: { goto: 'code_review' } },
  kill_survivors: { pass: 'mutation_run' },
  code_review: { pass: 'reconcile', fail: 'green' },
  reconcile: { pass: 'quality_gate', fail: 'green' },
  quality_gate: { pass: 'g2', fail: 'green' },
  g2: { pass: 'draft_mr', fail: 'green', maxLoops: 3 },
  draft_mr: { pass: 'end' },
};

const byId = new Map(STAGES.map((s) => [s.id, s]));

export function getStage(id: string): StageDef {
  const s = byId.get(id);
  if (!s) throw new Error(`Unknown stage: ${id}`);
  return s;
}

export function stageIndex(id: string): number {
  return STAGES.findIndex((s) => s.id === id);
}

/** Key used to count how often a fail edge was taken, e.g. "red_check->red". */
export function failEdgeKey(stageId: string): string | null {
  const t = TRANSITIONS[stageId];
  return t?.fail ? `${stageId}->${t.fail}` : null;
}

export type NextStep =
  | { kind: 'goto'; stage: string; loopEdge?: string; exhausted?: boolean; max?: number }
  | { kind: 'blocked'; reason: string; exhausted?: boolean };

export function resolveNext(stageId: string, outcome: 'pass' | 'fail', loopsUsed: number): NextStep {
  const t = TRANSITIONS[stageId];
  if (!t) throw new Error(`No transition for stage: ${stageId}`);
  if (outcome === 'pass') return { kind: 'goto', stage: t.pass };
  if (!t.fail) return { kind: 'blocked', reason: `Stage "${stageId}" failed and has no retry path` };
  const max = t.maxLoops ?? DEFAULT_MAX_LOOPS;
  if (loopsUsed >= max) {
    if (t.onExhausted && t.onExhausted !== 'block') {
      return { kind: 'goto', stage: t.onExhausted.goto, exhausted: true, max };
    }
    return {
      kind: 'blocked',
      reason: `Loop limit reached: "${stageId}" failed ${loopsUsed} times (max ${max}). A human needs to look at it.`,
      exhausted: true,
    };
  }
  return { kind: 'goto', stage: t.fail, loopEdge: `${stageId}->${t.fail}`, max };
}

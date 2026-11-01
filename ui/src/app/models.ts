export type RunStatus = 'running' | 'awaiting_gate' | 'blocked' | 'completed' | 'failed' | 'cancelled';
export type WorkType = 'auto' | 'feature' | 'bug' | 'change';
export type StageStatus = 'done' | 'current' | 'waiting' | 'blocked' | 'pending';

export interface RunRow {
  id: string; ticket: string; work_type: WorkType; title: string | null; base_branch: string; project: string; repo: string;
  workspace: string; branch: string; status: RunStatus; current_stage: string; blocked_reason: string | null; mr_url: string | null;
  created_by: string; created_at: string; updated_at: string;
}
export interface StageView {
  id: string; n: string; label: string; kind: 'agent' | 'script' | 'gate' | 'end'; phase: string;
  status: StageStatus; passes: number; fails: number; tokens: number;
}
export interface Metrics {
  llmCalls: number; toolCalls: number; mcpCalls: number; scriptRuns: number; tokensIn: number; tokensOut: number;
  costUsd: number; loops: number; limitBreaches: number;
}
export interface GateRow { id: number; run_id: string; gate: string; status: string; decided_by: string | null; comment: string | null; created_at: string; decided_at: string | null }
export interface RunView { run: RunRow; stages: StageView[]; metrics: Metrics; gates: GateRow[]; pendingGate: GateRow | null; loops: { edge: string; count: number }[] }
export interface TraceEvent { id: number; runId: string; ts: string; type: string; stage: string | null; data: Record<string, any> }
export interface Check { group: string; name: string; status: 'ok' | 'warn' | 'fail'; detail: string; fix?: string }
export interface Health { ok: boolean; runner: string; mcpServers: string[]; vision: boolean; mutationThreshold: number; budgets: { perStageTokens: number; perRunTokens: number } }
export interface Repo { name: string; project: string; baseBranch: string }

export const PHASE: Record<string, { label: string; color: string }> = {
  define: { label: 'Define', color: 'var(--c-define)' },
  red: { label: 'RED', color: 'var(--c-red)' },
  green: { label: 'GREEN', color: 'var(--c-green)' },
  refactor: { label: 'REFACTOR', color: 'var(--c-refactor)' },
  mutate: { label: 'Mutate', color: 'var(--c-mutate)' },
  verify: { label: 'Verify', color: 'var(--c-verify)' },
  deliver: { label: 'Deliver', color: 'var(--c-deliver)' },
  gate: { label: 'Human gate', color: 'var(--c-gate)' },
  end: { label: 'End', color: 'var(--c-gate)' },
};

export const WORK_TYPE_LABEL: Record<string, string> = { auto: 'Auto', feature: 'New requirement', bug: 'Bug fix', change: 'Change request' };

export const STATUS_LABEL: Record<RunStatus, string> = {
  running: 'Running', awaiting_gate: 'Needs your approval', blocked: 'Blocked', completed: 'Draft MR created', failed: 'Failed', cancelled: 'Cancelled',
};

export const GATE_ARTIFACTS: Record<string, string[]> = {
  G1: ['ticket.md', 'spec.md', 'plan.md', 'test-plan.md', 'confluence.md'],
  G2: ['review.md', 'survivors.md', 'mutation-report.json', 'quality-report.json', 'reconcile.md', 'red-notes.md', 'green-notes.md'],
};

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}
export function fmtMs(ms: number): string {
  return ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`;
}
export function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export interface EventLine { icon: string; kind: 'llm' | 'mcp' | 'script' | 'gate' | 'git' | 'warn' | 'flow' | 'index'; text: string; bad?: boolean }

/** One readable line per trace event. */
export function describe(e: TraceEvent): EventLine {
  const d = e.data;
  switch (e.type) {
    case 'run_started': return { icon: '▶', kind: 'flow', text: `Run started on ${d['branch']} (base ${d['baseBranch']}) by ${d['by']}` };
    case 'run_completed': return { icon: '✓', kind: 'flow', text: 'Run completed. Draft merge request created.' };
    case 'run_blocked': return { icon: '■', kind: 'flow', text: `Blocked: ${d['reason']}`, bad: true };
    case 'run_failed': return { icon: '✕', kind: 'flow', text: `Failed: ${d['error']}`, bad: true };
    case 'run_cancelled': return { icon: '■', kind: 'flow', text: `Cancelled by ${d['by']}` };
    case 'run_retry': return { icon: '↻', kind: 'flow', text: `Retried by ${d['by']}` };
    case 'worktype_set': return { icon: '◆', kind: 'flow', text: `Work type: ${WORK_TYPE_LABEL[d['workType']] ?? d['workType']} (Jira type: ${d['issueType'] ?? 'unknown'})` };
    case 'stage_enter': return { icon: '→', kind: 'flow', text: `Started${d['attempt'] > 1 ? ` (attempt ${d['attempt']})` : ''}` };
    case 'stage_exit': return { icon: d['outcome'] === 'pass' ? '✓' : '✕', kind: 'flow', text: `${d['outcome']} in ${fmtMs(d['durationMs'] ?? 0)}${d['summary'] ? `: ${d['summary']}` : ''}`, bad: d['outcome'] !== 'pass' };
    case 'stage_error': return { icon: '!', kind: 'warn', text: d['error'], bad: true };
    case 'llm_call': return { icon: '✦', kind: 'llm', text: `${d['runner']} · ${d['model']} · in ${fmtTokens(d['tokensIn'] ?? 0)} / out ${fmtTokens(d['tokensOut'] ?? 0)}${d['estimated'] ? ' (estimated)' : ''} · ${fmtMs(d['durationMs'] ?? 0)}${d['exitCode'] ? ` · exit ${d['exitCode']}` : ''}`, bad: Boolean(d['exitCode']) };
    case 'mcp_call': return { icon: '⇄', kind: 'mcp', text: `${d['server']} → ${d['mcpTool']} ${d['ok'] ? 'ok' : `failed: ${d['error']}`} · ${fmtMs(d['durationMs'] ?? 0)}`, bad: !d['ok'] };
    case 'mcp_denied': return { icon: '⛔', kind: 'mcp', text: `Denied: ${d['tool']} is not allowed in this stage`, bad: true };
    case 'script_run': return { icon: '⚙', kind: 'script', text: `${d['label']} · exit ${d['exitCode']} · ${fmtMs(d['durationMs'] ?? 0)}${d['timedOut'] ? ' · timed out' : ''}`, bad: d['exitCode'] !== 0 && !String(d['label']).startsWith('tests:') && !String(d['label']).startsWith('mutation:') };
    case 'gate_requested': return { icon: '✋', kind: 'gate', text: `${d['gate']} waiting for a person` };
    case 'gate_decided': return { icon: d['decision'] === 'approved' ? '✓' : '↩', kind: 'gate', text: `${d['gate']} ${d['decision']} by ${d['by']}${d['comment'] ? `: ${d['comment']}` : ''}` };
    case 'loop_used': return { icon: '↻', kind: 'flow', text: `Loop ${d['edge']} used ${d['count']} of ${d['max']}` };
    case 'limit_breach': return { icon: '⚠', kind: 'warn', text: `${d['kind']} limit: ${d['detail']}`, bad: true };
    case 'guard_violation': return { icon: '⛔', kind: 'warn', text: `Test files were edited and reverted: ${(d['files'] ?? []).join(', ')}`, bad: true };
    case 'result_missing': return { icon: '?', kind: 'warn', text: 'The agent wrote no result file' };
    case 'git_commit': return { icon: '●', kind: 'git', text: `Committed: ${d['message']}` };
    case 'git_push': return { icon: '↑', kind: 'git', text: `Pushed ${d['branch']}` };
    case 'mr_created': return { icon: '⎇', kind: 'git', text: `Draft merge request: ${d['url'] ?? d['title']}` };
    case 'index_built': return { icon: '☰', kind: 'index', text: `Code index: ${d['total']} files (${d['reparsed']} parsed, ${d['reused']} reused) in ${d['ms']} ms` };
    case 'attachments_saved': return { icon: '🖼', kind: 'flow', text: `Attachments: ${d['downloaded']} of ${d['total']} downloaded, ${d['images']} image(s)` };
    case 'warning': return { icon: '⚠', kind: 'warn', text: d['message'] + (d['files'] ? ` (${d['files'].join('; ')})` : ''), bad: true };
    default: return { icon: '·', kind: 'flow', text: e.type };
  }
}

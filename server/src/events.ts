import type { Store } from './db.js';

export type EventType =
  | 'run_started' | 'run_completed' | 'run_blocked' | 'run_cancelled' | 'run_failed' | 'run_retry'
  | 'stage_enter' | 'stage_exit' | 'stage_error'
  | 'llm_call' | 'tool_call' | 'mcp_call' | 'mcp_denied' | 'script_run'
  | 'gate_requested' | 'gate_decided'
  | 'loop_used' | 'limit_breach' | 'guard_violation' | 'result_missing'
  | 'git_commit' | 'git_push' | 'mr_created'
  | 'worktype_set' | 'attachments_saved' | 'index_built' | 'warning';

export interface TraceEvent {
  id: number;
  runId: string;
  ts: string;
  type: EventType;
  stage: string | null;
  data: Record<string, unknown>;
}

const SECRET_KEY = /(token|secret|password|passwd|authorization|api[-_]?key|cookie|credential)/i;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const KEY_VALUE = /((?:token|secret|password|passwd|api[-_]?key)\s*[=:]\s*)\S+/gi;
const MAX_STRING = 4000;

/** Masks secrets before anything is stored or sent to the UI. Tokens must never reach the event log. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth limit]';
  if (typeof value === 'string') {
    const cleaned = value.replace(BEARER, '$1 ***').replace(KEY_VALUE, '$1***');
    return cleaned.length > MAX_STRING ? `${cleaned.slice(0, MAX_STRING)}… [truncated ${cleaned.length - MAX_STRING} chars]` : cleaned;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Only text can be a secret. Numbers such as tokensIn and tokensOut must stay readable for metrics and budgets.
      out[k] = SECRET_KEY.test(k) && typeof v !== 'number' && typeof v !== 'boolean' ? '***' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

type Listener = (e: TraceEvent) => void;

/** Records every event in SQLite and fans it out to live subscribers (the SSE stream). */
export class Trace {
  private subs = new Map<string, Set<Listener>>();

  constructor(private store: Store) {}

  emit(runId: string, type: EventType, stage: string | null, data: Record<string, unknown> = {}): TraceEvent {
    const event = this.store.addEvent(runId, type, stage, redact(data) as Record<string, unknown>);
    for (const fn of this.subs.get(runId) ?? []) {
      try { fn(event); } catch { /* a broken listener must not break the run */ }
    }
    return event;
  }

  subscribe(runId: string, fn: Listener): () => void {
    let set = this.subs.get(runId);
    if (!set) { set = new Set(); this.subs.set(runId, set); }
    set.add(fn);
    return () => { set!.delete(fn); };
  }
}

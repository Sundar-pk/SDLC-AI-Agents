import { Injectable, computed, inject, signal } from '@angular/core';
import { ApiService } from './api.service';
import type { RunRow, RunView, TraceEvent } from './models';

/** Live state for the run list and the selected run: polling for the view, SSE for the trace. */
@Injectable({ providedIn: 'root' })
export class RunState {
  private api = inject(ApiService);
  readonly runs = signal<RunRow[]>([]);
  readonly selectedId = signal<string | null>(null);
  readonly view = signal<RunView | null>(null);
  readonly events = signal<TraceEvent[]>([]);
  readonly error = signal<string | null>(null);
  readonly live = signal(false);

  readonly tokensByStage = computed(() => {
    const m = new Map<string, { in: number; out: number; calls: number }>();
    for (const e of this.events()) {
      if (e.type !== 'llm_call' || !e.stage) continue;
      const cur = m.get(e.stage) ?? { in: 0, out: 0, calls: 0 };
      cur.in += e.data['tokensIn'] ?? 0; cur.out += e.data['tokensOut'] ?? 0; cur.calls++;
      m.set(e.stage, cur);
    }
    return [...m.entries()].map(([stage, v]) => ({ stage, ...v }));
  });
  readonly toolsHit = computed(() => {
    const m = new Map<string, { calls: number; failed: number; ms: number }>();
    for (const e of this.events()) {
      if (e.type !== 'mcp_call') continue;
      const key = `${e.data['server']} → ${e.data['mcpTool']}`;
      const cur = m.get(key) ?? { calls: 0, failed: 0, ms: 0 };
      cur.calls++; cur.ms += e.data['durationMs'] ?? 0; if (!e.data['ok']) cur.failed++;
      m.set(key, cur);
    }
    return [...m.entries()].map(([tool, v]) => ({ tool, calls: v.calls, failed: v.failed, avgMs: Math.round(v.ms / v.calls) }));
  });
  readonly scriptsHit = computed(() => {
    const m = new Map<string, { runs: number; failed: number }>();
    for (const e of this.events()) {
      if (e.type !== 'script_run') continue;
      const key = String(e.data['label']).split(':')[0]!;
      const cur = m.get(key) ?? { runs: 0, failed: 0 };
      cur.runs++; if (e.data['exitCode'] !== 0) cur.failed++;
      m.set(key, cur);
    }
    return [...m.entries()].map(([name, v]) => ({ name, ...v }));
  });
  readonly warnings = computed(() => this.events().filter((e) => e.type === 'warning' || e.type === 'limit_breach' || e.type === 'guard_violation'));

  private es: EventSource | null = null;
  private lastId = 0;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    void this.refreshRuns();
    setInterval(() => void this.refreshRuns(), 4000);
    setInterval(() => { const id = this.selectedId(); if (id) void this.refreshView(id); }, 4000);
  }

  async refreshRuns(): Promise<void> {
    try { this.runs.set(await this.api.runs()); this.error.set(null); }
    catch (e) { this.error.set(e instanceof Error ? e.message : String(e)); }
  }

  async refreshView(id: string): Promise<void> {
    try {
      const v = await this.api.run(id);
      if (this.selectedId() === id) this.view.set(v);
    } catch (e) { this.error.set(e instanceof Error ? e.message : String(e)); }
  }

  select(id: string | null): void {
    this.es?.close(); this.es = null;
    this.selectedId.set(id);
    this.view.set(null); this.events.set([]); this.lastId = 0; this.live.set(false);
    if (!id) return;
    void this.refreshView(id);
    const es = new EventSource(`/api/runs/${id}/stream`);
    this.es = es;
    es.onopen = () => this.live.set(true);
    es.onerror = () => this.live.set(false);
    let buffer: TraceEvent[] = [];
    let flush: ReturnType<typeof setTimeout> | null = null;
    es.addEventListener('trace', (m) => {
      const ev = JSON.parse((m as MessageEvent).data) as TraceEvent;
      if (ev.id <= this.lastId) return;
      this.lastId = ev.id;
      buffer.push(ev);
      flush ??= setTimeout(() => { // batch bursts (the replay on connect) into one update
        const batch = buffer; buffer = []; flush = null;
        this.events.update((all) => [...all, ...batch]);
      }, 60);
      if (!['llm_call', 'mcp_call', 'script_run', 'index_built'].includes(ev.type)) this.scheduleRefresh(id);
    });
  }

  private scheduleRefresh(id: string): void {
    this.refreshTimer ??= setTimeout(() => { this.refreshTimer = null; void this.refreshView(id); void this.refreshRuns(); }, 250);
  }

  async afterAction(view: RunView): Promise<void> {
    if (this.selectedId() === view.run.id) this.view.set(view);
    await this.refreshRuns();
  }
}

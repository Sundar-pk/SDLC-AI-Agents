import { ChangeDetectionStrategy, Component, computed, effect, ElementRef, inject, signal, viewChild } from '@angular/core';
import { ApiService } from './api.service';
import { ArtifactComponent } from './artifact-viewer.component';
import { GateReviewComponent } from './gate-review.component';
import { ago, describe, fmtMs, fmtTokens, STATUS_LABEL, WORK_TYPE_LABEL, type Health } from './models';
import { RunState } from './run-state.service';
import { TrackComponent } from './track.component';

type Tab = 'overview' | 'trace' | 'artifacts';
const FILTERS: { id: string; label: string; kinds: string[] }[] = [
  { id: 'all', label: 'Everything', kinds: [] },
  { id: 'flow', label: 'Stages', kinds: ['flow', 'gate'] },
  { id: 'llm', label: 'LLM calls', kinds: ['llm'] },
  { id: 'mcp', label: 'Jira / Bitbucket', kinds: ['mcp'] },
  { id: 'script', label: 'Scripts', kinds: ['script'] },
  { id: 'git', label: 'Git', kinds: ['git'] },
  { id: 'index', label: 'Code index', kinds: ['index'] },
  { id: 'warn', label: 'Problems', kinds: ['warn'] },
];

@Component({
  selector: 'app-run-view',
  standalone: true,
  imports: [TrackComponent, GateReviewComponent, ArtifactComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (state.view(); as v) {
      <header class="head">
        <div>
          <div class="titleline">
            <h2>{{ v.run.ticket }}</h2>
            <span class="chip wt" [class]="v.run.work_type">{{ wt(v.run.work_type) }}</span>
            <span class="chip st" [class]="v.run.status">{{ status(v.run.status) }}</span>
          </div>
          <p class="sub">{{ v.run.title ?? 'Reading the ticket…' }}</p>
          <p class="meta">{{ v.run.repo }} · <code>{{ v.run.branch }}</code> → {{ v.run.base_branch }} · started {{ ago(v.run.created_at) }} by {{ v.run.created_by }}
            · <span class="live" [class.on]="state.live()">{{ state.live() ? 'live' : 'reconnecting' }}</span></p>
        </div>
        <div class="actions">
          @if (v.run.status === 'running' || v.run.status === 'awaiting_gate' || v.run.status === 'blocked') { <button class="btn" (click)="cancel()">Cancel run</button> }
          @if (v.run.status === 'blocked' || v.run.status === 'failed') { <button class="btn primary" (click)="retry()">Retry</button> }
        </div>
      </header>

      <section class="card trackcard"><app-track [stages]="v.stages" /></section>

      @if (v.run.status === 'completed' && v.run.mr_url) {
        <section class="banner ok"><b>Draft merge request created.</b> The run has ended. Review and merge in Bitbucket. <a [href]="v.run.mr_url" target="_blank" rel="noopener">Open merge request ↗</a></section>
      }
      @if (v.run.status === 'blocked' || v.run.status === 'failed') {
        <section class="banner bad"><b>{{ v.run.status === 'failed' ? 'The run failed.' : 'The run is blocked.' }}</b> {{ v.run.blocked_reason }}</section>
      }
      @if (v.pendingGate && v.run.status === 'awaiting_gate') {
        <app-gate-review [view]="v" [events]="state.events()" (decided)="onDecided($event)" />
      }

      <nav class="tabs" role="tablist">
        @for (t of tabs; track t.id) { <button role="tab" [attr.aria-selected]="tab() === t.id" [class.on]="tab() === t.id" (click)="tab.set(t.id)">{{ t.label }}@if (t.id === 'trace') { <span class="count">{{ state.events().length }}</span> }</button> }
      </nav>

      @switch (tab()) {
        @case ('overview') {
          <div class="tiles">
            <div class="tile"><b>{{ v.metrics.llmCalls }}</b><span>LLM calls</span></div>
            <div class="tile"><b>{{ tok(v.metrics.tokensIn + v.metrics.tokensOut) }}</b><span>tokens ({{ tok(v.metrics.tokensIn) }} in · {{ tok(v.metrics.tokensOut) }} out)</span>
              @if (health()?.budgets; as b) { <i class="bar"><u [style.width.%]="pct(v.metrics.tokensIn + v.metrics.tokensOut, b.perRunTokens)"></u></i><small>of {{ tok(b.perRunTokens) }} budget</small> }</div>
            <div class="tile"><b>{{ v.metrics.mcpCalls }}</b><span>Jira / Bitbucket calls</span></div>
            <div class="tile"><b>{{ v.metrics.scriptRuns }}</b><span>script runs (no LLM)</span></div>
            <div class="tile" [class.warn]="v.metrics.loops > 0"><b>{{ v.metrics.loops }}</b><span>loops back</span></div>
            <div class="tile" [class.bad]="v.metrics.limitBreaches > 0"><b>{{ v.metrics.limitBreaches }}</b><span>limit breaches</span></div>
          </div>
          <div class="grid2">
            <section class="card"><h3>Tokens by stage</h3>
              @if (state.tokensByStage().length) {
                @for (r of state.tokensByStage(); track r.stage) {
                  <div class="barrow"><span class="nm">{{ r.stage }}</span><i class="bar wide"><u [style.width.%]="pct(r.in + r.out, maxStage())"></u></i><span class="num">{{ tok(r.in + r.out) }}</span><small>{{ r.calls }}×</small></div>
                }
              } @else { <p class="muted">No LLM call yet.</p> }
            </section>
            <section class="card"><h3>What was hit</h3>
              <h4>Jira / Confluence / Bitbucket (via MCP)</h4>
              @for (t of state.toolsHit(); track t.tool) { <div class="hit"><span>{{ t.tool }}</span><span class="num">{{ t.calls }}×</span><span class="muted">{{ t.avgMs }} ms</span>@if (t.failed) { <span class="bad">{{ t.failed }} failed</span> }</div> }
              @empty { <p class="muted">None yet.</p> }
              <h4>Scripts (no LLM)</h4>
              @for (s of state.scriptsHit(); track s.name) { <div class="hit"><span>{{ s.name }}</span><span class="num">{{ s.runs }}×</span>@if (s.failed) { <span class="muted">{{ s.failed }} non-zero exit</span> }</div> }
              @empty { <p class="muted">None yet.</p> }
              @if (v.loops.length) { <h4>Loops used</h4>@for (l of v.loops; track l.edge) { <div class="hit"><span>{{ l.edge }}</span><span class="num">{{ l.count }}</span></div> } }
            </section>
          </div>
          @if (state.warnings().length) {
            <section class="card"><h3>Warnings and limits</h3>@for (w of state.warnings(); track w.id) { <div class="line bad"><span class="t">{{ time(w.ts) }}</span><span class="ic">{{ line(w).icon }}</span><span>{{ line(w).text }}</span></div> }</section>
          }
          @if (v.gates.length) {
            <section class="card"><h3>Human decisions</h3>@for (g of v.gates; track g.id) { <div class="hit"><span><b>{{ g.gate }}</b> {{ g.status }}</span><span class="muted">{{ g.decided_by ?? 'waiting' }}</span><span class="muted">{{ g.comment }}</span></div> }</section>
          }
        }
        @case ('trace') {
          <div class="filters">@for (f of filters; track f.id) { <button class="fchip" [class.on]="filter() === f.id" (click)="filter.set(f.id)">{{ f.label }}</button> }
            <label class="follow"><input type="checkbox" [checked]="follow()" (change)="follow.set($any($event.target).checked)" /> follow</label></div>
          <section class="card log" #log>
            @for (e of shown(); track e.id) {
              <div class="line" [class.bad]="line(e).bad">
                <span class="t">{{ time(e.ts) }}</span>
                <span class="stg">{{ e.stage ?? '' }}</span>
                <span class="ic k-{{ line(e).kind }}">{{ line(e).icon }}</span>
                <span class="tx">{{ line(e).text }}</span>
              </div>
            } @empty { <p class="muted">Nothing here yet.</p> }
          </section>
        }
        @case ('artifacts') {
          <div class="split">
            <ul class="files">@for (a of files(); track a.name) { <li><button [class.on]="a.name === pick()" (click)="pick.set(a.name)">{{ a.name }} <small>{{ a.bytes > 1024 ? (a.bytes / 1024).toFixed(0) + ' KB' : a.bytes + ' B' }}</small></button></li> } @empty { <li class="muted">No files yet.</li> }</ul>
            <section class="card viewer">@if (pick()) { <app-artifact [runId]="v.run.id" [name]="pick()" [version]="files().length" /> } @else { <p class="muted">Pick a file.</p> }</section>
          </div>
        }
      }
    } @else if (state.selectedId()) {
      @if (state.error(); as err) { <p class="bad pad">Could not load this run: {{ err }}</p> } @else { <p class="muted pad">Loading run…</p> }
    }
    @else { <div class="empty"><h2>No run selected</h2><p>Pick a run on the left, or start a new one.</p></div> }
  `,
  styleUrl: './run-view.component.css',
})
export class RunViewComponent {
  readonly state = inject(RunState);
  private api = inject(ApiService);
  readonly tabs: { id: Tab; label: string }[] = [{ id: 'overview', label: 'Overview' }, { id: 'trace', label: 'Trace' }, { id: 'artifacts', label: 'Files' }];
  readonly filters = FILTERS;
  readonly tab = signal<Tab>('overview');
  readonly filter = signal('all');
  readonly follow = signal(true);
  readonly health = signal<Health | null>(null);
  readonly files = signal<{ name: string; bytes: number }[]>([]);
  readonly pick = signal('');
  private logEl = viewChild<ElementRef<HTMLElement>>('log');

  readonly shown = computed(() => {
    const kinds = FILTERS.find((f) => f.id === this.filter())?.kinds ?? [];
    const all = this.state.events();
    return kinds.length ? all.filter((e) => kinds.includes(describe(e).kind)) : all;
  });
  readonly maxStage = computed(() => Math.max(1, ...this.state.tokensByStage().map((r) => r.in + r.out)));

  ago = ago;
  tok = fmtTokens;
  line = describe;
  wt = (w: string) => WORK_TYPE_LABEL[w] ?? w;
  status = (s: keyof typeof STATUS_LABEL) => STATUS_LABEL[s];
  pct = (n: number, of: number) => Math.min(100, (n / Math.max(1, of)) * 100);
  time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour12: false });
  fmtMs = fmtMs;

  constructor() {
    void this.api.health().then((h) => this.health.set(h)).catch(() => {});
    effect(() => {
      const id = this.state.selectedId(); this.state.view()?.run.updated_at;
      if (id && this.tab() === 'artifacts') void this.api.artifacts(id).then((f) => { this.files.set(f); if (!this.pick() && f[0]) this.pick.set(f[0].name); });
    }, { allowSignalWrites: true });
    effect(() => {
      this.shown();
      const el = this.logEl()?.nativeElement;
      if (el && this.follow()) queueMicrotask(() => { el.scrollTop = el.scrollHeight; });
    });
  }

  async cancel(): Promise<void> {
    const id = this.state.selectedId();
    if (id && confirm('Cancel this run? The work done so far stays on the branch.')) await this.state.afterAction(await this.api.cancel(id));
  }
  async retry(): Promise<void> {
    const id = this.state.selectedId();
    if (id) await this.state.afterAction(await this.api.retry(id));
  }
  onDecided(v: Parameters<RunState['afterAction']>[0]): void { void this.state.afterAction(v); }
}

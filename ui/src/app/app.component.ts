import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { NewRunComponent } from './new-run.component';
import { ago, STATUS_LABEL, WORK_TYPE_LABEL, type RunRow } from './models';
import { RunState } from './run-state.service';
import { RunViewComponent } from './run-view.component';
import { SetupComponent } from './setup.component';

type Page = 'runs' | 'new' | 'setup';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RunViewComponent, NewRunComponent, SetupComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="top">
      <div class="brand"><span class="mark"></span><b>2S IT</b> <span>SDLC agents</span></div>
      <nav>
        <button [class.on]="page() === 'runs'" (click)="page.set('runs')">Runs</button>
        <button [class.on]="page() === 'setup'" (click)="page.set('setup')">Setup check</button>
      </nav>
      <button class="btn primary" (click)="page.set('new')">+ New run</button>
    </header>
    <div class="shell">
      @if (page() === 'runs') {
        <aside class="rail" aria-label="Runs">
          @for (r of state.runs(); track r.id) {
            <button class="item" [class.on]="r.id === state.selectedId()" (click)="open(r.id)">
              <span class="dot" [class]="r.status" [title]="status(r.status)"></span>
              <span class="body"><b>{{ r.ticket }}</b> <small class="wt {{ r.work_type }}">{{ wt(r.work_type) }}</small>
                <span class="t">{{ r.title ?? r.repo }}</span><span class="m">{{ status(r.status) }} · {{ ago(r.updated_at) }}</span></span>
            </button>
          } @empty { <p class="muted pad">No runs yet. Start one with “New run”.</p> }
          @if (state.error()) { <p class="err pad">Cannot reach the service: {{ state.error() }}</p> }
        </aside>
        <main><app-run-view /></main>
      } @else if (page() === 'new') {
        <main class="solo"><app-new-run (started)="open($event)" /></main>
      } @else {
        <main class="solo wide"><app-setup /></main>
      }
    </div>
  `,
  styles: [`
    .top { display: flex; align-items: center; gap: 24px; padding: 12px 24px; border-bottom: 1px solid var(--line); background: var(--surface); position: sticky; top: 0; z-index: 5; }
    .brand { display: flex; align-items: center; gap: 8px; font-size: 15px; } .brand span:last-child { color: var(--muted); }
    .mark { width: 22px; height: 22px; border-radius: 7px; background: conic-gradient(var(--c-red), var(--c-green), var(--c-refactor), var(--c-mutate), var(--c-red)); }
    nav { display: flex; gap: 4px; flex: 1; } nav button { background: none; border: 0; padding: 7px 12px; border-radius: 8px; cursor: pointer; color: var(--muted); font: inherit; font-weight: 500; }
    nav button.on { background: var(--sunken); color: var(--ink); font-weight: 700; }
    .shell { display: grid; grid-template-columns: auto 1fr; min-height: calc(100vh - 58px); }
    .rail { width: 310px; border-right: 1px solid var(--line); padding: 10px; overflow: auto; max-height: calc(100vh - 58px); position: sticky; top: 58px; }
    .item { display: flex; gap: 10px; width: 100%; text-align: left; padding: 10px; border: 1px solid transparent; border-radius: 10px; background: none; cursor: pointer; font: inherit; color: var(--ink); }
    .item:hover { background: var(--sunken); } .item.on { background: var(--surface); border-color: var(--line-strong); box-shadow: var(--shadow); }
    .dot { width: 10px; height: 10px; border-radius: 50%; margin-top: 6px; flex: none; background: var(--faint); }
    .dot.running { background: var(--c-refactor); animation: blink 1.4s infinite; } .dot.awaiting_gate { background: var(--c-verify); animation: blink 1.4s infinite; }
    .dot.completed { background: var(--c-green); } .dot.blocked, .dot.failed { background: var(--c-red); }
    .body { display: grid; gap: 1px; min-width: 0; } .body .t { color: var(--ink); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .body .m { color: var(--muted); font-size: 11.5px; }
    .wt { font-size: 10.5px; padding: 1px 7px; border-radius: 999px; background: var(--sunken); color: var(--muted); font-weight: 600; margin-left: 4px; }
    .wt.bug { background: var(--c-red-soft); color: var(--c-red); } .wt.change { background: var(--c-mutate-soft); color: var(--c-mutate); } .wt.feature { background: var(--c-define-soft); color: var(--c-define); }
    main { padding: 22px 28px 60px; min-width: 0; } main.solo { grid-column: 1 / -1; max-width: 760px; margin: 0 auto; width: 100%; box-sizing: border-box; } main.solo.wide { max-width: 920px; }
    .muted { color: var(--muted); } .err { color: var(--c-red); } .pad { padding: 12px; }
    @keyframes blink { 50% { opacity: .35; } } @media (prefers-reduced-motion: reduce) { .dot { animation: none !important; } }
    @media (max-width: 860px) { .shell { grid-template-columns: 1fr; } .rail { width: auto; position: static; max-height: 240px; border-right: 0; border-bottom: 1px solid var(--line); } main { padding: 16px; } .top { padding: 10px 14px; gap: 10px; } .brand span:last-child { display: none; } }
  `],
})
export class AppComponent {
  readonly state = inject(RunState);
  readonly page = signal<Page>('runs');
  ago = ago;
  wt = (w: string) => WORK_TYPE_LABEL[w] ?? w;
  status = (s: RunRow['status']) => STATUS_LABEL[s];

  constructor() {
    const hash = location.hash.slice(1);
    if (hash) this.state.select(hash);
  }
  open(id: string): void {
    this.page.set('runs');
    this.state.select(id);
    try { history.replaceState(null, '', `#${id}`); } catch { /* ignore */ }
    void this.state.refreshRuns();
  }
}

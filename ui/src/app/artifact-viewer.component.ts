import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { ApiService } from './api.service';
import { renderMarkdown } from './markdown';

interface Quality { pass: boolean; checks: { name: string; ok: boolean; detail?: string }[]; mutation?: { score: number; threshold: number; baseline?: number } }
interface Mutation { score: number; total: number; threshold: number; killed?: number; survived?: number; noCoverage?: number; skipped?: boolean; survivors: { file: string; line: number; mutator: string; description: string }[]; survivorsOmitted?: number }

@Component({
  selector: 'app-artifact',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (loading()) { <p class="muted">Loading…</p> }
    @else if (text() === null) { <p class="muted">{{ name() }} has not been written yet.</p> }
    @else if (name().endsWith('.md')) { <article class="md" [innerHTML]="html()"></article> }
    @else if (mutation()) {
      @let m = mutation()!;
      <div class="stats">
        <div class="stat" [class.ok]="m.score >= m.threshold" [class.bad]="m.score < m.threshold"><b>{{ m.score }}%</b><span>mutation score (needs {{ m.threshold }}%)</span></div>
        <div class="stat"><b>{{ m.total }}</b><span>mutants</span></div>
        <div class="stat" [class.bad]="(m.survived ?? 0) > 0"><b>{{ m.survived ?? 0 }}</b><span>survived</span></div>
        <div class="stat"><b>{{ m.noCoverage ?? 0 }}</b><span>no coverage</span></div>
      </div>
      @if (m.skipped) { <p class="muted">Skipped: no production logic changed.</p> }
      @if (m.survivors.length) {
        <div class="tbl"><table>
          <thead><tr><th>File</th><th>Line</th><th>Change the tool made</th></tr></thead>
          <tbody>@for (s of m.survivors; track $index) { <tr><td><code>{{ s.file }}</code></td><td>{{ s.line }}</td><td>{{ s.description }}</td></tr> }</tbody>
        </table></div>
        @if (m.survivorsOmitted) { <p class="muted">+ {{ m.survivorsOmitted }} more not shown</p> }
      }
    }
    @else if (quality()) {
      @let q = quality()!;
      <div class="stats"><div class="stat" [class.ok]="q.pass" [class.bad]="!q.pass"><b>{{ q.pass ? 'Passed' : 'Failed' }}</b><span>quality gate</span></div></div>
      <ul class="checks">@for (c of q.checks; track c.name) { <li [class.bad]="!c.ok"><span>{{ c.ok ? '✓' : '✕' }}</span> <b>{{ c.name }}</b> @if (c.detail) { <small>{{ c.detail }}</small> }</li> }</ul>
    }
    @else { <pre>{{ text() }}</pre> }
  `,
  styles: [`
    .muted { color: var(--muted); }
    pre { background: var(--sunken); padding: 12px; border-radius: 8px; overflow: auto; max-height: 420px; font-size: 12px; }
    .stats { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
    .stat { background: var(--sunken); border-radius: 10px; padding: 10px 14px; min-width: 110px; }
    .stat b { display: block; font-size: 20px; font-variant-numeric: tabular-nums; }
    .stat span { font-size: 11px; color: var(--muted); }
    .stat.ok b { color: var(--c-green-ink); } .stat.bad b { color: var(--c-red); }
    .checks { list-style: none; padding: 0; margin: 0; display: grid; gap: 6px; }
    .checks li { display: flex; gap: 8px; align-items: baseline; } .checks li.bad { color: var(--c-red); }
    .checks small { color: var(--muted); white-space: pre-wrap; }
  `],
})
export class ArtifactComponent {
  private api = inject(ApiService);
  readonly runId = input.required<string>();
  readonly name = input.required<string>();
  /** Bump to reload while the file is being written. */
  readonly version = input(0);
  readonly text = signal<string | null>(null);
  readonly loading = signal(true);
  readonly html = computed(() => (this.text() ? renderMarkdown(this.text()!) : ''));
  readonly mutation = computed<Mutation | null>(() => (this.name() === 'mutation-report.json' ? this.parse<Mutation>() : null));
  readonly quality = computed<Quality | null>(() => (this.name() === 'quality-report.json' ? this.parse<Quality>() : null));

  constructor() {
    effect(() => {
      const id = this.runId(); const name = this.name(); this.version();
      this.loading.set(true);
      void this.api.artifact(id, name).then((t) => {
        if (id === this.runId() && name === this.name()) { this.text.set(t); this.loading.set(false); }
      });
    }, { allowSignalWrites: true });
  }

  private parse<T>(): T | null {
    try { return this.text() ? (JSON.parse(this.text()!) as T) : null; } catch { return null; }
  }
}

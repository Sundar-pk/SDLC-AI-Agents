import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { ApiService } from './api.service';
import { ArtifactComponent } from './artifact-viewer.component';
import { GATE_ARTIFACTS, type RunView, type TraceEvent } from './models';

const GATE_TEXT: Record<string, { title: string; ask: string; approve: string }> = {
  G1: { title: 'Gate 1 · Approve the spec and test strategy', ask: 'Read the spec and the test plan. Approving lets the agents write the failing tests and then the code.', approve: 'Approve strategy' },
  G2: { title: 'Gate 2 · Approve the code', ask: 'Read the review, the remaining mutation survivors and the quality gate. Approving opens the draft merge request.', approve: 'Approve and open draft MR' },
};

@Component({
  selector: 'app-gate-review',
  standalone: true,
  imports: [ArtifactComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="gate card">
      <div class="gate-head">
        <span class="hand">✋</span>
        <div><h3>{{ text().title }}</h3><p>{{ text().ask }}</p></div>
      </div>

      @for (w of warnings(); track w.id) { <div class="warn">⚠ {{ w.data['message'] ?? w.data['detail'] }}</div> }

      @if (images().length) {
        <h4>Mock-ups from the ticket</h4>
        <div class="thumbs">@for (f of images(); track f) { <a [href]="url(f)" target="_blank" rel="noopener"><img [src]="url(f)" [alt]="f" loading="lazy" /></a> }</div>
      }

      <div class="tabs" role="tablist">
        @for (a of docs(); track a) { <button role="tab" [attr.aria-selected]="a === tab()" [class.on]="a === tab()" (click)="tab.set(a)">{{ label(a) }}</button> }
      </div>
      <div class="doc"><app-artifact [runId]="view().run.id" [name]="tab()" /></div>

      <label class="lbl" for="c">Comment @if (!canApprove) { <em>(required when requesting changes)</em> }</label>
      <textarea id="c" rows="3" [value]="comment()" (input)="comment.set($any($event.target).value)" placeholder="What should the agents change? Be specific. This text is given to them."></textarea>
      @if (error()) { <p class="err">{{ error() }}</p> }
      <div class="row">
        <button class="btn primary" [disabled]="busy()" (click)="decide('approved')">{{ text().approve }}</button>
        <button class="btn" [disabled]="busy() || !comment().trim()" (click)="decide('rejected')">Request changes</button>
      </div>
    </section>
  `,
  styles: [`
    .gate { border: 2px solid var(--c-verify); background: linear-gradient(180deg, var(--c-verify-soft), var(--surface) 90px); }
    .gate-head { display: flex; gap: 14px; align-items: flex-start; }
    .hand { font-size: 26px; line-height: 1; }
    h3 { margin: 0 0 2px; font-size: 17px; } p { margin: 0; color: var(--muted); }
    h4 { margin: 16px 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
    .warn { margin-top: 12px; padding: 8px 12px; border-radius: 8px; background: var(--c-verify-soft); color: var(--c-verify-ink); font-size: 13px; }
    .thumbs { display: flex; gap: 10px; flex-wrap: wrap; }
    .thumbs img { height: 120px; border-radius: 8px; border: 1px solid var(--line); display: block; background: var(--sunken); }
    .tabs { display: flex; gap: 4px; flex-wrap: wrap; margin: 16px 0 0; border-bottom: 1px solid var(--line); }
    .tabs button { background: none; border: 0; padding: 8px 12px; cursor: pointer; color: var(--muted); border-bottom: 2px solid transparent; font: inherit; font-size: 13px; }
    .tabs button.on { color: var(--ink); border-bottom-color: var(--c-define); font-weight: 600; }
    .doc { padding: 14px 4px; max-height: 480px; overflow: auto; }
    .lbl { display: block; font-size: 13px; font-weight: 600; margin: 8px 0 6px; } .lbl em { font-weight: 400; color: var(--muted); }
    textarea { width: 100%; box-sizing: border-box; padding: 10px; border-radius: 8px; border: 1px solid var(--line-strong); background: var(--surface); color: var(--ink); font: inherit; resize: vertical; }
    .row { display: flex; gap: 10px; margin-top: 12px; flex-wrap: wrap; } .err { color: var(--c-red); margin-top: 8px; }
  `],
})
export class GateReviewComponent {
  private api = inject(ApiService);
  readonly view = input.required<RunView>();
  readonly events = input.required<TraceEvent[]>();
  readonly decided = output<RunView>();

  readonly tab = signal('spec.md');
  readonly comment = signal('');
  readonly busy = signal(false);
  readonly error = signal('');
  readonly files = signal<{ name: string }[]>([]);
  readonly imageFiles = signal<string[]>([]);

  readonly gate = computed(() => this.view().pendingGate?.gate ?? 'G1');
  readonly text = computed(() => GATE_TEXT[this.gate()] ?? GATE_TEXT['G1']!);
  readonly docs = computed(() => { const have = new Set(this.files().map((f) => f.name)); const list = (GATE_ARTIFACTS[this.gate()] ?? []).filter((n) => have.has(n)); return list.length ? list : (GATE_ARTIFACTS[this.gate()] ?? []).slice(0, 2); });
  readonly images = computed(() => (this.gate() === 'G1' ? this.imageFiles() : []));
  readonly warnings = computed(() => this.events().filter((e) => e.type === 'warning').slice(-3));
  get canApprove(): boolean { return true; }

  constructor() {
    effect(() => {
      const id = this.view().run.id; const g = this.gate();
      void this.api.artifacts(id).then((a) => {
        this.files.set(a);
        const first = (GATE_ARTIFACTS[g] ?? []).find((n) => a.some((x) => x.name === n));
        if (first) this.tab.set(first);
      });
      void this.api.artifact(id, 'attachments.json').then((t) => {
        try {
          const list = JSON.parse(t ?? '[]') as { kind: string; file?: string }[];
          this.imageFiles.set(list.filter((x) => x.kind === 'image' && x.file).map((x) => x.file!.split('/').pop()!));
        } catch { this.imageFiles.set([]); }
      });
    }, { allowSignalWrites: true });
  }

  label(n: string): string { return n.replace(/\.(md|json)$/, '').replace(/-/g, ' '); }
  url(f: string): string { return this.api.attachmentUrl(this.view().run.id, f); }

  async decide(decision: 'approved' | 'rejected'): Promise<void> {
    this.busy.set(true); this.error.set('');
    try {
      const v = await this.api.decide(this.view().run.id, this.gate(), decision, this.comment().trim() || undefined);
      this.comment.set('');
      this.decided.emit(v);
    } catch (e) { this.error.set(e instanceof Error ? e.message : String(e)); }
    finally { this.busy.set(false); }
  }
}

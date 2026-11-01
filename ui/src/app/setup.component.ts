import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ApiService } from './api.service';
import type { Check } from './models';

@Component({
  selector: 'app-setup',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="head">
      <div><h2>Setup check</h2><p class="muted">Checks the config, the agent tool, git access, both MCP servers, and that every tool name and argument matches the real server.</p></div>
      <button class="btn" [disabled]="busy()" (click)="load(true)">{{ busy() ? 'Checking…' : 'Check again' }}</button>
    </div>
    @if (summary(); as s) {
      <div class="sum"><span class="ok">{{ s.ok }} ok</span><span class="warn">{{ s.warn }} warnings</span><span class="fail">{{ s.fail }} failed</span></div>
    }
    @for (g of groups(); track g.name) {
      <section class="card"><h3>{{ g.name }}</h3>
        @for (c of g.items; track c.name) {
          <div class="row" [class]="c.status"><span class="ic">{{ c.status === 'ok' ? '✓' : c.status === 'warn' ? '!' : '✕' }}</span>
            <div><b>{{ c.name }}</b><span class="d">{{ c.detail }}</span>@if (c.fix && c.status !== 'ok') { <div class="fix">→ {{ c.fix }}</div> }</div></div>
        }
      </section>
    }
    @if (error()) { <p class="err">{{ error() }}</p> }
  `,
  styles: [`
    .head { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; flex-wrap: wrap; } h2 { margin: 0; } .muted { color: var(--muted); margin: 4px 0 12px; max-width: 640px; }
    .sum { display: flex; gap: 14px; margin: 4px 0 14px; font-weight: 600; } .ok { color: var(--c-green-ink); } .warn { color: var(--c-verify-ink); } .fail, .err { color: var(--c-red); }
    section { margin-bottom: 12px; } h3 { margin: 0 0 8px; font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
    .row { display: flex; gap: 12px; padding: 7px 0; border-bottom: 1px solid var(--line); } .row:last-child { border: 0; }
    .ic { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; font-size: 12px; font-weight: 700; flex: none; color: #fff; }
    .row.ok .ic { background: var(--c-green); } .row.warn .ic { background: var(--c-verify); } .row.fail .ic { background: var(--c-red); }
    .d { display: block; color: var(--muted); font-size: 13px; word-break: break-word; } .fix { font-size: 12.5px; color: var(--ink); margin-top: 2px; }
  `],
})
export class SetupComponent {
  private api = inject(ApiService);
  readonly checks = signal<Check[]>([]);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly groups = computed(() => {
    const m = new Map<string, Check[]>();
    for (const c of this.checks()) m.set(c.group, [...(m.get(c.group) ?? []), c]);
    return [...m.entries()].map(([name, items]) => ({ name, items }));
  });
  readonly summary = computed(() => {
    const c = this.checks();
    return c.length ? { ok: c.filter((x) => x.status === 'ok').length, warn: c.filter((x) => x.status === 'warn').length, fail: c.filter((x) => x.status === 'fail').length } : null;
  });
  constructor() { void this.load(false); }
  async load(refresh: boolean): Promise<void> {
    this.busy.set(true); this.error.set('');
    try { this.checks.set((await this.api.doctor(refresh)).checks); }
    catch (e) { this.error.set(e instanceof Error ? e.message : String(e)); }
    finally { this.busy.set(false); }
  }
}

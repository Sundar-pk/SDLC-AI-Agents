import { ChangeDetectionStrategy, Component, inject, output, signal } from '@angular/core';
import { ApiService } from './api.service';
import type { Repo, WorkType } from './models';

@Component({
  selector: 'app-new-run',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form class="card form" (submit)="submit($event)">
      <h2>Start a run</h2>
      <p class="muted">Give the Jira ticket and the repository. The agents read the ticket, its attachments and linked Confluence pages, then work test-first. They stop at the draft merge request.</p>

      <label for="t">Jira ticket</label>
      <input id="t" name="ticket" [value]="ticket()" (input)="ticket.set($any($event.target).value.toUpperCase())" placeholder="ABC-123" autocomplete="off" required />

      <label for="r">Repository</label>
      @if (repos().length) {
        <select id="r" [value]="repo()" (change)="repo.set($any($event.target).value)">
          @for (r of repos(); track r.name) { <option [value]="r.name">{{ r.name }} ({{ r.project }}, base {{ r.baseBranch }})</option> }
        </select>
      } @else { <p class="muted">No repositories are configured. Add them under "repos" in config/agents.config.json.</p> }

      <label for="w">Type of work</label>
      <select id="w" [value]="work()" (change)="work.set($any($event.target).value)">
        <option value="auto">Detect from the Jira issue type (recommended)</option>
        <option value="feature">New requirement</option>
        <option value="bug">Bug fix</option>
        <option value="change">Change request</option>
      </select>

      <label for="u">Your name (recorded with every decision)</label>
      <input id="u" [value]="api.user()" (input)="api.setUser($any($event.target).value)" placeholder="first.last" autocomplete="off" />

      @if (error()) { <p class="err" role="alert">{{ error() }}</p> }
      <button class="btn primary" [disabled]="busy() || !ticket() || !repo()">{{ busy() ? 'Starting…' : 'Start run' }}</button>
    </form>
  `,
  styles: [`
    .form { max-width: 560px; display: grid; gap: 8px; } h2 { margin: 0; } .muted { color: var(--muted); margin: 0 0 8px; }
    label { font-size: 12.5px; font-weight: 600; margin-top: 8px; }
    input, select { padding: 10px 12px; border-radius: 8px; border: 1px solid var(--line-strong); background: var(--surface); color: var(--ink); font: inherit; }
    .err { color: var(--c-red); margin: 4px 0; } button { margin-top: 12px; justify-self: start; }
  `],
})
export class NewRunComponent {
  readonly api = inject(ApiService);
  readonly started = output<string>();
  readonly repos = signal<Repo[]>([]);
  readonly ticket = signal('');
  readonly repo = signal('');
  readonly work = signal<WorkType>('auto');
  readonly busy = signal(false);
  readonly error = signal('');

  constructor() {
    void this.api.repos().then((r) => { this.repos.set(r); if (r[0]) this.repo.set(r[0].name); }).catch((e) => this.error.set(String(e.message ?? e)));
  }

  async submit(ev: Event): Promise<void> {
    ev.preventDefault();
    this.busy.set(true); this.error.set('');
    try {
      const v = await this.api.start({ ticket: this.ticket().trim(), repo: this.repo(), workType: this.work() });
      this.started.emit(v.run.id);
    } catch (e) { this.error.set(e instanceof Error ? e.message : String(e)); }
    finally { this.busy.set(false); }
  }
}

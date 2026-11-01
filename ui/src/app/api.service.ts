import { Injectable, signal } from '@angular/core';
import type { Check, Health, Repo, RunRow, RunView, TraceEvent, WorkType } from './models';

function load(key: string, fallback: string): string {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  /** Who is acting. Sent as x-user; put the service behind your SSO proxy to make this authoritative. */
  readonly user = signal(load('sdlc.user', ''));

  setUser(name: string): void {
    this.user.set(name);
    try { localStorage.setItem('sdlc.user', name); } catch { /* storage unavailable */ }
  }

  private async req<T>(method: string, url: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.user()) headers['x-user'] = this.user();
    const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      try { msg = (JSON.parse(text) as { error?: string }).error ?? text; } catch { /* plain text */ }
      throw new Error(msg || `HTTP ${res.status}`);
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  health = () => this.req<Health>('GET', '/api/health');
  repos = () => this.req<{ repos: Repo[] }>('GET', '/api/repos').then((r) => r.repos);
  doctor = (refresh = false) => this.req<{ checks: Check[]; at?: string }>('GET', `/api/doctor${refresh ? '?refresh=1' : ''}`);
  runs = () => this.req<{ runs: RunRow[] }>('GET', '/api/runs').then((r) => r.runs);
  run = (id: string) => this.req<RunView>('GET', `/api/runs/${id}`);
  events = (id: string, after = 0) => this.req<{ events: TraceEvent[] }>('GET', `/api/runs/${id}/events?after=${after}`).then((r) => r.events);
  start = (b: { ticket: string; repo?: string; baseBranch?: string; workType?: WorkType }) => this.req<RunView>('POST', '/api/runs', b);
  decide = (id: string, gate: string, decision: 'approved' | 'rejected', comment?: string) =>
    this.req<RunView>('POST', `/api/runs/${id}/gates/${gate}`, { decision, comment });
  cancel = (id: string) => this.req<RunView>('POST', `/api/runs/${id}/cancel`, {});
  retry = (id: string) => this.req<RunView>('POST', `/api/runs/${id}/retry`, {});
  artifacts = (id: string) => this.req<{ artifacts: { name: string; bytes: number }[] }>('GET', `/api/runs/${id}/artifacts`).then((r) => r.artifacts);

  async artifact(id: string, name: string): Promise<string | null> {
    const res = await fetch(`/api/runs/${id}/artifacts/${encodeURIComponent(name)}`);
    return res.ok ? res.text() : null;
  }
  attachmentUrl = (id: string, file: string) => `/api/runs/${id}/attachments/${encodeURIComponent(file)}`;
}

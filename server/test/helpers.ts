import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.js';
import { Trace } from '../src/events.js';
import { Orchestrator } from '../src/orchestrator.js';
import { STAGES } from '../src/pipeline.js';
import type { GitOps } from '../src/git.js';
import type { StageHandler, StageResult } from '../src/types.js';

export const fakeGit = (): GitOps & { commits: string[] } => {
  const commits: string[] = [];
  return {
    commits,
    syncCheckout: async () => {},
    ensureBranch: async () => {},
    commitAll: async (_c, m) => { commits.push(m); return true; },
    push: async () => {},
    changedFiles: async () => [],
    dirtyFiles: async () => [],
    revertFiles: async () => {},
  };
};

export function setup(script: Record<string, StageResult[]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sdlc-'));
  const workspace = join(dir, 'ws');
  mkdirSync(workspace, { recursive: true });
  const store = new Store(join(dir, 'db.sqlite'));
  const trace = new Trace(store);
  const git = fakeGit();
  const calls: string[] = [];
  const handlers: Record<string, StageHandler> = {};
  for (const s of STAGES) {
    if (s.kind === 'gate' || s.kind === 'end') continue;
    handlers[s.id] = async () => {
      calls.push(s.id);
      const q = script[s.id];
      return q && q.length ? q.shift()! : { outcome: 'pass' };
    };
  }
  const orchestrator = new Orchestrator({ store, trace, git, handlers });
  return { dir, workspace, store, trace, git, calls, orchestrator };
}

export const start = (o: Orchestrator, workspace: string) =>
  o.startRun({ ticket: 'ABC-1', workspace, project: 'P', repo: 'r', createdBy: 'tester' });

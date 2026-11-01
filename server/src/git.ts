import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnCapture, type Exec } from './proc.js';

export interface DirtyFile {
  path: string;
  untracked: boolean;
}

export interface GitAuth {
  type: 'bearer' | 'basic';
  username?: string;
  token: string;
}

export interface GitOps {
  /** Clones when the folder is not a checkout yet, otherwise fetches. Credentials are never stored in the remote URL. */
  syncCheckout(cwd: string, url: string | undefined): Promise<void>;
  ensureBranch(cwd: string, branch: string, base: string): Promise<void>;
  commitAll(cwd: string, message: string): Promise<boolean>;
  push(cwd: string, branch: string): Promise<void>;
  /** Files changed since base (committed on this branch, uncommitted, and untracked). */
  changedFiles(cwd: string, base: string): Promise<string[]>;
  dirtyFiles(cwd: string): Promise<DirtyFile[]>;
  revertFiles(cwd: string, files: DirtyFile[]): Promise<void>;
}

/** Run artifacts live in the checkout under .agents/runs/ but must never be committed. */
export const ARTIFACT_EXCLUDE = '.agents/runs/';
/** Never committed: run artifacts, the code index, and the output folders of PIT and StrykerJS. */
export const EXCLUDES = ['.agents/runs/', '.agents/index/', 'reports/mutation/', '.stryker-tmp/', 'target/pit-reports/', 'build/reports/pitest/'];

export class ShellGit implements GitOps {
  constructor(
    private identity: { name: string; email: string },
    private exec: Exec = spawnCapture,
    private auth?: GitAuth,
  ) {}

  /** Header passed with -c for network commands only. The token is masked in every error message. */
  private authArgs(): string[] {
    if (!this.auth) return [];
    const value = this.auth.type === 'bearer'
      ? `Bearer ${this.auth.token}`
      : `Basic ${Buffer.from(`${this.auth.username ?? ''}:${this.auth.token}`).toString('base64')}`;
    return ['-c', `http.extraHeader=Authorization: ${value}`];
  }

  private mask(text: string): string {
    if (!this.auth || this.auth.token.length < 6) return text;
    const basic = Buffer.from(`${this.auth.username ?? ''}:${this.auth.token}`).toString('base64');
    return text.split(this.auth.token).join('***').split(basic).join('***');
  }

  private async git(cwd: string, args: string[], allowFail = false, network = false): Promise<{ code: number; out: string }> {
    const full = network ? [...this.authArgs(), ...args] : args;
    const r = await this.exec('git', full, { cwd, timeoutMs: network ? 600_000 : 120_000, env: { GIT_TERMINAL_PROMPT: '0' } });
    if (r.exitCode !== 0 && !allowFail) {
      throw new Error(this.mask(`git ${args.join(' ')} failed (${r.exitCode}): ${(r.stderr || r.stdout).trim().slice(0, 500)}`));
    }
    return { code: r.exitCode, out: r.stdout };
  }

  /** Can we read this remote with the configured credentials? Used by the doctor command. */
  async lsRemote(url: string): Promise<{ ok: boolean; detail: string }> {
    const r = await this.exec('git', [...this.authArgs(), 'ls-remote', '--heads', url], {
      cwd: process.cwd(), timeoutMs: 30_000, env: { GIT_TERMINAL_PROMPT: '0' },
    });
    return { ok: r.exitCode === 0, detail: this.mask((r.stderr || r.stdout).trim().slice(0, 200)) };
  }

  async syncCheckout(cwd: string, url: string | undefined): Promise<void> {
    if (existsSync(join(cwd, '.git'))) {
      if (url) await this.git(cwd, ['fetch', '--prune', 'origin'], false, true);
      return;
    }
    if (!url) throw new Error(`${cwd} is not a git checkout and the repo has no clone url in the config`);
    mkdirSync(dirname(cwd), { recursive: true });
    await this.git(dirname(cwd), ['clone', url, cwd], false, true);
  }

  async ensureBranch(cwd: string, branch: string, base: string): Promise<void> {
    const excludeFile = join(cwd, '.git', 'info', 'exclude');
    const current = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8') : '';
    const have = new Set(current.split('\n'));
    const missing = EXCLUDES.filter((e) => !have.has(e));
    if (missing.length) {
      appendFileSync(excludeFile, `${current.endsWith('\n') || current === '' ? '' : '\n'}${missing.join('\n')}\n`);
    }
    const exists = await this.git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], true);
    if (exists.code === 0) {
      await this.git(cwd, ['checkout', branch]);
      return;
    }
    const localBase = await this.git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${base}`], true);
    const startPoint = localBase.code === 0 ? base : `origin/${base}`;
    await this.git(cwd, ['checkout', '-b', branch, startPoint]);
  }

  async commitAll(cwd: string, message: string): Promise<boolean> {
    await this.git(cwd, ['add', '-A']);
    const staged = await this.git(cwd, ['diff', '--cached', '--quiet'], true);
    if (staged.code === 0) return false;
    await this.git(cwd, [
      '-c', `user.name=${this.identity.name}`,
      '-c', `user.email=${this.identity.email}`,
      'commit', '-m', message,
    ]);
    return true;
  }

  async push(cwd: string, branch: string): Promise<void> {
    await this.git(cwd, ['push', '-u', 'origin', branch], false, true);
  }

  async changedFiles(cwd: string, base: string): Promise<string[]> {
    const files = new Set<string>();
    for (const ref of [base, `origin/${base}`]) {
      const r = await this.git(cwd, ['diff', '--name-only', `${ref}...HEAD`], true);
      if (r.code === 0) {
        r.out.split('\n').filter(Boolean).forEach((f) => files.add(f));
        break;
      }
    }
    for (const d of await this.dirtyFiles(cwd)) files.add(d.path);
    return [...files].sort();
  }

  async dirtyFiles(cwd: string): Promise<DirtyFile[]> {
    const r = await this.git(cwd, ['status', '--porcelain', '--untracked-files=all']);
    return r.out
      .split('\n')
      .filter((l) => l.length > 3)
      .map((l) => {
        const status = l.slice(0, 2);
        let path = l.slice(3);
        if (path.includes(' -> ')) path = path.split(' -> ')[1]!;
        return { path: path.replace(/^"|"$/g, ''), untracked: status === '??' };
      });
  }

  async revertFiles(cwd: string, files: DirtyFile[]): Promise<void> {
    const tracked = files.filter((f) => !f.untracked).map((f) => f.path);
    if (tracked.length) await this.git(cwd, ['checkout', 'HEAD', '--', ...tracked]);
    for (const f of files.filter((x) => x.untracked)) rmSync(join(cwd, f.path), { force: true });
  }
}

const TEST_FILE_PATTERNS = [
  /(^|\/)src\/test\//,
  /\.(spec|test)\.[cm]?[jt]sx?$/,
  /(^|\/)(__tests__|__mocks__)\//,
  /(Test|Tests|IT)\.java$/,
  /(^|\/)(cypress|e2e)\//,
];

export function isTestFile(path: string): boolean {
  return TEST_FILE_PATTERNS.some((p) => p.test(path.replace(/\\/g, '/')));
}

/** Production logic = Java under src/main or TypeScript that is not a test or declaration. */
export function isProductionLogic(path: string): boolean {
  const p = path.replace(/\\/g, '/');
  if (isTestFile(p)) return false;
  if (/\.java$/.test(p)) return /(^|\/)src\/main\//.test(p);
  return /\.(ts|tsx)$/.test(p) && !/\.d\.ts$/.test(p) && !/\.(module|routes|config)\.ts$/.test(p);
}

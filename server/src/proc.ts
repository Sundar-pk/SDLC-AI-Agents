import { spawn } from 'node:child_process';

export interface SpawnOpts {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxBytes?: number;
}

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
}

export type Exec = (command: string, args: string[], opts: SpawnOpts) => Promise<SpawnResult>;

/** Runs a command without a shell, captures output (capped), and enforces a timeout and abort signal. */
export const spawnCapture: Exec = (command, args, opts) =>
  new Promise((resolve) => {
    const started = Date.now();
    const max = opts.maxBytes ?? 5_000_000;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const kill = () => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    };
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; kill(); }, opts.timeoutMs) : null;
    const onAbort = () => { aborted = true; kill(); };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();

    child.stdout.on('data', (d: Buffer) => { if (stdout.length < max) stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { if (stderr.length < max) stderr += d.toString(); });

    const finish = (code: number | null, extraErr = '') => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ exitCode: code ?? -1, stdout, stderr: stderr + extraErr, durationMs: Date.now() - started, timedOut, aborted });
    };
    child.on('error', (err) => finish(127, err.message));
    child.on('close', (code) => finish(code));
  });

/** Keeps the lines that matter from long build or test output, to save tokens. */
export function failuresOnly(output: string, maxChars = 6000): string {
  const lines = output.split('\n');
  const interesting = /(FAIL|ERROR|FAILED|Failures:|Tests run:|AssertionError|expected|Exception|✕|✗|BUILD)/i;
  const picked = lines.filter((l) => interesting.test(l));
  const tail = lines.slice(-30);
  const merged = [...new Set([...picked.slice(0, 80), ...tail])].join('\n');
  return merged.length > maxChars ? `${merged.slice(0, maxChars)}\n… [truncated]` : merged;
}

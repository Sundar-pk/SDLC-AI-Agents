import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from '../config.js';
import { spawnCapture, type Exec } from '../proc.js';
import type { AgentRequest, AgentResult, AgentRunner } from './types.js';

export type OutputParser = 'claude-json' | 'text';

export interface CommandSpec {
  command: string;
  /** Placeholders: {instruction} {promptFile} {model}. */
  args: string[];
  parser: OutputParser;
}

/**
 * Fills placeholders. If {model} is not set, the argument holding it is dropped together with
 * the flag in front of it (so "--model {model}" disappears as a pair).
 */
export function renderArgs(template: string[], vars: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  for (const arg of template) {
    if (arg.includes('{model}') && !vars.model) {
      if (out.length && out[out.length - 1]!.startsWith('-')) out.pop();
      continue;
    }
    out.push(arg.replace(/\{(instruction|promptFile|model)\}/g, (_, k: string) => vars[k] ?? ''));
  }
  return out;
}

/** The tool-agnostic contract: the tool is told to read one file and follow it. */
export function instructionFor(promptFile: string): string {
  return `Read the file ${promptFile} and follow it exactly. It tells you your role, what to read, what to write, and the result file to create when you finish.`;
}

export function presetFor(cfg: AppConfig['runner']): CommandSpec {
  switch (cfg.kind) {
    case 'claude':
      return {
        command: 'claude',
        parser: 'claude-json',
        args: [
          '-p', '{instruction}',
          '--output-format', 'json',
          '--permission-mode', 'acceptEdits',
          '--allowedTools', cfg.allowedTools,
          '--model', '{model}',
        ],
      };
    case 'opencode':
      // Verify these flags against the opencode version installed in your environment.
      return { command: 'opencode', parser: 'text', args: ['run', '{instruction}', '--model', '{model}'] };
    case 'custom':
      if (!cfg.command || !cfg.args) throw new Error('llm.runner is "custom" but llm.custom.command and llm.custom.args are missing');
      return { command: cfg.command, args: cfg.args, parser: cfg.parser ?? 'text' };
  }
}

interface ParsedOutput {
  output: string;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  costUsd: number | null;
  turns: number | null;
  estimated: boolean;
  isError: boolean;
}

function parseClaudeJson(stdout: string): ParsedOutput | null {
  try {
    const j = JSON.parse(stdout.trim()) as Record<string, any>;
    if (!j || typeof j !== 'object') return null;
    const usage = (j.usage ?? {}) as Record<string, number>;
    return {
      output: typeof j.result === 'string' ? j.result : '',
      tokensIn: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
      tokensOut: usage.output_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      costUsd: typeof j.total_cost_usd === 'number' ? j.total_cost_usd : null,
      turns: typeof j.num_turns === 'number' ? j.num_turns : null,
      estimated: false,
      isError: j.is_error === true,
    };
  } catch {
    return null;
  }
}

export class CommandRunner implements AgentRunner {
  constructor(
    readonly name: string,
    private spec: CommandSpec,
    private opts: { model?: string; timeoutMs: number; env?: Record<string, string> },
    private exec: Exec = spawnCapture,
  ) {}

  async run(req: AgentRequest): Promise<AgentResult> {
    const args = renderArgs(this.spec.args, {
      instruction: instructionFor(req.promptFile),
      promptFile: req.promptFile,
      model: req.model ?? this.opts.model,
    });
    const r = await this.exec(this.spec.command, args, {
      cwd: req.cwd,
      timeoutMs: req.timeoutMs ?? this.opts.timeoutMs,
      signal: req.signal,
      env: this.opts.env,
    });

    let promptBytes = 0;
    try { promptBytes = statSync(req.promptFile).size; } catch { /* prompt file is optional for estimates */ }

    const parsed = this.spec.parser === 'claude-json' ? parseClaudeJson(r.stdout) : null;
    const base = {
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      timedOut: r.timedOut,
      aborted: r.aborted,
    };
    if (parsed) {
      return {
        ...base,
        exitCode: r.exitCode === 0 && parsed.isError ? 1 : r.exitCode,
        output: parsed.output || r.stderr,
        tokensIn: parsed.tokensIn,
        tokensOut: parsed.tokensOut,
        cacheReadTokens: parsed.cacheReadTokens,
        costUsd: parsed.costUsd,
        turns: parsed.turns,
        estimated: false,
      };
    }
    const output = r.stdout.trim() || r.stderr.trim();
    return {
      ...base,
      output,
      // Rough estimate (4 chars per token) when the tool reports no usage.
      tokensIn: Math.ceil(promptBytes / 4),
      tokensOut: Math.ceil(output.length / 4),
      cacheReadTokens: 0,
      costUsd: null,
      turns: null,
      estimated: true,
    };
  }
}

/** Writes an opencode config for an OpenAI-compatible internal endpoint (for example vLLM serving Qwen). */
export function writeOpencodeConfig(cfg: AppConfig['runner'], dir: string): string | null {
  if (cfg.kind !== 'opencode' || !cfg.opencode) return null;
  const o = cfg.opencode;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'opencode.json');
  writeFileSync(file, JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    provider: {
      [o.providerId]: {
        npm: '@ai-sdk/openai-compatible',
        name: o.providerId,
        options: { baseURL: o.baseURL, ...(o.apiKey ? { apiKey: o.apiKey } : {}) },
        models: Object.fromEntries(o.models.map((m) => [m, { name: m }])),
      },
    },
  }, null, 2), { mode: 0o600 });
  return file;
}

/** Model for a stage: stage override, then the default, then the first opencode model. */
export function modelFor(cfg: AppConfig['runner'], stageId: string): string | undefined {
  const m = cfg.stageModels[stageId] ?? cfg.model ?? (cfg.opencode ? cfg.opencode.models[0] : undefined);
  if (m && cfg.kind === 'opencode' && cfg.opencode && !m.includes('/')) return `${cfg.opencode.providerId}/${m}`;
  return m;
}

export function createRunner(cfg: AppConfig['runner'], exec: Exec = spawnCapture, dataDir?: string): AgentRunner {
  const env = { ...cfg.env };
  const file = dataDir ? writeOpencodeConfig(cfg, dataDir) : null;
  if (file) env.OPENCODE_CONFIG = file;
  return new CommandRunner(cfg.kind, presetFor(cfg), { model: modelFor(cfg, ''), timeoutMs: cfg.timeoutMs, env }, exec);
}

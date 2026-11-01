export interface AgentRequest {
  runId: string;
  stage: string;
  /** Markdown file holding the role, run context, inputs, outputs and the result contract. */
  promptFile: string;
  cwd: string;
  model?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface AgentResult {
  exitCode: number;
  output: string;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  costUsd: number | null;
  turns: number | null;
  durationMs: number;
  /** True when token counts were estimated (the tool did not report usage). */
  estimated: boolean;
  timedOut: boolean;
  aborted: boolean;
}

/** One headless call of an agent tool. Everything tool-specific lives behind this interface. */
export interface AgentRunner {
  readonly name: string;
  run(req: AgentRequest): Promise<AgentResult>;
}

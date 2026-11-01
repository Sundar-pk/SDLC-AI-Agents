export interface Survivor {
  file: string;
  line: number;
  mutator: string;
  description: string;
  status: 'SURVIVED' | 'NO_COVERAGE';
}

export interface MutationSummary {
  tool: 'pit' | 'stryker';
  killed: number;
  timeout: number;
  survived: number;
  noCoverage: number;
  total: number;
  /** 0 to 100, one decimal. 100 when there was nothing to mutate. */
  score: number;
  survivors: Survivor[];
}

export function scoreOf(killed: number, timeout: number, survived: number, noCoverage: number): number {
  const total = killed + timeout + survived + noCoverage;
  if (total === 0) return 100;
  return Math.round(((killed + timeout) / total) * 1000) / 10;
}

function norm(p: string): string {
  return p.replace(/\\/g, '/');
}

function inScope(file: string, changed?: string[]): boolean {
  if (!changed || changed.length === 0) return true;
  const f = norm(file);
  return changed.some((c) => f.endsWith(norm(c)) || norm(c).endsWith(f));
}

function decodeXml(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function finish(tool: 'pit' | 'stryker', c: { killed: number; timeout: number; survived: number; noCoverage: number }, survivors: Survivor[]): MutationSummary {
  const total = c.killed + c.timeout + c.survived + c.noCoverage;
  return { tool, ...c, total, score: scoreOf(c.killed, c.timeout, c.survived, c.noCoverage), survivors };
}

/** Parses PIT's mutations.xml. `changed` limits the result to files changed in the ticket. */
export function parsePitXml(xml: string, changed?: string[]): MutationSummary {
  const counts = { killed: 0, timeout: 0, survived: 0, noCoverage: 0 };
  const survivors: Survivor[] = [];
  const re = /<mutation\s+([^>]*?)>([\s\S]*?)<\/mutation>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const attrs = m[1] ?? '';
    const body = m[2] ?? '';
    const tag = (name: string) => {
      const t = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body);
      return t ? decodeXml((t[1] ?? '').trim()) : '';
    };
    const status = /status=['"]([^'"]*)['"]/.exec(attrs)?.[1] ?? '';
    const sourceFile = tag('sourceFile');
    const cls = tag('mutatedClass');
    const pkg = cls.split('.').slice(0, -1).join('/');
    const file = pkg ? `${pkg}/${sourceFile}` : sourceFile;
    if (!inScope(file, changed)) continue;

    if (status === 'KILLED' || status === 'MEMORY_ERROR') counts.killed++;
    else if (status === 'TIMED_OUT') counts.timeout++;
    else if (status === 'SURVIVED' || status === 'NO_COVERAGE') {
      if (status === 'SURVIVED') counts.survived++;
      else counts.noCoverage++;
      survivors.push({
        file,
        line: Number(tag('lineNumber')) || 0,
        mutator: tag('mutator').split('.').pop() ?? '',
        description: tag('description'),
        status,
      });
    }
    // NON_VIABLE, RUN_ERROR and STARTED do not count either way.
  }
  return finish('pit', counts, survivors);
}

interface StrykerMutant {
  mutatorName?: string;
  replacement?: string;
  description?: string;
  status?: string;
  location?: { start?: { line?: number } };
}

/** Parses StrykerJS's mutation.json (the json reporter). */
export function parseStrykerJson(input: string | object, changed?: string[]): MutationSummary {
  const json = (typeof input === 'string' ? JSON.parse(input) : input) as { files?: Record<string, { mutants?: StrykerMutant[] }> };
  const counts = { killed: 0, timeout: 0, survived: 0, noCoverage: 0 };
  const survivors: Survivor[] = [];
  for (const [file, data] of Object.entries(json.files ?? {})) {
    if (!inScope(file, changed)) continue;
    for (const mu of data.mutants ?? []) {
      switch (mu.status) {
        case 'Killed': counts.killed++; break;
        case 'Timeout': counts.timeout++; break;
        case 'Survived':
        case 'NoCoverage': {
          if (mu.status === 'Survived') counts.survived++;
          else counts.noCoverage++;
          survivors.push({
            file: norm(file),
            line: mu.location?.start?.line ?? 0,
            mutator: mu.mutatorName ?? '',
            description: (mu.description ?? mu.replacement ?? '').slice(0, 120),
            status: mu.status === 'Survived' ? 'SURVIVED' : 'NO_COVERAGE',
          });
          break;
        }
        // CompileError, RuntimeError, Ignored: not counted.
      }
    }
  }
  return finish('stryker', counts, survivors);
}

export function mergeSummaries(parts: MutationSummary[]): MutationSummary {
  const sum = (k: 'killed' | 'timeout' | 'survived' | 'noCoverage') => parts.reduce((a, p) => a + p[k], 0);
  return finish(
    parts[0]?.tool ?? 'pit',
    { killed: sum('killed'), timeout: sum('timeout'), survived: sum('survived'), noCoverage: sum('noCoverage') },
    parts.flatMap((p) => p.survivors),
  );
}

export interface GateVerdict {
  pass: boolean;
  reasons: string[];
}

/** Threshold on changed code plus the ratchet: the score must not drop below the recorded baseline. */
export function evaluateMutation(summary: { score: number; total: number }, opts: { threshold: number; baseline?: number }): GateVerdict {
  const reasons: string[] = [];
  if (summary.total > 0 && summary.score < opts.threshold) {
    reasons.push(`Mutation score ${summary.score}% is below the threshold of ${opts.threshold}%`);
  }
  if (opts.baseline !== undefined && summary.total > 0 && summary.score < opts.baseline) {
    reasons.push(`Mutation score ${summary.score}% dropped below the baseline of ${opts.baseline}%`);
  }
  return { pass: reasons.length === 0, reasons };
}

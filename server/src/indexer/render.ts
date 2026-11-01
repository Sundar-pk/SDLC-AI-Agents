import { execFileSync } from 'node:child_process';
import type { CodeIndex, FileEntry } from './index.js';
import type { Sym } from './parse.js';

const STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'when', 'then', 'should', 'must', 'will', 'can', 'are', 'not', 'has', 'have',
  'given', 'user', 'users', 'new', 'add', 'allow', 'able', 'need', 'needs', 'ticket', 'issue', 'jira', 'bug', 'fix', 'error',
  'page', 'screen', 'button', 'field', 'value', 'data', 'null', 'true', 'false', 'show', 'display', 'update', 'create', 'get', 'set',
]);

function splitWords(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function topSymbols(f: FileEntry, maxMethods = 8): string {
  const types = f.symbols.filter((s) => s.kind !== 'method');
  const parts = types.map((t) => {
    const tag = t.tags?.length ? ` @${t.tags.join(' @')}` : '';
    const methods = f.symbols.filter((m) => m.kind === 'method' && m.parent === t.name);
    const shown = methods.slice(0, maxMethods).map((m) => {
      const mt = m.tags?.length ? `[${m.tags.join(',')}]` : '';
      return `${m.name}${mt}`;
    });
    const more = methods.length > maxMethods ? `, +${methods.length - maxMethods}` : '';
    return `${t.kind === 'class' ? '' : `${t.kind} `}${t.name}${tag}${shown.length ? ` { ${shown.join(', ')}${more} }` : ''}`;
  });
  return parts.join('; ');
}

/**
 * Compact map of the repository for agents: most-imported source files first, with their types,
 * methods, Spring stereotypes, routes and tests. Cut off at the token budget (about 4 chars per token).
 */
export function renderRepoMap(index: CodeIndex, tokenBudget: number): string {
  const budget = tokenBudget * 4;
  const src = Object.values(index.files).filter((f) => !f.isTest);
  const modules = new Map<string, FileEntry[]>();
  for (const f of src) modules.set(f.module, [...(modules.get(f.module) ?? []), f]);

  const head = [
    '# Repo map',
    `Built ${index.builtAt}. ${src.length} source files, ${Object.keys(index.files).length - src.length} test files.`,
    'Most-imported files first. Use the find command or grep for anything not listed. `tests:` shows covering tests.',
    '',
  ];
  let used = head.join('\n').length;
  const lines: string[] = [];
  const ranked = [...src].sort((a, b) => (index.inbound[b.path] ?? 0) - (index.inbound[a.path] ?? 0) || a.path.localeCompare(b.path));
  const listed = new Set<string>();
  const reserve = Math.min(2500, Math.floor(budget * 0.2));
  for (const f of ranked) {
    const syms = topSymbols(f);
    if (!syms) continue;
    const tests = f.tests?.length ? `  tests: ${f.tests.map((t) => t.split('/').pop()).join(', ')}` : '';
    const line = `- ${f.path} (${index.inbound[f.path] ?? 0} refs): ${syms}${tests}`.slice(0, 360);
    if (used + line.length + 1 > budget - reserve) break;
    lines.push(line);
    used += line.length + 1;
    listed.add(f.path);
  }

  const dirs = new Map<string, number>();
  for (const f of src) {
    if (listed.has(f.path)) continue;
    const dir = f.path.split('/').slice(0, -1).join('/') || '.';
    dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
  }
  const rest: string[] = [];
  for (const [dir, n] of [...dirs.entries()].sort((a, b) => b[1] - a[1])) {
    const line = `- ${dir}/ (+${n} files)`;
    if (used + line.length + 1 > budget) { rest.push('- … more folders omitted'); break; }
    rest.push(line);
    used += line.length + 1;
  }
  return [...head, `## Modules: ${[...modules.keys()].sort().join(', ') || '.'}`, '', '## Key files', ...lines, ...(rest.length ? ['', '## Other folders', ...rest] : []), ''].join('\n');
}

interface Hit {
  file: FileEntry;
  score: number;
  matched: Sym[];
}

export function termsFrom(text: string, limit = 40): string[] {
  const counts = new Map<string, number>();
  for (const w of splitWords(text)) {
    if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w)) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([w]) => w);
}

export function scoreFiles(index: CodeIndex, terms: string[]): Hit[] {
  const set = new Set(terms);
  const hits: Hit[] = [];
  for (const f of Object.values(index.files)) {
    if (f.isTest) continue;
    let score = 0;
    const matched: Sym[] = [];
    const nameWords = new Set(splitWords(f.path.split('/').pop()!.replace(/\.\w+$/, '')));
    const pathWords = new Set(splitWords(f.path));
    for (const w of nameWords) if (set.has(w)) score += 5;
    for (const w of pathWords) if (set.has(w) && !nameWords.has(w)) score += 1;
    for (const s of f.symbols) {
      const words = new Set([...splitWords(s.name), ...(s.tags ?? []).flatMap(splitWords)]);
      let hit = 0;
      for (const w of words) if (set.has(w)) hit++;
      if (hit) {
        score += (s.kind === 'method' ? 2 : 3) * hit;
        matched.push(s);
      }
    }
    if (score > 0) {
      score += Math.min(3, (index.inbound[f.path] ?? 0) * 0.1);
      hits.push({ file: f, score, matched });
    }
  }
  return hits.sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path));
}

/** Picks the files most likely to matter for a ticket, with their tests and nearest neighbours. */
export function renderContext(index: CodeIndex, ticketText: string, maxFiles: number): string {
  const terms = termsFrom(ticketText);
  const hits = scoreFiles(index, terms).slice(0, maxFiles);
  const out = [
    '# Context for this ticket',
    'Chosen by keyword match against the code index (no LLM). Read these first. If something is missing, use the find command.',
    `Search terms: ${terms.slice(0, 15).join(', ') || '(none)'}`,
    '',
  ];
  if (!hits.length) {
    out.push('No file matched. This may be new functionality: look at the repo map for the closest module and follow its structure.');
    return out.join('\n');
  }
  out.push('## Likely files');
  for (const h of hits) {
    const ms = h.matched.slice(0, 6).map((s) => `${s.parent ? `${s.parent}.` : ''}${s.name}:${s.line}`).join(', ');
    out.push(`- ${h.file.path}${ms ? ` — ${ms}` : ''}${h.file.tests?.length ? `\n  tests: ${h.file.tests.join(', ')}` : ''}`);
  }
  const chosen = new Set(hits.map((h) => h.file.path));
  const neighbours = new Map<string, number>();
  const nameToFile = new Map<string, string>();
  for (const f of Object.values(index.files)) for (const s of f.symbols) if (!s.parent && s.kind !== 'method' && !f.isTest) nameToFile.set(s.name, f.path);
  for (const h of hits.slice(0, 5)) {
    for (const imp of h.file.imports) {
      const p = nameToFile.get(imp);
      if (p && !chosen.has(p)) neighbours.set(p, (neighbours.get(p) ?? 0) + 1);
    }
  }
  const near = [...neighbours.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([p]) => p);
  if (near.length) out.push('', '## Dependencies of the top files', ...near.map((p) => `- ${p}`));
  return out.join('\n');
}

/** Symbol and file search for the `find` command. Falls back to git grep for plain text. */
export function findInIndex(index: CodeIndex, query: string, limit = 25): string[] {
  const q = query.toLowerCase();
  const words = splitWords(query);
  const rows: { score: number; line: string }[] = [];
  for (const f of Object.values(index.files)) {
    if (f.path.toLowerCase().includes(q)) rows.push({ score: 4, line: `${f.path}  (file)` });
    for (const s of f.symbols) {
      const name = s.name.toLowerCase();
      const tagText = (s.tags ?? []).join(' ').toLowerCase();
      let score = 0;
      if (name === q) score = 10;
      else if (name.includes(q)) score = 6;
      else if (tagText.includes(q)) score = 5;
      else if (words.length > 1 && words.every((w) => splitWords(s.name).includes(w))) score = 4;
      if (score) rows.push({ score, line: `${f.path}:${s.line}  ${s.parent ? `${s.parent}: ` : ''}${s.sig ?? `${s.kind} ${s.name}`}${s.tags?.length ? `  [${s.tags.join(', ')}]` : ''}${f.isTest ? '  (test)' : ''}` });
    }
  }
  return rows.sort((a, b) => b.score - a.score).slice(0, limit).map((r) => r.line);
}

export function grepText(workspace: string, query: string, limit = 20): string[] {
  try {
    const out = execFileSync('git', ['grep', '-n', '-I', '-F', '-m', '3', '--', query], { cwd: workspace, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    return out.split('\n').filter(Boolean).slice(0, limit).map((l) => l.slice(0, 200));
  } catch {
    return [];
  }
}

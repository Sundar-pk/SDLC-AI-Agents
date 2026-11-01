/**
 * Lightweight, dependency-free symbol extraction for Java (Spring) and TypeScript (Angular).
 * It is deliberately approximate: the goal is a compact map and good search, not a compiler.
 */

export interface Sym {
  kind: 'class' | 'interface' | 'enum' | 'record' | 'type' | 'function' | 'const' | 'method';
  name: string;
  line: number;
  /** Short signature, for methods and functions. */
  sig?: string;
  /** Enclosing type for methods. */
  parent?: string;
  /** Stereotypes and routes: Service, RestController, GET /orders, Component app-order-list, ... */
  tags?: string[];
}

export interface Parsed {
  lang: 'java' | 'ts';
  pkg?: string;
  /** Simple names this file imports (used for "who depends on this"). */
  imports: string[];
  symbols: Sym[];
}

const JAVA_KEYWORDS = new Set(['return', 'new', 'if', 'for', 'while', 'switch', 'else', 'throw', 'catch', 'try', 'do', 'case', 'super', 'this', 'synchronized', 'assert']);
const SPRING_STEREOTYPES = ['RestController', 'Controller', 'Service', 'Component', 'Repository', 'Entity', 'Configuration', 'SpringBootApplication', 'ControllerAdvice', 'RestControllerAdvice', 'FeignClient'];
const MAPPINGS: Record<string, string> = { GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT', DeleteMapping: 'DELETE', PatchMapping: 'PATCH', RequestMapping: 'ANY' };

/** Removes strings and comments so brace counting and regexes are not fooled. Keeps line numbers. */
export function stripNoise(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    const d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') out += '\n'; i++; }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      out += q;
      i++;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') i++;
        else if (src[i] === '\n') { out += '\n'; if (q !== '`') break; }
        i++;
      }
      out += q;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function annotationValue(line: string): string | undefined {
  return /\(\s*(?:value\s*=\s*|path\s*=\s*)?\{?\s*"([^"]*)"/.exec(line)?.[1];
}

export function parseJava(source: string): Parsed {
  const text = source; // annotations carry string paths, so keep strings for annotation lines
  const clean = stripNoise(source).split('\n');
  const raw = text.split('\n');
  const symbols: Sym[] = [];
  const imports: string[] = [];
  let pkg: string | undefined;
  let depth = 0;
  let pending: string[] = [];
  const typeStack: { name: string; depth: number }[] = [];

  for (let i = 0; i < clean.length; i++) {
    const line = clean[i]!;
    const t = line.trim();
    if (!t) continue;
    const pm = /^package\s+([\w.]+)\s*;/.exec(t);
    if (pm) { pkg = pm[1]; continue; }
    const im = /^import\s+(?:static\s+)?([\w.]+?)(?:\.\*)?\s*;/.exec(t);
    if (im) { imports.push(im[1]!.split('.').pop()!); continue; }

    if (t.startsWith('@')) {
      pending.push(raw[i]!.trim());
    } else {
      const tm = /\b(class|interface|enum|record)\s+(\w+)/.exec(t);
      const isType = tm && /^(?:(?:public|protected|private|abstract|final|static|sealed|non-sealed|strictfp)\s+)*(class|interface|enum|record)\s/.test(t);
      if (isType && tm) {
        const tags: string[] = [];
        for (const a of pending) {
          const name = /^@(\w+)/.exec(a)?.[1];
          if (name && SPRING_STEREOTYPES.includes(name)) tags.push(name);
          if (name === 'RequestMapping') { const v = annotationValue(a); if (v) tags.push(`base ${v}`); }
        }
        symbols.push({ kind: tm[1] as Sym['kind'], name: tm[2]!, line: i + 1, tags: tags.length ? tags : undefined, parent: typeStack.at(-1)?.name });
        typeStack.push({ name: tm[2]!, depth });
        pending = [];
      } else if (typeStack.length && depth === typeStack.at(-1)!.depth + 1) {
        const mm = /^(?:(public|protected|private)\s+)?(?:(?:static|final|abstract|synchronized|default)\s+)*(?:<[^>]+>\s+)?([\w<>\[\],.?& ]+?)\s+(\w+)\s*\(([^)]*)\)?/.exec(t);
        const MODIFIERS = new Set(['public', 'protected', 'private', 'static', 'final', 'abstract', 'synchronized', 'default']);
        if (mm && !JAVA_KEYWORDS.has(mm[3]!) && !JAVA_KEYWORDS.has(mm[2]!.split(' ')[0]!) && !MODIFIERS.has(mm[2]!.trim()) && mm[3] !== typeStack.at(-1)!.name && mm[1] !== 'private' && !/=/.test(t.split('(')[0]!)) {
          const tags: string[] = [];
          for (const a of pending) {
            const name = /^@(\w+)/.exec(a)?.[1];
            if (name && MAPPINGS[name]) tags.push(`${MAPPINGS[name]} ${annotationValue(a) ?? ''}`.trim());
            if (name === 'Transactional') tags.push('Transactional');
            if (name === 'Scheduled') tags.push('Scheduled');
            if (name === 'EventListener' || name === 'KafkaListener' || name === 'RabbitListener') tags.push(name);
          }
          symbols.push({
            kind: 'method', name: mm[3]!, line: i + 1, parent: typeStack.at(-1)!.name,
            sig: `${mm[2]!.trim()} ${mm[3]}(${mm[4]!.replace(/\s+/g, ' ').trim().slice(0, 80)})`, tags: tags.length ? tags : undefined,
          });
        }
        pending = [];
      } else {
        pending = [];
      }
    }
    for (const ch of line) {
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        while (typeStack.length && depth <= typeStack.at(-1)!.depth) typeStack.pop();
      }
    }
  }
  return { lang: 'java', pkg, imports, symbols };
}

const TS_DECORATORS = ['Component', 'Injectable', 'NgModule', 'Directive', 'Pipe'];

export function parseTs(source: string): Parsed {
  const clean = stripNoise(source).split('\n');
  const raw = source.split('\n');
  const symbols: Sym[] = [];
  const imports: string[] = [];
  let depth = 0;
  let pendingDeco: string[] = [];
  const typeStack: { name: string; depth: number }[] = [];

  for (let i = 0; i < clean.length; i++) {
    const line = clean[i]!;
    const t = line.trim();
    if (!t) continue;

    const im = /^import\s+(?:type\s+)?(.*?)\s+from\s+['"]/.exec(t) ?? /^import\s+(?:type\s+)?(.*?)\s+from\s*$/.exec(t);
    if (im) {
      for (const part of im[1]!.replace(/[{}*]/g, ' ').split(/[,\s]+/)) {
        const n = part.trim();
        if (n && n !== 'as' && n !== 'type' && /^\w+$/.test(n)) imports.push(n);
      }
    }

    const deco = new RegExp(`^@(${TS_DECORATORS.join('|')})\\b`).exec(t);
    if (deco) {
      let tag = deco[1]!;
      const block = raw.slice(i, i + 14).join(' ');
      const sel = /selector:\s*['"]([^'"]+)['"]/.exec(block)?.[1];
      if (sel) tag += ` ${sel}`;
      pendingDeco.push(tag);
    }

    const decl = /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(class|interface|enum|type|function|const|let)\s+(\w+)/.exec(t);
    if (decl && (depth === 0 || (typeStack.length === 0 && decl[1] !== 'const' && decl[1] !== 'let'))) {
      const kind = decl[1] === 'let' ? 'const' : (decl[1] as Sym['kind']);
      const exported = /^export\b/.test(t);
      if (exported || kind === 'class' || kind === 'interface') {
        const sym: Sym = { kind, name: decl[2]!, line: i + 1 };
        if (kind === 'function') sym.sig = `${decl[2]}(${(/\(([^)]*)\)/.exec(t)?.[1] ?? '').replace(/\s+/g, ' ').slice(0, 80)})`;
        if (pendingDeco.length) sym.tags = pendingDeco;
        symbols.push(sym);
        if (kind === 'class' || kind === 'interface') typeStack.push({ name: decl[2]!, depth });
        pendingDeco = [];
      }
    } else if (typeStack.length && depth === typeStack.at(-1)!.depth + 1 && !t.startsWith('@')) {
      const mm = /^(?:(public|protected|private)\s+)?(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?(\w+)\s*\(([^)]*)\)?\s*(?::\s*([^{=]+))?/.exec(t);
      if (mm && mm[1] !== 'private' && !['if', 'for', 'while', 'switch', 'catch', 'constructor', 'return', 'function'].includes(mm[2]!) && /[{:]|\)\s*$/.test(t)) {
        symbols.push({
          kind: 'method', name: mm[2]!, line: i + 1, parent: typeStack.at(-1)!.name,
          sig: `${mm[2]}(${mm[3]!.replace(/\s+/g, ' ').trim().slice(0, 80)})${mm[4] ? `: ${mm[4].trim().slice(0, 40)}` : ''}`,
        });
      }
    }

    for (const ch of line) {
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        while (typeStack.length && depth <= typeStack.at(-1)!.depth) typeStack.pop();
      }
    }
  }
  return { lang: 'ts', imports, symbols };
}

export function parseSource(path: string, source: string): Parsed | null {
  if (path.endsWith('.java')) return parseJava(source);
  if (/\.(ts|tsx)$/.test(path) && !path.endsWith('.d.ts')) return parseTs(source);
  return null;
}

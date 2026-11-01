import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { isTestFile } from '../git.js';
import { detectModules, moduleOf } from '../scripts/detect.js';
import { parseSource, type Sym } from './parse.js';

export interface FileEntry {
  path: string;
  lang: 'java' | 'ts';
  size: number;
  mtimeMs: number;
  module: string;
  isTest: boolean;
  pkg?: string;
  imports: string[];
  symbols: Sym[];
  /** For a test: the file it most likely covers. */
  testFor?: string;
  /** For a source file: tests that most likely cover it. */
  tests?: string[];
}

export interface CodeIndex {
  version: 1;
  builtAt: string;
  files: Record<string, FileEntry>;
  /** How many files import each top-level type name (a cheap importance score). */
  inbound: Record<string, number>;
}

const INDEX_VERSION = 1;
const MAX_FILE_BYTES = 400 * 1024;
const SKIP = /(^|\/)(node_modules|target|build|dist|out|coverage|\.angular|\.gradle|\.idea|generated|\.agents)\//;

export const indexDir = (workspace: string) => join(workspace, '.agents', 'index');

function listFiles(workspace: string): string[] {
  try {
    const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: workspace, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return out.split('\n').filter(Boolean);
  } catch {
    const acc: string[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 12) return;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        const rel = relative(workspace, p).replace(/\\/g, '/');
        if (e.isDirectory()) { if (!SKIP.test(`${rel}/`) && !e.name.startsWith('.git')) walk(p, depth + 1); }
        else acc.push(rel);
      }
    };
    walk(workspace, 0);
    return acc;
  }
}

function testTarget(path: string): { dir: string; base: string } | null {
  const file = path.split('/').pop()!;
  const dir = path.slice(0, path.length - file.length);
  const java = /^(\w+?)(?:Tests?|IT)\.java$/.exec(file);
  if (java) return { dir, base: java[1]! };
  const ts = /^(.+)\.(?:spec|test)\.tsx?$/.exec(file);
  if (ts) return { dir, base: ts[1]! };
  return null;
}

/** Pairs tests with the source files they cover, by naming convention and package or folder. */
function linkTests(files: Record<string, FileEntry>): void {
  const byBase = new Map<string, string[]>();
  for (const f of Object.values(files)) {
    if (f.isTest) continue;
    const file = f.path.split('/').pop()!;
    const base = file.replace(/\.(java|tsx?)$/, '');
    byBase.set(base, [...(byBase.get(base) ?? []), f.path]);
  }
  for (const f of Object.values(files)) {
    if (!f.isTest) continue;
    const t = testTarget(f.path);
    if (!t) continue;
    const candidates = byBase.get(t.base) ?? [];
    const target = candidates.find((c) => f.pkg && files[c]?.pkg === f.pkg) ?? candidates.find((c) => c.startsWith(t.dir.replace(/src\/test\//, 'src/main/'))) ?? candidates[0];
    if (target) {
      f.testFor = target;
      (files[target]!.tests ??= []).push(f.path);
    }
  }
}

function computeInbound(files: Record<string, FileEntry>): Record<string, number> {
  const imported = new Map<string, number>();
  for (const f of Object.values(files)) {
    for (const name of new Set(f.imports)) imported.set(name, (imported.get(name) ?? 0) + 1);
  }
  const inbound: Record<string, number> = {};
  for (const f of Object.values(files)) {
    if (f.isTest) continue;
    inbound[f.path] = f.symbols.filter((s) => !s.parent && s.kind !== 'method').reduce((n, s) => n + (imported.get(s.name) ?? 0), 0);
  }
  return inbound;
}

export interface BuildStats {
  total: number;
  reparsed: number;
  reused: number;
  removed: number;
  ms: number;
}

/**
 * Builds or refreshes the index. Files whose size and mtime did not change are reused, so a refresh
 * after a small change costs milliseconds and no LLM tokens.
 */
export function buildIndex(workspace: string): { index: CodeIndex; stats: BuildStats } {
  const started = Date.now();
  const cacheFile = join(indexDir(workspace), 'index.json');
  let prev: CodeIndex | null = null;
  try {
    if (existsSync(cacheFile)) {
      const j = JSON.parse(readFileSync(cacheFile, 'utf8')) as CodeIndex;
      if (j.version === INDEX_VERSION) prev = j;
    }
  } catch { prev = null; }

  const modules = detectModules(workspace);
  const files: Record<string, FileEntry> = {};
  let reparsed = 0;
  let reused = 0;
  const seen = new Set<string>();
  for (const rel of listFiles(workspace)) {
    if (SKIP.test(rel) || !/\.(java|ts|tsx)$/.test(rel) || rel.endsWith('.d.ts')) continue;
    const abs = join(workspace, rel);
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
    seen.add(rel);
    const old = prev?.files[rel];
    if (old && old.size === st.size && old.mtimeMs === st.mtimeMs) {
      files[rel] = { ...old, testFor: undefined, tests: undefined };
      reused++;
      continue;
    }
    const parsed = parseSource(rel, readFileSync(abs, 'utf8'));
    if (!parsed) continue;
    files[rel] = {
      path: rel, lang: parsed.lang, size: st.size, mtimeMs: st.mtimeMs,
      module: moduleOf(modules, rel)?.dir ?? '.', isTest: isTestFile(rel),
      pkg: parsed.pkg, imports: parsed.imports, symbols: parsed.symbols,
    };
    reparsed++;
  }
  const removed = prev ? Object.keys(prev.files).filter((p) => !seen.has(p)).length : 0;
  linkTests(files);
  const index: CodeIndex = { version: INDEX_VERSION, builtAt: new Date().toISOString(), files, inbound: computeInbound(files) };

  mkdirSync(indexDir(workspace), { recursive: true });
  writeFileSync(cacheFile, JSON.stringify(index));
  return { index, stats: { total: Object.keys(files).length, reparsed, reused, removed, ms: Date.now() - started } };
}

export function loadIndex(workspace: string): CodeIndex | null {
  try { return JSON.parse(readFileSync(join(indexDir(workspace), 'index.json'), 'utf8')) as CodeIndex; } catch { return null; }
}

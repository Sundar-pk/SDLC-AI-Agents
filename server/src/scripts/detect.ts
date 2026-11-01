import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export type BuildKind = 'maven' | 'gradle' | 'npm';

export interface Cmd {
  command: string;
  args: string[];
}

export interface ModuleInfo {
  kind: BuildKind;
  /** Path relative to the workspace root, "." for the root. */
  dir: string;
  abs: string;
  angular: boolean;
  mutationTool: 'pit' | 'stryker';
  testCommand: Cmd;
  /** Where the mutation tool writes its report, relative to the module directory. */
  reportPath: string;
}

const SKIP = new Set(['node_modules', '.git', 'target', 'build', 'dist', '.agents', '.gradle', '.angular', 'coverage', 'src']);

function read(p: string): string {
  try { return readFileSync(p, 'utf8'); } catch { return ''; }
}

/**
 * Finds build modules by their marker files. This is a script, not an LLM call.
 * pom.xml -> Maven + PIT, build.gradle(.kts) -> Gradle + PIT, package.json -> npm + StrykerJS.
 */
export function detectModules(root: string, maxDepth = 3): ModuleInfo[] {
  const found: ModuleInfo[] = [];

  const visit = (abs: string, depth: number) => {
    const dir = relative(root, abs) || '.';

    const pom = join(abs, 'pom.xml');
    if (existsSync(pom)) {
      const text = read(pom);
      const aggregator = /<packaging>\s*pom\s*<\/packaging>/.test(text) && /<modules>/.test(text);
      if (!aggregator) {
        found.push({
          kind: 'maven', dir, abs, angular: false, mutationTool: 'pit',
          testCommand: existsSync(join(abs, 'mvnw')) ? { command: './mvnw', args: ['-q', 'test'] } : { command: 'mvn', args: ['-q', 'test'] },
          reportPath: 'target/pit-reports/mutations.xml',
        });
      }
    }

    const gradleFile = ['build.gradle', 'build.gradle.kts'].map((f) => join(abs, f)).find(existsSync);
    if (gradleFile) {
      const hasSettings = existsSync(join(abs, 'settings.gradle')) || existsSync(join(abs, 'settings.gradle.kts'));
      const aggregator = hasSettings && !existsSync(join(abs, 'src'));
      if (!aggregator) {
        found.push({
          kind: 'gradle', dir, abs, angular: false, mutationTool: 'pit',
          testCommand: existsSync(join(abs, 'gradlew')) ? { command: './gradlew', args: ['test'] } : { command: 'gradle', args: ['test'] },
          reportPath: 'build/reports/pitest/mutations.xml',
        });
      }
    }

    const pkg = join(abs, 'package.json');
    if (existsSync(pkg)) {
      const text = read(pkg);
      const angular = existsSync(join(abs, 'angular.json')) || existsSync(join(abs, 'nx.json')) || text.includes('"@angular/core"');
      found.push({
        kind: 'npm', dir, abs, angular, mutationTool: 'stryker',
        testCommand: { command: 'npm', args: ['test', '--', '--watch=false'] },
        reportPath: 'reports/mutation/mutation.json',
      });
    }

    if (depth >= maxDepth) return;
    let entries: string[] = [];
    try { entries = readdirSync(abs, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { /* unreadable */ }
    for (const name of entries.sort()) {
      if (!SKIP.has(name) && !name.startsWith('.')) visit(join(abs, name), depth + 1);
    }
  };

  visit(root, 0);
  return found;
}

/** The module that owns a file: the one with the longest matching directory prefix. */
export function moduleOf(modules: ModuleInfo[], file: string): ModuleInfo | undefined {
  const f = file.replace(/\\/g, '/');
  return modules
    .filter((m) => m.dir === '.' || f === m.dir || f.startsWith(`${m.dir.replace(/\\/g, '/')}/`))
    .sort((a, b) => b.dir.length - a.dir.length)[0];
}

export function hasMutationConfig(m: ModuleInfo): boolean {
  switch (m.kind) {
    case 'maven':
      return read(join(m.abs, 'pom.xml')).includes('pitest-maven');
    case 'gradle':
      return ['build.gradle', 'build.gradle.kts'].some((f) => read(join(m.abs, f)).includes('pitest'));
    case 'npm': {
      const configs = ['stryker.conf.json', 'stryker.conf.js', 'stryker.conf.mjs', 'stryker.conf.cjs', 'stryker.config.json', 'stryker.config.mjs'];
      return configs.some((f) => existsSync(join(m.abs, f))) || read(join(m.abs, 'package.json')).includes('@stryker-mutator');
    }
  }
}

/** Builds the mutation command scoped to the changed files (paths relative to the module directory). */
export function mutationCommand(m: ModuleInfo, changedRel: string[]): Cmd {
  switch (m.kind) {
    case 'maven': {
      const classes = changedRel
        .map((f) => /src\/main\/java\/(.+)\.java$/.exec(f.replace(/\\/g, '/'))?.[1]?.replace(/\//g, '.'))
        .filter((c): c is string => Boolean(c));
      const base = m.testCommand.command;
      return {
        command: base,
        args: [
          '-q', 'org.pitest:pitest-maven:mutationCoverage',
          '-DoutputFormats=XML', '-DtimestampedReports=false', '-DwithHistory=true', '-DfailWhenNoMutations=false',
          ...(classes.length ? [`-DtargetClasses=${classes.join(',')}`] : []),
        ],
      };
    }
    case 'gradle': {
      const classes = changedRel
        .map((f) => /src\/main\/java\/(.+)\.java$/.exec(f.replace(/\\/g, '/'))?.[1]?.replace(/\//g, '.'))
        .filter((c): c is string => Boolean(c));
      return {
        command: m.testCommand.command,
        // The generated Gradle config patch reads this property to limit PIT to the changed classes.
        args: ['pitest', ...(classes.length ? [`-PpitTargetClasses=${classes.join(',')}`] : [])],
      };
    }
    case 'npm':
      return {
        command: 'npx',
        args: ['--no-install', 'stryker', 'run', '--mutate', changedRel.join(','), '--reporters', 'json,clear-text'],
      };
  }
}

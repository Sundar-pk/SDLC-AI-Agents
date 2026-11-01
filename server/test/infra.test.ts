import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isProductionLogic, isTestFile, ShellGit } from '../src/git.js';
import { CommandRunner, renderArgs } from '../src/runners/command-runner.js';
import { detectModules, hasMutationConfig, mutationCommand } from '../src/scripts/detect.js';

const sh = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' });
const tmp = () => mkdtempSync(join(tmpdir(), 'infra-'));

function repo() {
  const d = tmp();
  sh(d, 'init', '-b', 'main');
  sh(d, 'config', 'user.email', 't@t'); sh(d, 'config', 'user.name', 't');
  mkdirSync(join(d, 'src/main/java'), { recursive: true });
  mkdirSync(join(d, 'src/test/java'), { recursive: true });
  writeFileSync(join(d, 'src/main/java/Foo.java'), 'class Foo {}');
  writeFileSync(join(d, 'src/test/java/FooTest.java'), 'class FooTest {}');
  sh(d, 'add', '-A'); sh(d, 'commit', '-m', 'init');
  return d;
}

describe('git', () => {
  const git = new ShellGit({ name: 'Bot', email: 'bot@x' });
  it('creates the branch, excludes run artifacts, commits as the bot, reports changes', async () => {
    const d = repo();
    await git.ensureBranch(d, 'agents/abc-1', 'main');
    expect(sh(d, 'branch', '--show-current').trim()).toBe('agents/abc-1');
    mkdirSync(join(d, '.agents/runs/ABC-1'), { recursive: true });
    writeFileSync(join(d, '.agents/runs/ABC-1/spec.md'), 'x');
    writeFileSync(join(d, 'src/main/java/Bar.java'), 'class Bar {}');
    expect(await git.changedFiles(d, 'main')).toEqual(['src/main/java/Bar.java']);
    expect(await git.commitAll(d, 'msg')).toBe(true);
    expect(await git.commitAll(d, 'again')).toBe(false);
    expect(sh(d, 'log', '-1', '--format=%an').trim()).toBe('Bot');
    expect(sh(d, 'ls-files').includes('.agents')).toBe(false);
    expect(await git.changedFiles(d, 'main')).toEqual(['src/main/java/Bar.java']);
  });
  it('reverts tracked edits and removes untracked files', async () => {
    const d = repo();
    writeFileSync(join(d, 'src/test/java/FooTest.java'), 'changed');
    writeFileSync(join(d, 'src/test/java/NewTest.java'), 'new');
    const dirty = await git.dirtyFiles(d);
    expect(dirty.map((x) => x.path).sort()).toEqual(['src/test/java/FooTest.java', 'src/test/java/NewTest.java']);
    await git.revertFiles(d, dirty);
    expect(await git.dirtyFiles(d)).toEqual([]);
    expect(existsSync(join(d, 'src/test/java/NewTest.java'))).toBe(false);
  });
  it('classifies test and production files', () => {
    expect(isTestFile('src/test/java/A.java')).toBe(true);
    expect(isTestFile('app/x.component.spec.ts')).toBe(true);
    expect(isProductionLogic('src/main/java/A.java')).toBe(true);
    expect(isProductionLogic('app/x.module.ts')).toBe(false);
    expect(isProductionLogic('app/x.service.ts')).toBe(true);
  });
});

describe('command runner', () => {
  it('drops the --model pair when no model is set', () => {
    expect(renderArgs(['-p', '{instruction}', '--model', '{model}'], { instruction: 'go', model: undefined })).toEqual(['-p', 'go']);
  });
  it('runs any CLI, passes the instruction, estimates tokens when none are reported', async () => {
    const d = tmp();
    const cli = join(d, 'fakecli');
    writeFileSync(cli, '#!/bin/sh\necho "got: $1"\n'); chmodSync(cli, 0o755);
    const prompt = join(d, 'p.md'); writeFileSync(prompt, 'hello world');
    const r = new CommandRunner('fake', { command: cli, args: ['{instruction}'], parser: 'text' }, { timeoutMs: 5000 });
    const res = await r.run({ runId: 'r', stage: 's', promptFile: prompt, cwd: d });
    expect(res.exitCode).toBe(0);
    expect(res.output).toContain(prompt);
    expect(res.estimated).toBe(true);
    expect(res.tokensIn).toBeGreaterThan(0);
  });
  it('parses claude json usage', async () => {
    const d = tmp();
    const cli = join(d, 'claudeish');
    writeFileSync(cli, `#!/bin/sh\necho '{"type":"result","is_error":false,"result":"ok","total_cost_usd":0.01,"num_turns":3,"usage":{"input_tokens":100,"output_tokens":20,"cache_read_input_tokens":50}}'\n`); chmodSync(cli, 0o755);
    const r = new CommandRunner('claude', { command: cli, args: [], parser: 'claude-json' }, { timeoutMs: 5000 });
    const res = await r.run({ runId: 'r', stage: 's', promptFile: join(d, 'none'), cwd: d });
    expect(res).toMatchObject({ output: 'ok', tokensIn: 100, tokensOut: 20, cacheReadTokens: 50, costUsd: 0.01, turns: 3, estimated: false });
  });
  it('reports a missing binary as a failed call, not a crash', async () => {
    const r = new CommandRunner('x', { command: '/nonexistent/cli', args: [], parser: 'text' }, { timeoutMs: 5000 });
    expect((await r.run({ runId: 'r', stage: 's', promptFile: '/x', cwd: tmp() })).exitCode).not.toBe(0);
  });
});

describe('build detection', () => {
  it('finds maven, gradle and npm modules and their mutation tools', () => {
    const d = tmp();
    mkdirSync(join(d, 'api')); mkdirSync(join(d, 'web'));
    writeFileSync(join(d, 'api/pom.xml'), '<project><build><plugins><plugin><artifactId>pitest-maven</artifactId></plugin></plugins></build></project>');
    writeFileSync(join(d, 'web/package.json'), '{"scripts":{"test":"ng test"}}');
    const mods = detectModules(d);
    const api = mods.find((m) => m.dir === 'api')!;
    const web = mods.find((m) => m.dir === 'web')!;
    expect([api.kind, api.mutationTool]).toEqual(['maven', 'pit']);
    expect([web.kind, web.mutationTool]).toEqual(['npm', 'stryker']);
    expect(hasMutationConfig(api)).toBe(true);
    expect(hasMutationConfig(web)).toBe(false);
    expect(mutationCommand(api, ['com/x/Foo.java']).args.join(' ')).toContain('pitest');
  });
});

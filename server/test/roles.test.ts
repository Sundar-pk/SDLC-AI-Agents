import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { STAGES } from '../src/pipeline.js';

describe('role files', () => {
  const dir = loadConfig({}).rolesDir;
  it('default roles dir points at the repo roles', () => {
    expect(dir).toBe(resolve('../.agents/roles'));
  });
  for (const s of STAGES.filter((x) => x.kind === 'agent')) {
    it(`${s.id} has role ${s.role} that names its outputs`, () => {
      const f = join(dir, `${s.role}.md`);
      expect(existsSync(f)).toBe(true);
      const text = readFileSync(f, 'utf8');
      for (const out of s.outputs) expect(text, out).toContain(out.replace(/\.json$/, '').replace(/\.md$/, ''));
    });
  }
  it('intake role documents the ambiguity keys the service reads', () => {
    const text = readFileSync(join(dir, 'jira_reader.md'), 'utf8');
    expect(text).toContain('"ambiguous"');
    expect(text).toContain('"questions"');
  });
});

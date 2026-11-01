import { describe, expect, it } from 'vitest';
import { evaluateMutation, mergeSummaries, parsePitXml, parseStrykerJson, scoreOf } from '../src/scripts/mutation.js';
import { classifyRedRun } from '../src/scripts/red-check.js';

const PIT = `<?xml version="1.0"?><mutations>
<mutation detected='true' status='KILLED' numberOfTestsRun='2'><sourceFile>Calc.java</sourceFile><mutatedClass>com.x.Calc</mutatedClass><mutatedMethod>add</mutatedMethod><lineNumber>10</lineNumber><mutator>org.pitest.mutationtest.engine.gregor.mutators.MathMutator</mutator><description>Replaced integer addition with subtraction</description></mutation>
<mutation detected='false' status='SURVIVED' numberOfTestsRun='2'><sourceFile>Calc.java</sourceFile><mutatedClass>com.x.Calc</mutatedClass><mutatedMethod>div</mutatedMethod><lineNumber>20</lineNumber><mutator>org.pitest.mutationtest.engine.gregor.mutators.NegateConditionalsMutator</mutator><description>negated conditional</description></mutation>
<mutation detected='false' status='NO_COVERAGE' numberOfTestsRun='0'><sourceFile>Other.java</sourceFile><mutatedClass>com.x.Other</mutatedClass><mutatedMethod>m</mutatedMethod><lineNumber>5</lineNumber><mutator>m</mutator><description>d</description></mutation>
</mutations>`;

describe('mutation parsers', () => {
  it('parses PIT and scores killed over total', () => {
    const s = parsePitXml(PIT);
    expect(s).toMatchObject({ tool: 'pit', killed: 1, survived: 1, noCoverage: 1, total: 3 });
    expect(s.score).toBe(33.3);
    expect(s.survivors.map((x) => x.line)).toEqual([20, 5]);
  });
  it('scopes to changed files', () => {
    const s = parsePitXml(PIT, ['Calc.java']);
    expect(s.total).toBe(2);
    expect(s.score).toBe(50);
  });
  it('parses Stryker json', () => {
    const s = parseStrykerJson({ files: { 'src/a.ts': { mutants: [
      { status: 'Killed', mutatorName: 'X', location: { start: { line: 1 } } },
      { status: 'Survived', mutatorName: 'Y', location: { start: { line: 4 } } },
      { status: 'Ignored', mutatorName: 'Z', location: { start: { line: 5 } } },
    ] } } });
    expect(s).toMatchObject({ tool: 'stryker', killed: 1, survived: 1, total: 2, score: 50 });
  });
  it('merges and treats nothing-to-mutate as 100', () => {
    expect(scoreOf(0, 0, 0, 0)).toBe(100);
    expect(mergeSummaries([parsePitXml(PIT), parsePitXml(PIT)]).total).toBe(6);
  });
  it('enforces threshold and ratchet', () => {
    expect(evaluateMutation({ score: 80, total: 10 }, { threshold: 70 }).pass).toBe(true);
    expect(evaluateMutation({ score: 60, total: 10 }, { threshold: 70 }).pass).toBe(false);
    expect(evaluateMutation({ score: 75, total: 10 }, { threshold: 70, baseline: 85 }).pass).toBe(false);
  });
});

describe('red check', () => {
  it('accepts behavioural failures only', () => {
    expect(classifyRedRun({ exitCode: 1, output: 'expected 3 but was 0' }).ok).toBe(true);
    expect(classifyRedRun({ exitCode: 0, output: 'ok' }).ok).toBe(false);
    expect(classifyRedRun({ exitCode: 1, output: 'COMPILATION ERROR' }).ok).toBe(false);
    expect(classifyRedRun({ exitCode: 1, output: 'x', timedOut: true }).ok).toBe(false);
  });
});

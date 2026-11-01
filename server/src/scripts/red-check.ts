export interface RedVerdict {
  ok: boolean;
  reason: string;
}

const COMPILE_ERRORS = [
  /COMPILATION ERROR/,
  /error: cannot find symbol/,
  /error: package .* does not exist/,
  /error TS\d+/,
  /\bNG\d{4}:/,
  /Cannot find module/,
  /SyntaxError/,
  /Could not resolve dependenc/i,
  /Execution failed for task ':compile/,
];

/**
 * RED means the new tests fail because behaviour is missing, not because the code does not build.
 * A passing run is not red either: it means the tests prove nothing.
 */
export function classifyRedRun(run: { exitCode: number; output: string; timedOut?: boolean }): RedVerdict {
  if (run.timedOut) return { ok: false, reason: 'The test run timed out' };
  if (run.exitCode === 0) return { ok: false, reason: 'Tests pass before any implementation. They do not prove the new behaviour.' };
  const hit = COMPILE_ERRORS.find((p) => p.test(run.output));
  if (hit) return { ok: false, reason: 'Tests fail to build, not on behaviour. Fix compile errors first (stubs are fine).' };
  return { ok: true, reason: 'Tests fail on behaviour, as expected' };
}

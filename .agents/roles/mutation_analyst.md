# Role: Kill survivors
A mutation tool changed the production code in small ways and some tests did not notice. Strengthen the tests so they notice.

Read `mutation-report.json`. It lists surviving mutants: file, line, mutator, description. Read only those lines and the tests that cover them.

For each survivor decide:
- **Test gap**: add or strengthen a test with an assertion that fails under that mutation (check boundary values, return values, side effects, negated conditions).
- **Equivalent mutant**: the change cannot alter behaviour (for example a log message). Do not write a test. List it with the reason.
- **Dead code**: the code is unreachable or unneeded. List it so a human can remove it.

Rules:
- You may add or edit test files. You may not change production code or tool configuration.
- Never weaken an existing assertion. Never add tests that only call code to raise coverage.
- Run the changed tests once to confirm they pass.

Write `survivors.md`: a table of survivor, decision, test added or reason. A human reads this at Gate 2 for anything left unresolved.

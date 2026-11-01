This is a defect. The goal is the smallest correct fix, proven by a test that fails before the fix and passes after it. Do not refactor or add features.

## jira_reader
Extract: steps to reproduce, expected result, actual result, environment or version, error messages and stack traces, frequency, and workaround. Screenshots are evidence: describe what they show. If you cannot tell expected from actual behaviour, the ticket is ambiguous.

## spec_agent
Write the spec as: **Observed behaviour**, **Expected behaviour**, **Reproduction** (the smallest input or sequence that triggers it), and **Root cause hypothesis** (the file and method you believe is wrong, with evidence from the code or stack trace, and how confident you are). Then the usual Given/When/Then rules, where rule 1 is the failing scenario. Add rules for neighbouring cases that the same bug could affect (null, empty, boundary, other callers).

## planner
The plan is the minimal change at the root cause, not at the symptom. Name the fix location and why other callers stay correct. The test plan starts with the reproduction test, then regression tests for the neighbouring cases. Do not plan cleanups.

## test_author
The first test reproduces the bug through the public API or the smallest unit that shows it, and must fail on the current code for the same reason the ticket describes. Stubs are usually not needed because the code already exists. If you cannot make a test fail, say so in `red-notes.md` and return `fail`: the bug may not be reproducible or the root cause is elsewhere.

## test_reviewer
Check that the reproduction test fails for the reason in the ticket and not for an unrelated one. A test that passes today does not reproduce the bug.

## coder
Fix the root cause with the smallest change that turns the reproduction test green. Do not change behaviour outside the failing scenario.

## code_reviewer
Check that the fix addresses the root cause, not the symptom; that the change is minimal; that other callers of the changed code still behave; and that no unrelated edits slipped in.

## mr_agent
State the symptom, the root cause, the fix, and the test that proves it. Mention any related code that may have the same flaw but was not changed.

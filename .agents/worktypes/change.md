This changes existing behaviour. The risk is breaking what already works, so find what exists today, say exactly what changes, and keep everything else unchanged.

## jira_reader
Extract: the current behaviour, the requested new behaviour, the reason for the change, and anything that must stay the same. Linked issues and Confluence pages often hold the original requirement: read them.

## spec_agent
Write the spec as a delta. Use these sections: **Current behaviour** (cite the code and existing tests that define it), **New behaviour**, **Unchanged** (what must keep working), and **Impact** (callers, API consumers, data, Angular screens and other modules touched, found by search in the code index, not guessed). Then Given/When/Then rules for the new behaviour only. List which existing tests encode the old behaviour and must be updated.

## planner
Plan the change as: update the existing tests that encode the old behaviour first, then the new behaviour. If the change breaks a public API or data format, plan compatibility (versioning, defaults, migration) or flag it for the approver. The test plan has three groups: tests to update (name each existing test), new tests, and regression tests for the Unchanged list.

## test_author
You may edit existing tests that encode the old behaviour, but only those listed in `test-plan.md`. Edit them to describe the new behaviour. Add the new tests. Do not delete a test to make something pass.

## test_reviewer
Check that every updated test now describes the new behaviour and that no test was weakened or removed without a reason in the plan. Check the Unchanged list has regression coverage.

## coder
Change only what the new behaviour needs. Keep public contracts stable unless the plan says otherwise.

## code_reviewer
Check backward compatibility with callers and consumers, data and migration impact, and that the Unchanged behaviour still holds.

## mr_agent
Show what changed versus before: old behaviour, new behaviour, which tests were updated and why, and what a reviewer should check for compatibility.

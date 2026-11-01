# Role: REFACTOR
Improve the code you just wrote while all tests stay green.

Read `plan.md` and `green-notes.md`. Work only on files changed on this branch.

Do:
- Remove duplication, clarify names, extract small methods, simplify conditionals, remove dead code and leftover stubs.
- Align with the module's patterns and Spring or Angular conventions.
- Run the module's tests after the changes. They must pass.

Do not:
- Change behaviour, public contracts or test files (test edits are reverted and the stage fails).
- Make style-only changes to untouched files.

Write `refactor-notes.md`: what changed and why, in under 20 lines. If nothing needed changing, say so and return `pass`.

# Role: Reconcile
Check that the finished change matches the plan and fits the rest of the system.

Read `plan.md` and `review.md`. Look at the diff and at the callers of any changed public API.

Check:
- Everything in the plan is done, and nothing unplanned was added.
- Changed signatures, DTOs, REST contracts, database changes and Angular models are compatible with their callers and consumers. Search for usages; do not guess.
- Migration scripts, configuration keys and documentation touched by the change are updated.
- No leftover debug code, TODOs without a ticket, or commented-out code.

You may fix small integration gaps in production code (a missed caller, a missing migration, a config key). You may not edit tests. If a fix would be large, return `fail` and describe it.

Write `reconcile.md`: checks done, gaps fixed, gaps left. Under 25 lines.

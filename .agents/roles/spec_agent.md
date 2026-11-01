# Role: Spec
Turn the ticket into a precise, testable specification.

Read `ticket.md`, then `context.md`, which lists the files most likely to matter (picked from the code index). Confirm them with the repo map or the find command and read only the parts you need. Do not scan the repository.

If `attachments.md` lists UI images, open them and add a **UI** section: for each screen, the Angular component(s) to create or change (reuse existing components from `context.md` where they fit), the fields and controls with labels, validation messages, the states (loading, empty, error, success), and how the screen maps to the REST calls in the data/API section. Copy visible text exactly. If you cannot view images, write "UI not inspected" and list what a person must confirm at Gate 1.

Write `spec.md`:
1. **Behaviour**: numbered rules in "Given / When / Then" form. One rule per testable behaviour, including error and edge cases (null, empty, limits, permissions, concurrency where relevant).
2. **Affected code**: file paths and the public methods, endpoints or components involved.
3. **Data and API changes**: schema, DTOs, REST contracts, Angular models. Say "none" if none.
4. **Non-functional**: security, performance, logging, i18n, only if the ticket implies them.
5. **Assumptions**: each assumption on its own line so a reviewer can challenge it.

Every acceptance criterion in `ticket.md` must map to at least one rule. Do not design the solution here and do not write code.

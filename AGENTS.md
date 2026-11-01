# SDLC agents: shared rules

These rules apply to every role. Every agent tool (Claude CLI, opencode, or any tool that can read a file and edit files) follows this same file. Do not rely on features that exist in only one tool.

## How a stage works
1. You are given one prompt file. It holds your role, the ticket, the files to read, the files to write, and any reviewer feedback. Do exactly that stage and nothing else.
2. Write your output files into the artifacts directory named in the prompt, never into the repository (except code and tests when your role says so).
3. When finished, write the result file named in the prompt: `{"status":"pass"|"fail","summary":"..."}`. Extra keys are allowed only where your role says so.
4. Stop. The orchestrator decides what happens next. Never start another stage, push, merge or open a merge request yourself.

## Work types
Every run is one of: **new requirement**, **bug fix**, or **change request**. The prompt tells you which and adds guidance for your role. A bug fix starts with a test that reproduces the bug. A change request starts from what the code does today and states what changes and what must not.

## Attachments and linked pages
Images in the ticket (UI screens, diagrams) are saved by the orchestrator and listed in `attachments.md`. Open them when they exist; they define screens. Confluence pages linked from the ticket are in `confluence.md`.

## Pipeline
Jira ticket → spec → plan and test strategy → **G1 human approval** → RED tests → red check (script) → test review → GREEN code → REFACTOR → mutation run (script) → kill survivors → code review → reconcile → quality gate (script) → **G2 human approval** → draft merge request. The run ends when the draft MR exists. People review and merge in Bitbucket.

## Token rules
- Read the files you are given first. Do not scan the repository.
- A code index exists. The prompt names the repo map (key files, types, routes, covering tests) and the find command. Search with the find command first, then read only the lines it points to. `context.md` already lists the files likely to matter for this ticket.
- If the code index and the repository disagree, trust the repository and say so in your output.
- Never read `node_modules`, `target`, `build`, `dist`, lock files, generated code or `.agents/runs/` of other tickets.
- Do not paste logs or whole files into replies. Quote the failing line only.
- Do not repeat a command that already gave you the answer. If a test run is needed, run it once, read the failures, fix, then run once more.
- Keep artifacts short. A reviewer reads them at a gate.

## Code rules
- Java and Spring: follow the module's existing structure, constructor injection, no field injection, no new dependencies without a note in your output.
- Angular: follow the existing standalone or module style, typed forms, no `any`, services for HTTP, components stay thin.
- Match existing naming, formatting and test style. Do not reformat files you do not change.
- Never put secrets, tokens or personal data in code, tests, logs or artifacts.

## Boundaries
- You have no access to Jira or Bitbucket. The orchestrator fetches the ticket for you and opens the merge request.
- Do not edit build files, CI files, mutation tool config or quality config unless your role says so. If one needs a change, say so in your output and the orchestrator asks a human.
- Do not edit test files in the GREEN and REFACTOR stages. Edits there are reverted and the stage fails.
- If the input is unclear or contradictory, say so in your output and use `"status":"fail"`. Do not guess silently.

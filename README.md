# SDLC agents

A Jira ticket goes in, a **draft merge request** comes out. TDD-centred, with mutation testing and two human gates. The run stops when the draft MR exists.

Works for **new requirements, bug fixes and change requests** (picked from the Jira issue type, or set by hand). It reads Jira comments, **attachments (screenshots and mock-ups are shown to the model)** and linked Confluence pages, and it keeps a **code index** so agents read a compact repo map instead of the whole repository.

```
.agents/roles/*.md       one role per agent stage (tool-agnostic)
.agents/worktypes/*.md   what changes for feature / bug / change
AGENTS.md                rules every agent follows
server/                  Node.js service: pipeline, gates, MCP broker, code index, SQLite, REST + SSE
ui/                      Angular app: stage track, live trace, observability, gate approvals
config/                  example config + .env, sample tool map
server/rehearsal/        offline demo with fake Jira/Bitbucket and a scripted agent
```

## Rolling out: two files

Everything environment-specific is in two files in `config/`:

| File | Holds |
|---|---|
| `agents.config.json` | MCP servers, tool names, LLM tool and models, repos, git, work-type mapping, thresholds |
| `.env` | Secrets only: LLM key, MCP tokens, git token. Referenced from the JSON as `${env:NAME}` |

Moving to another team or environment means replacing those two files. Nothing else changes.

### Quick start

```bash
cd server && npm install && npm run build
cd ../ui && npm install && npx ng build && cd ../server

npm run cli -- init                          # creates config/agents.config.json and config/.env from the examples
# edit config/.env (LLM, MCP and git secrets) and the repos list in the JSON

npm run cli -- import-mcp ~/.mcp.json        # your existing MCP json -> servers in the config, tokens moved to .env
npm run cli -- discover-mcp --write          # asks the servers what tools they have and maps jira.*, confluence.*, bitbucket.*
npm run cli -- doctor                        # checks everything and says what to fix
npm start                                    # http://localhost:8080
```

`doctor` checks config, role files, the agent CLI, the model, git access, each repo, each MCP server and each mapped tool. Run it again after any change. The same report is in the UI under Setup.

Start a run from the UI (New run) or the API:

```bash
curl -X POST localhost:8080/api/runs -H 'content-type: application/json' -H 'x-user: you' \
  -d '{"ticket":"ABC-123","repo":"orders-service"}'      # optional: "workType":"bug"
```

Try it without any real system first: `sh server/rehearsal/run.sh` starts fake Jira and Bitbucket servers, a scripted agent and a local git remote, then prints the run command. Approve G1 and G2 in the UI at http://127.0.0.1:8085.

### Docker

```bash
cp config/env.example config/.env && cp config/agents.config.example.json config/agents.config.json   # edit both
docker compose up --build        # http://localhost:8080
```
Build args in `docker-compose.yml`: `INSTALL_JAVA=1` adds JDK and Maven (needed for PIT), `AGENT_CLI_PACKAGE` installs the agent CLI from npm. Data (SQLite, run folders) and checkouts are kept in `./data` and `./workspaces`.

## The pipeline

intake → spec → plan → **G1 (human: spec and test strategy)** → red (write failing tests) → red check → test review → green → refactor → mutation run → kill survivors → code review → reconcile → quality gate → **G2 (human: code)** → draft MR → end.

- **Work types:** `feature`, `bug` (reproduce with a failing test first, smallest fix), `change` (find the existing behaviour and its tests, change those first). `auto` reads the Jira issue type; the mapping is in `jira.workTypes`.
- **Attachments:** images are saved under the run folder and passed to the model when `llm.vision` is true. Use a vision-capable model for the spec and coder stages (`llm.stageModels`). Other files are saved and listed. Confluence links in the ticket are fetched and converted to markdown.
- **Mutation testing:** PIT for Maven/Gradle, StrykerJS for npm/Angular, picked from the repo. Threshold `quality.mutationThreshold` (default 70). Survivors are sent back to the coder, with a loop limit.
- **Guardrails:** loop limits on every fail edge, per-stage and per-run token budgets, a tool allowlist per stage, secrets masked in the trace, nothing pushed to the base branch, no repeated model call for facts a script can compute.
- **Code index:** built per repo on each run (only changed files are re-read), stored in `.agents/index/` inside the checkout (never committed). Agents get a token-budgeted repo map, a ticket-specific list of likely files with their tests, and a `find` command for the rest:
  `npm run cli -- find <term>` (the exact command is put in each prompt).

## Agent tool (Claude CLI, opencode, anything else)

`llm.runner` is `claude`, `opencode` or `custom`. The service writes one prompt file per stage and tells the tool to read it; the agent writes `results/<stage>.result.json`. The model is chosen per stage with `llm.stageModels`. `llm.env` is passed to the tool, which is where your internal gateway URL and key go (for example `ANTHROPIC_BASE_URL`, or the provider settings opencode needs; opencode's config is generated from `llm.opencode`).

## Git

`git.auth` gives the token for clone, fetch and push (`bearer` for Bitbucket HTTP access tokens, `basic` for username and token). Repos in `repos[]` are cloned into `git.workspacesDir` on first use and fetched afterwards. The token is sent as a header and never written to the remote URL or the trace.

## API

| | |
|---|---|
| GET /api/health, /api/doctor, /api/repos | status, setup checks, configured repos |
| GET /api/pipeline | stages and transitions (the UI draws from this) |
| POST /api/runs, GET /api/runs, GET /api/runs/:id | start, list, view |
| GET /api/runs/:id/events, /stream | trace events; SSE with `Last-Event-ID` resume |
| POST /api/runs/:id/gates/G1 or G2 | `{"decision":"approved"\|"rejected","comment":"..."}` (rejection needs a comment) |
| POST /api/runs/:id/retry, /cancel | continue a blocked run, stop a run |
| GET /api/runs/:id/artifacts[/name], /attachments/:name | spec, plan, reports, MR description, saved attachments |

## Tests

```bash
cd server && npm run typecheck && npm test
```

## Needs your input

1. **Your MCP json** (or just run `import-mcp` and `discover-mcp` yourself). Tool discovery matches names and arguments by meaning; check the result in `doctor` and fix any line by hand in `mcp.tools`.
2. **Agent CLI details:** the exact flags for your Claude CLI and opencode versions, and the model names exposed by your Qwen and Claude gateway. A vision-capable model is needed for screenshots and mock-ups.
3. **Git:** an HTTP access token and the list of repos.
4. **Approvers:** identified by the `x-user` header today. Put the service behind your SSO proxy that sets it, and set `server.requireUser`.
5. **Plugins** such as RTK, caveman-style output compression or an LSP/indexer need your security approval before they are enabled. None are installed.

## Known limits

- The code index is regex-based for Java and TypeScript. It is approximate, built for a compact map and search, not for refactoring.
- The Maven/PIT path is written but was not run end to end here; the npm/StrykerJS path was rehearsed with a stand-in for Stryker.
- The service runs one active run per repository checkout.

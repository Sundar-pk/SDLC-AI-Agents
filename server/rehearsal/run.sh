#!/bin/sh
# Rehearsal: runs one fake Jira bug (with a mock-up image and a Confluence page) through the whole pipeline
# using a fake MCP server pair, a scripted agent and a local git remote. No internet, no real accounts.
#   sh rehearsal/run.sh          then open http://127.0.0.1:8085 and approve G1 and G2.
set -e
HERE=$(cd "$(dirname "$0")" && pwd); SERVER=$(dirname "$HERE"); W=${REHEARSAL_DIR:-/tmp/sdlc-rehearsal}
rm -rf "$W"; mkdir -p "$W/cfg"; cd "$W"
cp -r "$HERE/seed" seed; (cd seed && git init -q -b main && git add -A && git -c user.name=t -c user.email=t@t commit -qm seed); git clone -q --bare seed remote.git
cat > cfg/agents.config.json <<J
{ "server": { "host": "127.0.0.1", "port": 8085, "dataDir": "./data" },
  "llm": { "runner": "custom", "model": "rehearsal-model", "vision": true, "timeoutMinutes": 2,
           "custom": { "command": "node", "args": ["$HERE/fake-agent.mjs", "{instruction}", "{model}"], "parser": "text" } },
  "git": { "workspacesDir": "./ws" },
  "repos": [ { "name": "cart-service", "project": "SHOP", "url": "file://$W/remote.git", "baseBranch": "main" } ] }
J
cat > user-mcp.json <<J
{ "mcpServers": {
  "atlassian": { "type": "http", "url": "http://127.0.0.1:9301/mcp", "headers": { "Authorization": "Bearer demo-token" } },
  "scm":       { "type": "http", "url": "http://127.0.0.1:9302/mcp", "headers": { "Authorization": "Bearer demo-token" } } } }
J
: > mcp-calls.jsonl
node "$HERE/fake-mcp.mjs" 9301 "$W/mcp-calls.jsonl" atlassian > mcp1.log 2>&1 & echo $! > mcp1.pid
node "$HERE/fake-mcp.mjs" 9302 "$W/mcp-calls.jsonl" scm > mcp2.log 2>&1 & echo $! > mcp2.pid
sleep 1
export AGENTS_CONFIG="$W/cfg/agents.config.json" PATH="$HERE/bin:$PATH"
cd "$SERVER"; [ -f dist/cli.js ] || npm run build
echo "== your MCP json -> config"; node dist/cli.js import-mcp "$W/user-mcp.json"
echo "== discover tool names";     node dist/cli.js discover-mcp --write
echo "== doctor";                  node dist/cli.js doctor || true
echo; echo "Starting the service. Start a run with:"
echo "  curl -X POST localhost:8085/api/runs -H 'content-type: application/json' -H 'x-user: you' -d '{\"ticket\":\"ABC-1\",\"repo\":\"cart-service\"}'"
echo "Then open http://127.0.0.1:8085 . Stop with Ctrl+C (fake MCP servers: kill \$(cat $W/mcp*.pid))."
exec node dist/main.js

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp } from './api.js';
import { ToolBroker } from './broker.js';
import { ConfigError, loadConfig } from './config.js';
import { Store } from './db.js';
import { runDoctor } from './doctor.js';
import { Trace } from './events.js';
import { ShellGit } from './git.js';
import { indexDir } from './indexer/index.js';
import { createHttpMcpCaller, type McpCaller } from './mcp-client.js';
import { Orchestrator } from './orchestrator.js';
import { spawnCapture } from './proc.js';
import { createRunner } from './runners/command-runner.js';
import { buildHandlers } from './stages.js';

async function main(): Promise<void> {
  let config;
  try { config = loadConfig(); }
  catch (e) {
    if (e instanceof ConfigError) { console.error(`Configuration problem: ${e.message}`); process.exit(1); }
    throw e;
  }
  mkdirSync(config.dataDir, { recursive: true });

  const store = new Store(config.dbPath);
  const trace = new Trace(store);
  const git = new ShellGit({ name: config.git.authorName, email: config.git.authorEmail }, spawnCapture, config.git.auth);
  const callers: Record<string, McpCaller> = Object.fromEntries(
    Object.entries(config.mcp.servers).map(([name, s]) => [name, createHttpMcpCaller({ url: s.url, token: s.token, headers: s.headers })]),
  );
  const broker = new ToolBroker({ callers, tools: config.mcp.tools, trace });
  const runner = createRunner(config.runner, spawnCapture, config.dataDir);

  // Agents search the code index through this command, run from inside the repository.
  const dist = join(config.rootDir, 'server', 'dist', 'cli.js');
  const findCommand = existsSync(dist) ? `node ${dist} find` : `npx tsx ${join(config.rootDir, 'server', 'src', 'cli.ts')} find`;
  const handlers = buildHandlers({
    runner, broker, git, exec: spawnCapture, config, store,
    navigation: { repoMap: (ws) => join(indexDir(ws), 'repo-map.md'), findCommand },
  });
  const orchestrator = new Orchestrator({ store, trace, git, handlers, repos: config.repos });

  const app = buildApp({ config, store, trace, orchestrator, doctor: () => runDoctor(config, { git }) });
  await app.listen({ host: config.host, port: config.port });
  console.log(`SDLC agents on http://${config.host}:${config.port}  (agent tool: ${config.runner.kind}, MCP servers: ${Object.keys(callers).join(', ') || 'none'})`);
  if (!config.configFile) console.log('No config/agents.config.json found. Run "npm run cli -- init" to create one.');
  orchestrator.resumePending();

  const shutdown = async () => {
    await app.close();
    await Promise.all(Object.values(callers).map((c) => c.close().catch(() => {})));
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

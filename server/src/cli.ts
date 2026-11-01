#!/usr/bin/env node
import { copyFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ConfigError, loadConfig, parseDotenv, ROOT_DIR } from './config.js';
import { runDoctor, summarize } from './doctor.js';
import { ShellGit } from './git.js';
import { buildIndex, loadIndex } from './indexer/index.js';
import { findInIndex, grepText } from './indexer/render.js';
import { createHttpMcpCaller, type McpToolInfo } from './mcp-client.js';
import { importMcpJson, proposeToolMap } from './mcp-setup.js';

const HELP = `2S IT SDLC agents: command line

  find <term>            Search symbols and files in the current repository (used by the agents)
  index [dir]            Build or refresh the code index for a repository
  doctor                 Check config, agent tool, git, MCP servers and tool mapping
  init                   Create config/agents.config.json and config/.env from the examples
  import-mcp <file>      Add MCP servers from a .mcp.json file (secrets go to config/.env)
  discover-mcp [--write] List the tools on your MCP servers and propose the tool mapping

Options: --config <file>   use another config file
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function configPath(args: string[]): string {
  return resolve(flag(args, '--config') ?? process.env.AGENTS_CONFIG ?? join(ROOT_DIR, 'config', 'agents.config.json'));
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const positional = rest.filter((a, i) => !a.startsWith('--') && rest[i - 1] !== '--config');

  if (!cmd || cmd === 'help' || cmd === '--help') { console.log(HELP); return 0; }

  if (cmd === 'find') {
    const q = positional.join(' ').trim();
    if (!q) { console.error('Usage: find <term>'); return 2; }
    const ws = process.cwd();
    const index = loadIndex(ws) ?? buildIndex(ws).index;
    const rows = findInIndex(index, q);
    console.log(rows.length ? rows.join('\n') : `No symbol or file matches "${q}".`);
    const text = grepText(ws, q, 12);
    if (text.length) console.log(`\nText matches:\n${text.join('\n')}`);
    return 0;
  }

  if (cmd === 'index') {
    const ws = resolve(positional[0] ?? process.cwd());
    const { stats } = buildIndex(ws);
    console.log(`Indexed ${stats.total} files (${stats.reparsed} parsed, ${stats.reused} reused, ${stats.removed} removed) in ${stats.ms} ms`);
    return 0;
  }

  if (cmd === 'init') {
    const dir = join(ROOT_DIR, 'config');
    mkdirSync(dir, { recursive: true });
    for (const [from, to] of [['agents.config.example.json', 'agents.config.json'], ['env.example', '.env']] as const) {
      const dest = join(dir, to);
      if (existsSync(dest)) console.log(`kept   ${dest}`);
      else { copyFileSync(join(dir, from), dest); console.log(`wrote  ${dest}`); }
    }
    console.log('\nNext: fill in config/.env, then run: npm run cli -- doctor');
    return 0;
  }

  if (cmd === 'import-mcp') {
    const file = positional[0];
    if (!file) { console.error('Usage: import-mcp <path to .mcp.json>'); return 2; }
    const imported = importMcpJson(JSON.parse(readFileSync(resolve(file), 'utf8')));
    const cfgFile = configPath(rest);
    const cfg = existsSync(cfgFile) ? JSON.parse(readFileSync(cfgFile, 'utf8')) : {};
    cfg.mcp = { ...(cfg.mcp ?? {}), servers: { ...(cfg.mcp?.servers ?? {}), ...imported.servers }, tools: cfg.mcp?.tools ?? {} };
    mkdirSync(dirname(cfgFile), { recursive: true });
    writeFileSync(cfgFile, `${JSON.stringify(cfg, null, 2)}\n`);
    const envFile = join(dirname(cfgFile), '.env');
    const existing = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
    const have = parseDotenv(existing);
    const add = Object.entries(imported.env).filter(([k]) => !(k in have)).map(([k, v]) => `${k}=${v}`);
    if (add.length) writeFileSync(envFile, `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${add.join('\n')}\n`, { mode: 0o600 });
    console.log(`Added ${Object.keys(imported.servers).length} server(s) to ${cfgFile}: ${Object.keys(imported.servers).join(', ') || 'none'}`);
    if (add.length) console.log(`Moved ${add.length} secret(s) into ${envFile} (referenced as \${env:NAME} in the config)`);
    for (const s of imported.skipped) console.log(`Skipped ${s}`);
    console.log('\nNext: npm run cli -- discover-mcp --write');
    return 0;
  }

  if (cmd === 'discover-mcp') {
    const config = loadConfig(process.env, { file: existsSync(configPath(rest)) ? configPath(rest) : undefined });
    const listed: Record<string, McpToolInfo[]> = {};
    for (const [name, s] of Object.entries(config.mcp.servers)) {
      const c = createHttpMcpCaller({ url: s.url, token: s.token, headers: s.headers });
      try { listed[name] = await c.listTools(); console.log(`${name}: ${listed[name]!.length} tools`); }
      catch (e) { console.error(`${name}: cannot connect (${e instanceof Error ? e.message : String(e)})`); }
      finally { await c.close().catch(() => {}); }
    }
    if (!Object.keys(listed).length) { console.error('No MCP server could be reached.'); return 1; }
    const p = proposeToolMap(listed);
    console.log('');
    for (const r of p.report) {
      const mark = r.picked ? (r.unmatchedArgs.length ? '!' : '✓') : r.required ? '✗' : '-';
      console.log(`${mark} ${r.logical.padEnd(32)} ${r.picked ?? '(no match)'}${r.unmatchedArgs.length ? `   check args: ${r.unmatchedArgs.join(', ')}` : ''}${!r.picked && r.alternatives.length ? `   maybe: ${r.alternatives.join(', ')}` : ''}`);
    }
    if (rest.includes('--write')) {
      const cfgFile = configPath(rest);
      const cfg = existsSync(cfgFile) ? JSON.parse(readFileSync(cfgFile, 'utf8')) : {};
      cfg.mcp = { ...(cfg.mcp ?? {}), tools: { ...p.tools, ...(cfg.mcp?.tools ?? {}) } };
      writeFileSync(cfgFile, `${JSON.stringify(cfg, null, 2)}\n`);
      console.log(`\nWrote mapping to ${cfgFile} (your existing entries were kept). Review it, then run: doctor`);
    } else console.log('\nRun again with --write to save this into the config.');
    return 0;
  }

  if (cmd === 'doctor') {
    let config;
    try { config = loadConfig(process.env, { file: existsSync(configPath(rest)) ? configPath(rest) : undefined }); }
    catch (e) { console.error(e instanceof ConfigError ? e.message : String(e)); return 1; }
    const git = new ShellGit({ name: config.git.authorName, email: config.git.authorEmail }, undefined, config.git.auth);
    const checks = await runDoctor(config, { git });
    let group = '';
    for (const c of checks) {
      if (c.group !== group) { group = c.group; console.log(`\n${group}`); }
      console.log(`  ${c.status === 'ok' ? '✓' : c.status === 'warn' ? '!' : '✗'} ${c.name.padEnd(32)} ${c.detail}`);
      if (c.fix && c.status !== 'ok') console.log(`      → ${c.fix}`);
    }
    const s = summarize(checks);
    console.log(`\n${s.ok} ok, ${s.warn} warnings, ${s.fail} failed`);
    return s.fail ? 1 : 0;
  }

  console.error(`Unknown command: ${cmd}\n\n${HELP}`);
  return 2;
}

main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

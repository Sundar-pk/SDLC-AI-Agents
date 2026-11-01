import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
const PORT = Number(process.argv[2]), LOG = process.argv[3], NAME = process.argv[4];
// 1x1 PNG
import { readFileSync } from 'node:fs';
const PNG = readFileSync(new URL('./mockup.png', import.meta.url)).toString('base64');
const log = (o) => appendFileSync(LOG, JSON.stringify({ server: NAME, ...o }) + '\n');
const txt = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }] });
function build() {
  const s = new McpServer({ name: NAME, version: '1' });
  const t = (name, shape, fn, desc) => s.tool(name, desc, shape, async (a) => { log({ tool: name, args: a }); return fn(a); });
  if (NAME === 'atlassian') {
    t('jira_get_issue', { issue_key: z.string() }, (a) => txt({ key: a.issue_key, fields: { summary: 'Cart total ignores the discount code', issuetype: { name: 'Bug' }, status: { name: 'Open' },
      description: 'Steps: add 2 items at 10 EUR, apply a 10% discount. Expected total 18 EUR. Actual 20 EUR. See the screenshot and https://wiki.example.com/spaces/SHOP/pages/55555/Pricing-rules' } }), 'Get a Jira issue');
    t('jira_get_issue_comments', { issue_key: z.string() }, () => txt([{ author: 'qa', body: 'Reproduced on staging.' }]), 'Get Jira issue comments');
    t('jira_list_attachments', { issue_key: z.string() }, () => txt([{ id: '10001', filename: 'cart-screen.png', mimeType: 'image/png', size: 4000 }]), 'List Jira attachments');
    t('jira_download_attachment', { attachment_id: z.string() }, () => ({ content: [{ type: 'image', data: PNG, mimeType: 'image/png' }] }), 'Download a Jira attachment');
    t('jira_get_issue_links', { issue_key: z.string() }, () => txt([]), 'Linked Jira issues');
    t('jira_add_comment', { issue_key: z.string(), comment: z.string() }, () => txt('ok'), 'Add a comment to a Jira issue');
    t('jira_search', { jql: z.string() }, () => txt([]), 'Search Jira issues');
    t('confluence_get_page', { page_id: z.string() }, (a) => txt({ title: 'Pricing rules', body: { storage: { value: '<p>Discounts are applied to the subtotal before tax. Percent is 0 to 100.</p>' } } }), 'Get a Confluence page');
  } else {
    t('bitbucket_create_pull_request', { project_key: z.string(), repo_slug: z.string(), title: z.string(), description: z.string(), source_branch: z.string(), destination_branch: z.string(), is_draft: z.boolean().optional() },
      (a) => txt({ id: 42, links: { html: { href: `https://bitbucket.example.com/projects/${a.project_key}/repos/${a.repo_slug}/pull-requests/42` } } }), 'Create a Bitbucket pull request');
    t('bitbucket_get_pull_request_diff', { project_key: z.string(), repo_slug: z.string(), pr_id: z.string() }, () => txt(''), 'Bitbucket pull request diff');
  }
  return s;
}
createServer(async (req, res) => {
  const server = build();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport);
  let body = ''; for await (const c of req) body += c;
  await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
}).listen(PORT, '127.0.0.1', () => console.log(`${NAME} mcp on ${PORT}`));

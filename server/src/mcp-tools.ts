/** The tools the pipeline needs, by logical name, and what each one takes. */
export interface LogicalTool {
  name: string;
  required: boolean;
  purpose: string;
  /** Logical argument names the service sends. */
  args: string[];
  /** Arguments that must exist on the real tool (the rest are optional). */
  mustHave: string[];
}

export const LOGICAL_TOOLS: LogicalTool[] = [
  { name: 'jira.get_issue', required: true, purpose: 'Read the ticket', args: ['issueKey'], mustHave: ['issueKey'] },
  { name: 'jira.get_comments', required: false, purpose: 'Read ticket comments', args: ['issueKey'], mustHave: ['issueKey'] },
  { name: 'jira.get_attachments', required: false, purpose: 'List attachments (mock-ups, screenshots)', args: ['issueKey'], mustHave: ['issueKey'] },
  { name: 'jira.download_attachment', required: false, purpose: 'Download an attachment', args: ['issueKey', 'attachmentId', 'filename'], mustHave: ['attachmentId'] },
  { name: 'jira.get_linked_issues', required: false, purpose: 'Read linked issues', args: ['issueKey'], mustHave: ['issueKey'] },
  { name: 'jira.add_comment', required: true, purpose: 'Ask the reporter when a ticket is ambiguous', args: ['issueKey', 'body'], mustHave: ['issueKey', 'body'] },
  { name: 'confluence.get_page', required: false, purpose: 'Read linked Confluence pages', args: ['pageId'], mustHave: ['pageId'] },
  { name: 'bitbucket.get_diff', required: false, purpose: 'Read a diff', args: ['project', 'repo', 'fromBranch', 'toBranch'], mustHave: [] },
  {
    name: 'bitbucket.create_pull_request', required: true, purpose: 'Open the draft merge request',
    args: ['project', 'repo', 'title', 'description', 'fromBranch', 'toBranch', 'draft'],
    mustHave: ['title', 'fromBranch', 'toBranch'],
  },
];

/** Words that mean the same thing in tool and argument names. */
const SYNONYMS: Record<string, string[]> = {
  issuekey: ['issuekey', 'issue_key', 'issueidorkey', 'issueidorkey', 'key', 'issue', 'issueid', 'ticket', 'ticketkey'],
  attachmentid: ['attachmentid', 'attachment_id', 'attachment', 'fileid', 'id'],
  filename: ['filename', 'file_name', 'name'],
  body: ['body', 'comment', 'text', 'content', 'message'],
  pageid: ['pageid', 'page_id', 'page', 'id', 'contentid'],
  project: ['project', 'projectkey', 'project_key', 'workspace', 'owner'],
  repo: ['repo', 'repository', 'reposlug', 'repo_slug', 'slug', 'repositoryslug'],
  title: ['title', 'name', 'summary'],
  description: ['description', 'body', 'text'],
  frombranch: ['frombranch', 'source', 'sourcebranch', 'source_branch', 'from', 'head', 'fromref'],
  tobranch: ['tobranch', 'destination', 'destinationbranch', 'destination_branch', 'target', 'targetbranch', 'target_branch', 'to', 'base', 'toref'],
  draft: ['draft', 'isdraft', 'is_draft', 'wip'],
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Finds the real parameter name that a logical argument most likely corresponds to. */
export function matchParam(logical: string, params: string[]): string | undefined {
  const syn = SYNONYMS[logical.toLowerCase()] ?? [logical];
  const byNorm = new Map(params.map((p) => [norm(p), p]));
  for (const s of syn) {
    const hit = byNorm.get(norm(s));
    if (hit) return hit;
  }
  return undefined;
}

const WORD_SYNONYMS: Record<string, string[]> = {
  linked: ['link', 'links', 'linked', 'related', 'relation'],
  attachments: ['attachment', 'attachments', 'files'],
  download: ['download', 'content', 'fetch', 'read'],
  pull: ['pull', 'pr'],
  request: ['request', 'pr'],
  diff: ['diff', 'changes', 'patch'],
  page: ['page', 'content'],
  add: ['add', 'create', 'post', 'write'],
  get: ['get', 'read', 'fetch', 'view', 'retrieve'],
  create: ['create', 'open', 'new'],
};

const words = (s: string) =>
  s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map((w) => w.replace(/s$/, ''));

export interface ToolCandidate {
  server: string;
  tool: string;
  params: string[];
  description?: string;
}

const VERBS = new Set(['get', 'add', 'create', 'download', 'list', 'read', 'fetch', 'search', 'post', 'update', 'delete', 'open', 'write', 'view', 'retrieve']);

/** Scores how well a real tool fits a logical one. 0 means unrelated. Nouns matter more than verbs. */
export function scoreTool(logical: string, c: ToolCandidate): number {
  const [domain, action] = logical.split('.') as [string, string];
  const want = words(action);
  const have = new Set(words(c.tool));
  const hay = `${c.server} ${c.tool} ${c.description ?? ''}`.toLowerCase();
  if (!hay.includes(domain === 'bitbucket' ? 'bitbucket' : domain) && !(domain === 'bitbucket' && /pull|repo|git/.test(hay))) return 0;
  const alt = (w: string) => (WORD_SYNONYMS[w] ?? [w]).map((a) => a.replace(/s$/, ''));
  let score = 0;
  let nounMiss = 0;
  for (const w of want) {
    const isVerb = VERBS.has(w);
    if (have.has(w)) score += isVerb ? 1 : 3;
    else if (alt(w).some((a) => have.has(a))) score += isVerb ? 0.7 : 2;
    else if (isVerb && (w === 'get' ? have.has('list') : false)) score += 0.5;
    else if (!isVerb) nounMiss++;
  }
  if (have.has(domain)) score += 1;
  const wantedAlts = new Set(want.flatMap((w) => [w, ...alt(w)]));
  const extra = [...have].filter((w) => w !== domain && !wantedAlts.has(w) && !VERBS.has(w));
  score -= extra.length * 0.8;
  if (nounMiss) score *= 0.3;
  return Math.max(0, score);
}

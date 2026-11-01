import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { ToolBroker } from './broker.js';
import type { AppConfig } from './config.js';
import type { WorkType } from './db.js';
import type { ToolResult } from './mcp-client.js';

type Json = Record<string, any>;

const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

export function issueSummary(issue: unknown): string | undefined {
  const i = obj(issue);
  return str(obj(i.fields).summary) ?? str(i.summary) ?? str(i.title);
}

export function issueTypeName(issue: unknown): string | undefined {
  const i = obj(issue);
  const f = obj(i.fields);
  const t = f.issuetype ?? f.issueType ?? i.issuetype ?? i.issueType ?? i.type;
  return typeof t === 'string' ? t : str(obj(t).name);
}

/** Maps the Jira issue type to a work type using the names in the config. Anything unknown is a feature. */
export function detectWorkType(issue: unknown, cfg: AppConfig['jira']['workTypes']): Exclude<WorkType, 'auto'> {
  const name = issueTypeName(issue)?.toLowerCase();
  if (!name) return 'feature';
  if (cfg.bug.some((b) => b.toLowerCase() === name)) return 'bug';
  if (cfg.change.some((c) => c.toLowerCase() === name)) return 'change';
  return 'feature';
}

export interface Attachment {
  id: string;
  filename: string;
  mime: string;
  size?: number;
  kind: 'image' | 'document' | 'other';
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const DOC_EXT = new Set(['.pdf', '.txt', '.md', '.json', '.csv', '.xml', '.html', '.yml', '.yaml', '.log', '.sql']);

export function classify(filename: string, mime: string): Attachment['kind'] {
  const ext = extname(filename).toLowerCase();
  if (mime.startsWith('image/') && mime !== 'image/svg+xml') return 'image';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (mime === 'application/pdf' || mime.startsWith('text/') || DOC_EXT.has(ext)) return 'document';
  return 'other';
}

/** Accepts the attachment list in the shapes Jira MCP servers commonly return. */
export function normalizeAttachments(listResult: unknown, issue: unknown): Attachment[] {
  let raw: unknown = listResult;
  if (!Array.isArray(raw)) raw = obj(raw).attachments ?? obj(raw).values ?? obj(raw).items;
  if (!Array.isArray(raw) || raw.length === 0) raw = obj(obj(issue).fields).attachment ?? obj(issue).attachments;
  if (!Array.isArray(raw)) return [];
  const out: Attachment[] = [];
  for (const r of raw) {
    const a = obj(r);
    const id = a.id ?? a.attachmentId;
    const filename = str(a.filename) ?? str(a.fileName) ?? str(a.name);
    if (id === undefined || !filename) continue;
    const mime = str(a.mimeType) ?? str(a.contentType) ?? str(a.mime) ?? 'application/octet-stream';
    out.push({ id: String(id), filename, mime, size: typeof a.size === 'number' ? a.size : undefined, kind: classify(filename, mime) });
  }
  return out;
}

const B64 = /^[A-Za-z0-9+/=\r\n]+$/;

/** Finds the file bytes in an MCP result: image content, embedded resource blob, or base64 in text/JSON. */
export function extractBinary(res: ToolResult): { data: Buffer; mime?: string } | null {
  for (const c of res.content ?? []) {
    if ((c.type === 'image' || c.type === 'audio') && c.data) return { data: Buffer.from(c.data, 'base64'), mime: c.mimeType };
    if (c.type === 'resource' && c.resource?.blob) return { data: Buffer.from(c.resource.blob, 'base64'), mime: c.resource.mimeType };
  }
  const sc = obj(res.structuredContent);
  const sb = str(sc.data) ?? str(sc.content) ?? str(sc.base64) ?? str(sc.blob);
  if (sb && B64.test(sb)) return { data: Buffer.from(sb, 'base64'), mime: str(sc.mimeType) };
  for (const c of res.content ?? []) {
    if (c.type !== 'text' || !c.text) continue;
    let t = c.text.trim();
    let mime: string | undefined;
    if (t.startsWith('{')) {
      try {
        const j = obj(JSON.parse(t));
        t = str(j.data) ?? str(j.content) ?? str(j.base64) ?? str(j.blob) ?? '';
        mime = str(j.mimeType) ?? str(j.contentType);
      } catch { /* not JSON */ }
    }
    t = t.replace(/^data:[^;]+;base64,/, '');
    if (t.length > 100 && B64.test(t)) return { data: Buffer.from(t, 'base64'), mime };
  }
  return null;
}

export interface SavedAttachment extends Attachment {
  path?: string;
  bytes?: number;
  skipped?: string;
}

export async function saveAttachments(
  broker: ToolBroker, runId: string, issueKey: string, list: Attachment[], runDir: string, limits: AppConfig['attachments'],
): Promise<SavedAttachment[]> {
  const dir = join(runDir, 'attachments');
  mkdirSync(dir, { recursive: true });
  const out: SavedAttachment[] = [];
  let downloaded = 0;
  for (const a of list) {
    if (a.kind === 'other') { out.push({ ...a, skipped: 'file type is not useful for the agents' }); continue; }
    if (downloaded >= limits.maxCount) { out.push({ ...a, skipped: `limit of ${limits.maxCount} files reached` }); continue; }
    if (a.size !== undefined && a.size > limits.maxBytes) { out.push({ ...a, skipped: `larger than ${Math.round(limits.maxBytes / 1024)} KB` }); continue; }
    try {
      const res = await broker.callRaw(runId, 'intake', 'jira.download_attachment', { issueKey, attachmentId: a.id, filename: a.filename });
      const bin = extractBinary(res);
      if (!bin) { out.push({ ...a, skipped: 'the MCP server returned no file content' }); continue; }
      if (bin.data.length > limits.maxBytes) { out.push({ ...a, skipped: 'downloaded file is too large' }); continue; }
      const safe = `${a.id}-${basename(a.filename).replace(/[^\w.-]/g, '_')}`;
      const path = join(dir, safe);
      writeFileSync(path, bin.data);
      downloaded++;
      out.push({ ...a, path, bytes: bin.data.length });
    } catch (e) {
      out.push({ ...a, skipped: `download failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  return out;
}

export function attachmentsMarkdown(saved: SavedAttachment[], vision: boolean): string {
  if (!saved.length) return '# Attachments\n\nThis ticket has no attachments.\n';
  const ok = saved.filter((s) => s.path);
  const lines = ['# Attachments', ''];
  if (ok.length) {
    lines.push('| File (absolute path) | Kind | Size |', '|---|---|---|');
    for (const s of ok) lines.push(`| ${s.path} | ${s.kind} | ${Math.round((s.bytes ?? 0) / 1024)} KB |`);
    if (ok.some((s) => s.kind === 'image')) {
      lines.push('', vision
        ? 'Images are UI screens or diagrams from the ticket. Open each one and describe what it shows before you rely on it.'
        : 'The configured model cannot view images. Do not guess what they show; mark them as "not inspected".');
    }
  }
  const skipped = saved.filter((s) => !s.path);
  if (skipped.length) {
    lines.push('', '## Not downloaded');
    for (const s of skipped) lines.push(`- ${s.filename}: ${s.skipped}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Confluence page ids mentioned in the ticket text (page URLs and pageId= links). */
export function confluencePageIds(text: string, max = 5): string[] {
  const ids = new Set<string>();
  for (const m of text.matchAll(/\/pages\/(\d{4,})/g)) ids.add(m[1]!);
  for (const m of text.matchAll(/[?&]pageId=(\d{4,})/g)) ids.add(m[1]!);
  for (const m of text.matchAll(/\/pages\/viewpage\.action\?[^\s"')]*pageId=(\d{4,})/g)) ids.add(m[1]!);
  return [...ids].slice(0, max);
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|div|h\d|li|tr|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function pageToMarkdown(id: string, page: unknown, maxChars = 20_000): string {
  if (typeof page === 'string') return `## Page ${id}\n\n${htmlToText(page).slice(0, maxChars)}\n`;
  const p = obj(page);
  const title = str(p.title) ?? `Page ${id}`;
  const body = obj(p.body);
  const content =
    str(obj(body.storage).value) ?? str(obj(body.view).value) ?? str(p.markdown) ?? str(p.content) ?? str(p.text) ?? str(p.body) ?? JSON.stringify(page);
  return `## ${title} (page ${id})\n\n${htmlToText(content).slice(0, maxChars)}\n`;
}

export function textOf(value: unknown, depth = 0): string {
  if (typeof value === 'string') return value;
  if (depth > 6 || !value || typeof value !== 'object') return '';
  return Object.values(value as object).map((v) => textOf(v, depth + 1)).join('\n');
}

import { describe, expect, it } from 'vitest';
import { classify, confluencePageIds, detectWorkType, extractBinary, htmlToText, issueTypeName, normalizeAttachments, pageToMarkdown } from '../src/intake.js';

const wt = { bug: ['Bug', 'Defect'], change: ['Change Request', 'Improvement'] };
const PNG = Buffer.from('89504e470d0a1a0a' + '00'.repeat(200), 'hex');

describe('intake helpers', () => {
  it('detects work type from the Jira issue type in common shapes', () => {
    expect(detectWorkType({ fields: { issuetype: { name: 'Bug' } } }, wt)).toBe('bug');
    expect(detectWorkType({ issueType: 'change request' }, wt)).toBe('change');
    expect(detectWorkType({ type: { name: 'Story' } }, wt)).toBe('feature');
    expect(detectWorkType({}, wt)).toBe('feature');
    expect(issueTypeName({ fields: { issuetype: { name: 'Task' } } })).toBe('Task');
  });
  it('normalizes attachment lists from several shapes and falls back to the issue', () => {
    const a = normalizeAttachments([{ id: 1, filename: 'login.png', mimeType: 'image/png', size: 100 }, { attachmentId: '2', name: 'spec.pdf', contentType: 'application/pdf' }, { id: 3, filename: 'x.zip', mimeType: 'application/zip' }], {});
    expect(a.map((x) => [x.id, x.kind])).toEqual([['1', 'image'], ['2', 'document'], ['3', 'other']]);
    expect(normalizeAttachments({ attachments: [{ id: 9, fileName: 'a.JPG' }] }, {})[0]).toMatchObject({ id: '9', kind: 'image' });
    expect(normalizeAttachments('no list', { fields: { attachment: [{ id: 5, filename: 'm.png', mimeType: 'image/png' }] } })).toHaveLength(1);
    expect(classify('a.svg', 'image/svg+xml')).toBe('other');
  });
  it('extracts binary from image content, resource blobs, JSON and raw base64', () => {
    const b64 = PNG.toString('base64');
    expect(extractBinary({ content: [{ type: 'image', data: b64, mimeType: 'image/png' }] })!.data.equals(PNG)).toBe(true);
    expect(extractBinary({ content: [{ type: 'resource', resource: { blob: b64, mimeType: 'image/png' } }] })!.data.equals(PNG)).toBe(true);
    expect(extractBinary({ content: [{ type: 'text', text: JSON.stringify({ content: b64, mimeType: 'image/png' }) }] })!.data.equals(PNG)).toBe(true);
    expect(extractBinary({ content: [{ type: 'text', text: `data:image/png;base64,${b64}` }] })!.data.equals(PNG)).toBe(true);
    expect(extractBinary({ content: [{ type: 'text', text: 'Attachment not found' }] })).toBeNull();
  });
  it('finds Confluence page ids in urls', () => {
    const t = 'See https://wiki.x/spaces/SHOP/pages/123456/Checkout and https://wiki.x/pages/viewpage.action?pageId=7890123 and /pages/123456 again';
    expect(confluencePageIds(t)).toEqual(['123456', '7890123']);
  });
  it('turns Confluence html into text', () => {
    expect(htmlToText('<h1>T</h1><p>a &amp; b</p><script>x()</script>')).toBe('T\na & b');
    expect(pageToMarkdown('1', { title: 'Rules', body: { storage: { value: '<p>Max 5 items</p>' } } })).toContain('Max 5 items');
  });
});

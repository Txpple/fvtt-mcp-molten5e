import { describe, it, expect, vi, afterEach } from 'vitest';
import { writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatTools } from './chat.js';
import { makeFoundry, makeLogger } from './test-helpers.js';

function build(response: any = {}) {
  const { foundry, calls } = makeFoundry(response);
  const tools = new ChatTools({ foundry, logger: makeLogger() });
  return { tools, calls, foundry };
}

/** A WebDAV client stand-in (no network). */
function fakeDav(overrides: Record<string, any> = {}) {
  return {
    exists: vi.fn(async () => false),
    ensureParents: vi.fn(async () => {}),
    putFile: vi.fn(async () => {}),
    ...overrides,
  };
}

const tmpFiles: string[] = [];
function tmpFile(name: string): string {
  const p = join(tmpdir(), `mcp-chat-test-${name}`);
  tmpFiles.push(p);
  return p;
}
afterEach(async () => {
  await Promise.all(tmpFiles.splice(0).map(p => rm(p, { force: true })));
});

describe('send-chat-message', () => {
  it('forwards parsed args to postChatMessage and formats the result', async () => {
    const { tools, calls } = build({
      id: 'c1',
      alias: 'GM',
      visibility: 'public',
      whisperCount: 0,
    });
    const out = await tools.handleSendChatMessage({
      content: '<p>The winter is coming.</p>',
      visibility: 'public',
    });
    expect(calls[0][0]).toBe('postChatMessage');
    expect(calls[0][1]).toMatchObject({
      content: '<p>The winter is coming.</p>',
      visibility: 'public',
      enrich: true,
    });
    expect(out).toContain('Posted chat message c1');
    expect(out).toContain('public');
  });

  it('rejects empty content (zod)', async () => {
    const { tools } = build();
    await expect(tools.handleSendChatMessage({ content: '' })).rejects.toThrow();
  });

  it('embeds an https image URL directly (no upload)', async () => {
    const { tools, calls } = build({
      id: 'c2',
      alias: 'GM',
      visibility: 'public',
      whisperCount: 0,
    });
    await tools.handleSendChatMessage({
      content: '<p>Behold.</p>',
      images: [{ path: 'https://example.com/x.png', caption: 'A map' }],
    });
    const forwarded = calls[0][1].content as string;
    expect(forwarded).toContain('<img src="https://example.com/x.png"');
    expect(forwarded).toContain('<figcaption>A map</figcaption>');
  });

  it('uploads a local image over WebDAV and embeds its public URL', async () => {
    const { tools, calls } = build({
      id: 'c3',
      alias: 'GM',
      visibility: 'public',
      whisperCount: 0,
    });
    const dav = fakeDav();
    (tools as any).davClient = dav;
    (tools as any).molten = { ...(tools as any).molten, serverUrl: 'https://srv' };

    const img = tmpFile('pic.webp');
    await writeFile(img, Buffer.from([1, 2, 3]));

    await tools.handleSendChatMessage({
      content: '<p>Handout.</p>',
      images: [{ path: img }],
      imageFolder: 'worlds/w/assets/chat',
    });

    expect(dav.putFile).toHaveBeenCalledTimes(1);
    const forwarded = calls[0][1].content as string;
    expect(forwarded).toContain('<img src="https://srv/worlds/w/assets/chat/');
  });

  it('refuses local image upload when WebDAV is unconfigured', async () => {
    const { tools, calls } = build({ id: 'c4' });
    (tools as any).davClient = null;
    (tools as any).molten = { ...(tools as any).molten, webdavPassword: undefined };

    const img = tmpFile('pic2.webp');
    await writeFile(img, Buffer.from([1]));

    const out = await tools.handleSendChatMessage({ content: '<p>x</p>', images: [{ path: img }] });
    expect(out).toMatch(/not configured/);
    // refusal short-circuits — the bridge is never called
    expect(calls.length).toBe(0);
  });

  it('inlines a local image as a base64 data: URI with embed:"dataUri" (no upload)', async () => {
    const { tools, calls } = build({
      id: 'c5',
      alias: 'GM',
      visibility: 'public',
      whisperCount: 0,
    });
    const dav = fakeDav();
    (tools as any).davClient = dav;

    const img = tmpFile('inline.webp');
    await writeFile(img, Buffer.from([1, 2, 3]));

    await tools.handleSendChatMessage({
      content: '<p>Inline.</p>',
      images: [{ path: img, embed: 'dataUri' }],
    });

    // dataUri reads the file directly — no WebDAV upload.
    expect(dav.putFile).not.toHaveBeenCalled();
    const forwarded = calls[0][1].content as string;
    expect(forwarded).toContain('<img src="data:image/webp;base64,AQID"');
  });

  it('refuses embed:"dataUri" for an http URL', async () => {
    const { tools } = build();
    const out = await tools.handleSendChatMessage({
      content: '<p>x</p>',
      images: [{ path: 'https://example.com/x.png', embed: 'dataUri' }],
    });
    expect(out).toMatch(/needs a LOCAL file/i);
  });
});

describe('list-chat-messages', () => {
  it('formats a compact numbered list', async () => {
    const { tools, calls } = build({
      count: 1,
      messages: [
        { id: 'm1', time: '2026-01-01T00:00:00.000Z', alias: 'GM', whisperCount: 0, content: 'Hi' },
      ],
    });
    const out = await tools.handleListChatMessages({ limit: 10 });
    expect(calls[0][0]).toBe('listChatMessages');
    expect(out).toContain('m1');
    expect(out).toContain('GM');
  });

  it('reports an empty log', async () => {
    const { tools } = build({ count: 0, messages: [] });
    expect(await tools.handleListChatMessages({})).toBe('No chat messages.');
  });
});

describe('delete-chat-messages', () => {
  it('refuses clearAll without confirm and does NOT call the bridge', async () => {
    const { tools, calls } = build({});
    const out = await tools.handleDeleteChatMessages({ clearAll: true });
    expect(out).toMatch(/Refused/);
    expect(calls.length).toBe(0);
  });

  it('refuses beforeTimestamp without confirm and does NOT call the bridge', async () => {
    const { tools, calls } = build({});
    const out = await tools.handleDeleteChatMessages({ beforeTimestamp: 1_700_000_000_000 });
    expect(out).toMatch(/Refused/);
    expect(calls.length).toBe(0);
  });

  it('forwards a beforeTimestamp purge when confirmed', async () => {
    const { tools, calls } = build({ success: true, deletedCount: 3, deleted: [] });
    await tools.handleDeleteChatMessages({ beforeTimestamp: 1_700_000_000_000, confirm: true });
    expect(calls[0][0]).toBe('deleteChatMessages');
  });

  it('forwards an id delete and formats via formatDeletionResult', async () => {
    const { tools, calls } = build({
      success: true,
      deletedCount: 1,
      deleted: [{ id: 'm9', name: 'GM' }],
    });
    const out = await tools.handleDeleteChatMessages({ ids: ['m9'] });
    expect(calls[0][0]).toBe('deleteChatMessages');
    expect(out).toContain('Deleted 1 chat message(s)');
    expect(out).toContain('m9');
  });

  it('rejects when no selector is given (zod refine)', async () => {
    const { tools } = build();
    await expect(tools.handleDeleteChatMessages({})).rejects.toThrow();
  });

  it('summarizes a clear-all', async () => {
    const { tools } = build({ success: true, deletedCount: 5, deleted: [], clearedAll: true });
    const out = await tools.handleDeleteChatMessages({ clearAll: true, confirm: true });
    expect(out).toContain('Cleared the chat log');
    expect(out).toContain('5');
  });
});

describe('export-chat-log', () => {
  it('rejects when no destination is given (zod refine)', async () => {
    const { tools } = build();
    await expect(tools.handleExportChatLog({ format: 'markdown' })).rejects.toThrow();
  });

  it('writes to a local file and summarizes', async () => {
    const { tools, calls } = build({ format: 'markdown', messageCount: 2, content: '# Log\nhi' });
    const out = await tools.handleExportChatLog({ localPath: tmpFile('log.md') });
    expect(calls[0][0]).toBe('exportChatLog');
    expect(out).toContain('Exported 2 message(s)');
    expect(out).toContain('local:');
    expect(await readFile(tmpFiles[0], 'utf8')).toBe('# Log\nhi');
  });

  it('refuses to clobber an existing local file without overwrite', async () => {
    const { tools } = build({ format: 'markdown', messageCount: 1, content: 'new' });
    const p = tmpFile('exists.md');
    await writeFile(p, 'old');
    const out = await tools.handleExportChatLog({ localPath: p });
    expect(out).toMatch(/already exists/);
    expect(await readFile(p, 'utf8')).toBe('old'); // untouched
  });

  it('reports not-configured for a remote-only export with no WebDAV password', async () => {
    const { tools } = build({ format: 'markdown', messageCount: 0, content: '' });
    (tools as any).davClient = null;
    (tools as any).molten = { ...(tools as any).molten, webdavPassword: undefined };
    const out = await tools.handleExportChatLog({ remotePath: 'worlds/w/exports/log.md' });
    expect(out).toMatch(/not configured/);
  });
});

describe('post-item-card', () => {
  it('formats a posted card', async () => {
    const { tools, calls } = build({
      success: true,
      posted: true,
      actorName: 'Ankylosaurus',
      itemName: 'Tail',
      activityType: 'attack',
      action: 'use',
    });
    const out = await tools.handlePostItemCard({ actor: 'Ankylosaurus', item: 'Tail' });
    expect(calls[0][0]).toBe('postItemCard');
    expect(out).toContain('Posted use card for "Tail"');
  });

  it('surfaces the reason when no activity exists', async () => {
    const { tools } = build({ success: true, posted: false, reason: 'item has no activities' });
    const out = await tools.handlePostItemCard({ actor: 'X', item: 'Plain Feature' });
    expect(out).toMatch(/Could not post a rich card/);
  });
});

describe('request-roll', () => {
  it('forwards and formats', async () => {
    const { tools, calls } = build({
      success: true,
      kind: 'save',
      expression: '[[/save dex dc=15]]',
    });
    const out = await tools.handleRequestRoll({ kind: 'save', ability: 'dex', dc: 15 });
    expect(calls[0][0]).toBe('requestRoll');
    expect(out).toContain('[[/save dex dc=15]]');
  });

  it('rejects a skill request without a skill (zod refine)', async () => {
    const { tools } = build();
    await expect(tools.handleRequestRoll({ kind: 'skill' })).rejects.toThrow();
  });
});

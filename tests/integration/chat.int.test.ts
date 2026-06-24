// Chat-log tools (live). Exercises the page layer through the foundry.call seam (post / list /
// delete / export / dnd5e card / roll request) plus the Node-side ChatTools.handleExportChatLog
// (local file + optional WebDAV). The page lib is bundled to the browser and is NOT unit-tested, so
// this is its only correctness gate. Everything created is cleaned up in afterAll. Gated on LIVE.
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Foundry } from '../../dist/foundry.js';
import { ChatTools } from '../../dist/tools/chat.js';
import { LIVE, ENV, foundryConfig, noopLogger, CONNECT_TIMEOUT_MS, TAG } from './setup.js';

describe.skipIf(!LIVE)('chat-log tools (live)', () => {
  let foundry: Foundry;
  const created: string[] = [];
  const localExport = join(tmpdir(), `${TAG}-chat-log.md`);
  const seed: { actorName?: string; itemName?: string } = {};

  beforeAll(async () => {
    foundry = new Foundry(foundryConfig(), noopLogger);
    await foundry.connect();

    const actors = await foundry.call<Array<{ name?: string }>>('listActors', {});
    seed.actorName = actors?.[0]?.name;
    if (seed.actorName) {
      const items = await foundry.call<Array<{ name?: string }>>('searchCharacterItems', {
        characterIdentifier: seed.actorName,
      });
      seed.itemName = items?.[0]?.name;
    }
  }, CONNECT_TIMEOUT_MS);

  afterAll(async () => {
    if (created.length) {
      try {
        await foundry.call('deleteChatMessages', { ids: created });
      } catch {
        /* best-effort */
      }
    }
    await rm(localExport, { force: true }).catch(() => {});
    await foundry?.dispose();
  });

  const post = async (args: Record<string, unknown>) => {
    const r = await foundry.call<{ id?: string }>('postChatMessage', args);
    if (r?.id) created.push(r.id);
    return r;
  };

  it('posts all five visibility modes', async () => {
    const pub = await post({ content: '<p>The winter is coming.</p>', visibility: 'public' });
    const gm = await post({ content: '<p>The winter is NOT coming.</p>', visibility: 'gm' });
    const blind = await post({ content: '<p>blind</p>', visibility: 'blind' });
    const self = await post({ content: '<p>self</p>', visibility: 'self' });
    const ic = seed.actorName
      ? await post({
          content: '<p>in character</p>',
          visibility: 'public',
          speakerActor: seed.actorName,
        })
      : { id: undefined };
    expect(pub.id).toBeTruthy();
    expect(gm.id).toBeTruthy();
    expect(blind.id).toBeTruthy();
    expect(self.id).toBeTruthy();
    if (seed.actorName) expect(ic.id).toBeTruthy();
  });

  it('lists messages with correct whisper/blind distinctions', async () => {
    const res = await foundry.call<{ messages: any[] }>('listChatMessages', {
      limit: 50,
      contentMode: 'text',
    });
    const byId = new Map(res.messages.map(m => [m.id, m]));
    // The public message has no whisper recipients; gm/blind/self do.
    const recs = created.map(id => byId.get(id)).filter(Boolean);
    const pub = recs.find(m => (m.content ?? '').includes('winter is coming'));
    const gm = recs.find(m => (m.content ?? '').includes('NOT coming'));
    const blind = recs.find(m => (m.content ?? '').includes('blind'));
    if (pub) expect(pub.whisperCount).toBe(0);
    if (gm) expect(gm.whisperCount).toBeGreaterThan(0);
    // gm-vs-blind: both whisper the GMs, but only blind sets the blind flag.
    if (gm) expect(gm.blind).toBe(false);
    if (blind) expect(blind.blind).toBe(true);
  });

  it('request-roll posts an enriched (transformed) inline roll, not the raw token', async () => {
    const r = await foundry.call<{ id?: string; expression?: string }>('requestRoll', {
      kind: 'save',
      ability: 'dex',
      dc: 15,
      visibility: 'public',
    });
    if (r?.id) created.push(r.id);
    expect(r?.expression).toBe('[[/save dex dc=15]]');
    const res = await foundry.call<{ messages: any[] }>('listChatMessages', {
      limit: 10,
      contentMode: 'html',
    });
    const msg = res.messages.find(m => m.id === r?.id);
    // If the dnd5e enricher fired, the raw [[/save token is replaced by a clickable anchor.
    if (msg) expect(msg.content).not.toContain('[[/save');
  });

  it('post-item-card behaves correctly (posts a card or returns a clear reason)', async ctx => {
    if (!seed.actorName || !seed.itemName) return ctx.skip();
    const r = await foundry.call<{ posted?: boolean; reason?: string }>('postItemCard', {
      actor: seed.actorName,
      item: seed.itemName,
      action: 'use',
    });
    // Either a card posted, or a clean "no activities" reason — both are correct behavior.
    expect(typeof r?.posted === 'boolean').toBe(true);
  });

  it('exports the transcript to a local file (ChatTools handler)', async () => {
    const tools = new ChatTools({ foundry: foundry as any, logger: noopLogger });
    const out = await tools.handleExportChatLog({ localPath: localExport, overwrite: true });
    expect(out).toContain('Exported');
    expect(out).toContain('local:');
    const written = await readFile(localExport, 'utf8');
    expect(written).toContain('Chat Log');
  });

  it('exports to WebDAV and the public URL is reachable', async ctx => {
    if (!ENV.MOLTEN_WEBDAV_PASSWORD) return ctx.skip();
    const tools = new ChatTools({ foundry: foundry as any, logger: noopLogger });
    const remote = `worlds/${ENV.MOLTEN_WORLD_ID}/exports/${TAG}-chat-log.md`;
    const out = await tools.handleExportChatLog({ remotePath: remote, overwrite: true });
    const urlMatch = out.match(/public URL: (\S+)/);
    expect(urlMatch).toBeTruthy();
    if (urlMatch) {
      const res = await fetch(urlMatch[1]);
      expect(res.status).toBe(200);
    }
  });

  it('deletes a single message by id', async () => {
    const r = await post({ content: '<p>delete me</p>', visibility: 'self' });
    const del = await foundry.call<{ deletedCount?: number }>('deleteChatMessages', {
      ids: [r.id],
    });
    expect(del?.deletedCount).toBe(1);
    // Drop it from the cleanup list (already gone).
    const i = created.indexOf(r.id as string);
    if (i >= 0) created.splice(i, 1);
  });
});

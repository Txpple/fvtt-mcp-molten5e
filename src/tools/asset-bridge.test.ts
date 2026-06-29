/**
 * Unit tests for AssetBridgeTools — reference integrity (find/relink) + asset→document art
 * composition (set-actor-art, add-journal-image). Scenes moved to scene.test.ts and playlists to
 * playlist.test.ts when the Node-side classes were re-cut to mirror the page-side domain split.
 *
 * Covers the two things every handler owns before/after the bridge query:
 *   1. zod input validation — required fields and .min(1) strings/arrays (bad input throws).
 *   2. response formatting — the human-readable string built from the bridge result, including
 *      empty-list, notFound, and optional-field branches.
 */

import { describe, it, expect } from 'vitest';
import { AssetBridgeTools } from './asset-bridge.js';
import { makeLogger, makeFoundry } from './test-helpers.js';

function build(response: any = {}) {
  const { foundry, calls } = makeFoundry(response);
  const tools = new AssetBridgeTools({ foundry, logger: makeLogger() });
  return { tools, calls, foundry };
}

describe('AssetBridgeTools.getToolDefinitions', () => {
  it('exposes exactly the four asset-bridge tools', () => {
    const { tools } = build();
    const names = tools
      .getToolDefinitions()
      .map(t => t.name)
      .sort();
    expect(names).toEqual(
      ['add-journal-image', 'find-asset-references', 'relink-asset', 'set-actor-art'].sort()
    );
  });

  it('every definition has an object inputSchema', () => {
    const { tools } = build();
    for (const def of tools.getToolDefinitions()) {
      expect(def.inputSchema.type).toBe('object');
    }
  });
});

describe('handleFindAssetReferences', () => {
  it('forwards a valid lookup and formats references with hits', async () => {
    const { tools, calls } = build({
      totalReferences: 2,
      references: {
        'worlds/w/a.webp': [
          {
            documentType: 'Scene',
            documentName: 'Cavern',
            documentId: 's1',
            field: 'background.src',
          },
          { documentType: 'Actor', documentName: 'Goblin', documentId: 'a1', field: 'img' },
        ],
      },
    });
    const out = await tools.handleFindAssetReferences({ paths: ['worlds/w/a.webp'] });
    expect(calls[0][0]).toBe('findAssetReferences');
    expect(calls[0][1]).toMatchObject({ paths: ['worlds/w/a.webp'] });
    expect(out).toContain('Asset references (2 total):');
    expect(out).toContain('• worlds/w/a.webp — 2 reference(s):');
    expect(out).toContain('- Scene "Cavern" (s1) :: background.src');
    expect(out).toContain('- Actor "Goblin" (a1) :: img');
  });

  it('reports "no references found" for a path with no hits', async () => {
    const { tools } = build({ totalReferences: 0, references: {} });
    const out = await tools.handleFindAssetReferences({ paths: ['unused.webp'] });
    expect(out).toContain('Asset references (0 total):');
    expect(out).toContain('• unused.webp — no references found (safe to delete/move).');
  });

  it('rejects an empty paths array', async () => {
    const { tools } = build();
    await expect(tools.handleFindAssetReferences({ paths: [] })).rejects.toThrow();
  });

  it('rejects a path that is an empty string', async () => {
    const { tools } = build();
    await expect(tools.handleFindAssetReferences({ paths: [''] })).rejects.toThrow();
  });

  it('rejects missing paths', async () => {
    const { tools } = build();
    await expect(tools.handleFindAssetReferences({})).rejects.toThrow();
  });
});

describe('handleRelinkAsset', () => {
  it('forwards a valid relink and lists changed documents', async () => {
    const { tools, calls } = build({
      dryRun: false,
      changedCount: 1,
      changed: [
        {
          documentType: 'Scene',
          documentName: 'Cavern',
          documentId: 's1',
          field: 'background.src',
        },
      ],
    });
    const out = await tools.handleRelinkAsset({ oldPath: 'old.webp', newPath: 'new.webp' });
    expect(calls[0][0]).toBe('relinkAsset');
    expect(calls[0][1]).toMatchObject({ oldPath: 'old.webp', newPath: 'new.webp', dryRun: false });
    expect(out).toContain('Rewrote 1 reference(s): old.webp → new.webp');
    expect(out).toContain('- Scene "Cavern" (s1) :: background.src');
  });

  it('uses "Would rewrite" verb and passes dryRun through', async () => {
    const { tools, calls } = build({
      dryRun: true,
      changedCount: 1,
      changed: [{ documentType: 'Actor', documentName: 'G', documentId: 'a', field: 'img' }],
    });
    const out = await tools.handleRelinkAsset({ oldPath: 'o', newPath: 'n', dryRun: true });
    expect(calls[0][1]).toMatchObject({ dryRun: true });
    expect(out).toContain('Would rewrite 1 reference(s): o → n');
  });

  it('reports nothing-referenced branch when changed is empty', async () => {
    const { tools } = build({ dryRun: false, changedCount: 0, changed: [] });
    const out = await tools.handleRelinkAsset({ oldPath: 'o', newPath: 'n' });
    expect(out).toBe('Rewrote 0 reference(s): o → n (nothing referenced the old path).');
  });

  it('rejects an empty oldPath', async () => {
    const { tools } = build();
    await expect(tools.handleRelinkAsset({ oldPath: '', newPath: 'n' })).rejects.toThrow();
  });

  it('rejects a missing newPath', async () => {
    const { tools } = build();
    await expect(tools.handleRelinkAsset({ oldPath: 'o' })).rejects.toThrow();
  });
});

describe('handleSetActorArt', () => {
  it('forwards a valid set and reports portrait + token', async () => {
    const { tools, calls } = build({
      updated: true,
      actorName: 'Goblin',
      actorId: 'a1',
      img: 'art/goblin.webp',
      appliedToToken: true,
    });
    const out = await tools.handleSetActorArt({
      actorIdentifier: 'Goblin',
      imagePath: 'art/goblin.webp',
    });
    expect(calls[0][0]).toBe('setActorArt');
    expect(calls[0][1]).toMatchObject({
      actorIdentifier: 'Goblin',
      imagePath: 'art/goblin.webp',
      applyToToken: true,
    });
    expect(out).toBe(
      'Set art for actor "Goblin" (a1) → art/goblin.webp (portrait + prototype token).'
    );
  });

  it('reports "portrait only" when appliedToToken is falsy', async () => {
    const { tools } = build({
      updated: true,
      actorName: 'G',
      actorId: 'a1',
      img: 'i.webp',
      appliedToToken: false,
    });
    const out = await tools.handleSetActorArt({
      actorIdentifier: 'G',
      imagePath: 'i.webp',
      applyToToken: false,
    });
    expect(out).toBe('Set art for actor "G" (a1) → i.webp (portrait only).');
  });

  it('reports not-found branch when updated === false', async () => {
    const { tools } = build({ updated: false, notFound: 'Ghost' });
    const out = await tools.handleSetActorArt({ actorIdentifier: 'Ghost', imagePath: 'i.webp' });
    expect(out).toBe('Actor not found: "Ghost". Nothing changed.');
  });

  it('rejects an empty actorIdentifier', async () => {
    const { tools } = build();
    await expect(
      tools.handleSetActorArt({ actorIdentifier: '', imagePath: 'i.webp' })
    ).rejects.toThrow();
  });

  it('rejects a missing imagePath', async () => {
    const { tools } = build();
    await expect(tools.handleSetActorArt({ actorIdentifier: 'G' })).rejects.toThrow();
  });
});

describe('handleAddJournalImage', () => {
  it('forwards a valid add and formats result', async () => {
    const { tools, calls } = build({
      updated: true,
      pageName: 'Map',
      pageId: 'pg1',
      journalName: 'Lore',
      journalId: 'j1',
      src: 'img/map.webp',
    });
    const out = await tools.handleAddJournalImage({
      journalIdentifier: 'Lore',
      imagePath: 'img/map.webp',
    });
    expect(calls[0][0]).toBe('addJournalImage');
    expect(calls[0][1]).toMatchObject({ journalIdentifier: 'Lore', imagePath: 'img/map.webp' });
    expect(out).toBe('Added image page "Map" (pg1) to journal "Lore" (j1) → img/map.webp.');
  });

  it('passes optional pageName and caption through', async () => {
    const { tools, calls } = build({
      updated: true,
      pageName: 'Title',
      pageId: 'pg1',
      journalName: 'Lore',
      journalId: 'j1',
      src: 'i.webp',
    });
    await tools.handleAddJournalImage({
      journalIdentifier: 'Lore',
      imagePath: 'i.webp',
      pageName: 'Title',
      caption: 'A caption',
    });
    expect(calls[0][1]).toMatchObject({ pageName: 'Title', caption: 'A caption' });
  });

  it('passes playerVisible through (handout image page)', async () => {
    const { tools, calls } = build({
      updated: true,
      pageName: 'Map',
      pageId: 'pg1',
      journalName: 'Lore',
      journalId: 'j1',
      src: 'i.webp',
    });
    await tools.handleAddJournalImage({
      journalIdentifier: 'Lore',
      imagePath: 'i.webp',
      playerVisible: true,
    });
    expect(calls[0][1]).toMatchObject({ playerVisible: true });
  });

  it('reports not-found branch when updated === false', async () => {
    const { tools } = build({ updated: false, notFound: 'Ghost' });
    const out = await tools.handleAddJournalImage({
      journalIdentifier: 'Ghost',
      imagePath: 'i.webp',
    });
    expect(out).toBe('Journal not found: "Ghost". Nothing changed.');
  });

  it('rejects an empty journalIdentifier', async () => {
    const { tools } = build();
    await expect(
      tools.handleAddJournalImage({ journalIdentifier: '', imagePath: 'i.webp' })
    ).rejects.toThrow();
  });

  it('rejects a missing imagePath', async () => {
    const { tools } = build();
    await expect(tools.handleAddJournalImage({ journalIdentifier: 'J' })).rejects.toThrow();
  });
});

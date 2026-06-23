/**
 * Unit tests for AssetBridgeTools (Group C reference integrity + Group D
 * Foundry composition over the bridge).
 *
 * Covers the two things every handler owns before/after the bridge query:
 *   1. zod input validation — required fields, .min(1) strings/arrays, enum
 *      membership are enforced (bad input throws, never hits the bridge).
 *   2. response formatting — the human-readable string built from the bridge
 *      result, including empty-list, notFound, and optional-field branches.
 *
 * The mock asserts the EXACT bridge method name forwarded (these vary:
 * deletePlaylists, listScenes, deleteScenes, etc.).
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
  it('exposes exactly the twelve asset-bridge tools', () => {
    const { tools } = build();
    const names = tools
      .getToolDefinitions()
      .map(t => t.name)
      .sort();
    expect(names).toEqual(
      [
        'add-journal-image',
        'create-playlist',
        'create-scene',
        'delete-playlist',
        'delete-scene',
        'find-asset-references',
        'list-playlists',
        'list-scenes',
        'relink-asset',
        'set-actor-art',
        'update-playlist',
        'update-scene',
      ].sort()
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

describe('handleCreatePlaylist', () => {
  it('forwards a valid playlist and formats tracks', async () => {
    const { tools, calls } = build({
      playlistName: 'Tavern',
      playlistId: 'pl1',
      mode: 'sequential',
      soundCount: 2,
      sounds: [
        { name: 'lute.ogg', path: 'snd/lute.ogg' },
        { name: 'crowd.ogg', path: 'snd/crowd.ogg' },
      ],
    });
    const out = await tools.handleCreatePlaylist({
      name: 'Tavern',
      soundPaths: ['snd/lute.ogg', 'snd/crowd.ogg'],
    });
    expect(calls[0][0]).toBe('createPlaylist');
    expect(calls[0][1]).toMatchObject({
      name: 'Tavern',
      soundPaths: ['snd/lute.ogg', 'snd/crowd.ogg'],
      mode: 'sequential',
      repeat: false,
    });
    expect(out).toContain('Created playlist "Tavern" (pl1) — mode sequential, 2 track(s):');
    expect(out).toContain('- lute.ogg  (snd/lute.ogg)');
    expect(out).toContain('- crowd.ogg  (snd/crowd.ogg)');
  });

  it('rejects an empty name', async () => {
    const { tools } = build();
    await expect(tools.handleCreatePlaylist({ name: '', soundPaths: ['s'] })).rejects.toThrow();
  });

  it('rejects an empty soundPaths array', async () => {
    const { tools } = build();
    await expect(tools.handleCreatePlaylist({ name: 'X', soundPaths: [] })).rejects.toThrow();
  });

  it('rejects an invalid mode enum', async () => {
    const { tools } = build();
    await expect(
      tools.handleCreatePlaylist({ name: 'X', soundPaths: ['s'], mode: 'loud' })
    ).rejects.toThrow();
  });

  it('rejects a defaultVolume out of range', async () => {
    const { tools } = build();
    await expect(
      tools.handleCreatePlaylist({ name: 'X', soundPaths: ['s'], defaultVolume: 2 })
    ).rejects.toThrow();
  });
});

describe('handleListPlaylists', () => {
  it('forwards listPlaylists and formats playlists incl. playing flag', async () => {
    const { tools, calls } = build([
      { name: 'A', id: 'p1', mode: 'shuffle', soundCount: 3, playing: true },
      { name: 'B', id: 'p2', mode: 'sequential', soundCount: 0, playing: false },
    ]);
    const out = await tools.handleListPlaylists({});
    expect(calls[0][0]).toBe('listPlaylists');
    expect(out).toContain('Playlists (2):');
    expect(out).toContain('- "A" (p1) — mode shuffle, 3 track(s) [playing]');
    expect(out).toContain('- "B" (p2) — mode sequential, 0 track(s)');
    expect(out).not.toContain('"B" (p2) — mode sequential, 0 track(s) [playing]');
  });

  it('reports no playlists for an empty array', async () => {
    const { tools } = build([]);
    const out = await tools.handleListPlaylists({});
    expect(out).toBe('No playlists found.');
  });

  it('reports no playlists for a non-array result', async () => {
    const { tools } = build(null);
    const out = await tools.handleListPlaylists({});
    expect(out).toBe('No playlists found.');
  });
});

describe('handleUpdatePlaylist', () => {
  it('forwards a valid update and reports success', async () => {
    const { tools, calls } = build({ updated: true, playlistName: 'Tavern', playlistId: 'pl1' });
    const out = await tools.handleUpdatePlaylist({
      identifier: 'pl1',
      name: 'Tavern',
      mode: 'shuffle',
    });
    expect(calls[0][0]).toBe('updatePlaylist');
    expect(calls[0][1]).toMatchObject({ identifier: 'pl1', name: 'Tavern', mode: 'shuffle' });
    expect(out).toBe('Updated playlist "Tavern" (pl1).');
  });

  it('reports not-found branch when updated === false', async () => {
    const { tools } = build({ updated: false, notFound: 'Ghost' });
    const out = await tools.handleUpdatePlaylist({ identifier: 'Ghost' });
    expect(out).toBe('Playlist not found: "Ghost". Nothing changed.');
  });

  it('rejects an empty identifier', async () => {
    const { tools } = build();
    await expect(tools.handleUpdatePlaylist({ identifier: '' })).rejects.toThrow();
  });

  it('rejects an invalid mode enum', async () => {
    const { tools } = build();
    await expect(tools.handleUpdatePlaylist({ identifier: 'p', mode: 'nope' })).rejects.toThrow();
  });
});

describe('handleDeletePlaylist', () => {
  it('forwards .deletePlaylists and lists deleted', async () => {
    const { tools, calls } = build({
      deletedCount: 2,
      deleted: [
        { name: 'A', id: 'p1' },
        { name: 'B', id: 'p2' },
      ],
      notFound: [],
    });
    const out = await tools.handleDeletePlaylist({ identifiers: ['p1', 'p2'] });
    expect(calls[0][0]).toBe('deletePlaylists');
    expect(calls[0][1]).toMatchObject({ identifiers: ['p1', 'p2'] });
    expect(out).toContain('Deleted 2 playlist(s):');
    expect(out).toContain('- "A" (p1)');
    expect(out).toContain('- "B" (p2)');
    expect(out).not.toContain('not found:');
  });

  it('appends not-found list when some ids do not resolve', async () => {
    const { tools } = build({ deletedCount: 0, deleted: [], notFound: ['ghost'] });
    const out = await tools.handleDeletePlaylist({ identifiers: ['ghost'] });
    expect(out).toContain('Deleted 0 playlist(s):');
    expect(out).toContain('not found: ghost');
  });

  it('rejects an empty identifiers array', async () => {
    const { tools } = build();
    await expect(tools.handleDeletePlaylist({ identifiers: [] })).rejects.toThrow();
  });

  it('rejects an identifier that is an empty string', async () => {
    const { tools } = build();
    await expect(tools.handleDeletePlaylist({ identifiers: [''] })).rejects.toThrow();
  });
});

describe('handleCreateScene', () => {
  it('forwards a valid scene and formats result', async () => {
    const { tools, calls } = build({
      sceneName: 'Cavern',
      sceneId: 'sc1',
      active: false,
      background: 'maps/cavern.webp',
    });
    const out = await tools.handleCreateScene({
      name: 'Cavern',
      backgroundPath: 'maps/cavern.webp',
    });
    expect(calls[0][0]).toBe('createScene');
    expect(calls[0][1]).toMatchObject({
      name: 'Cavern',
      backgroundPath: 'maps/cavern.webp',
      activate: false,
    });
    expect(out).toBe('Created scene "Cavern" (sc1)\n  background: maps/cavern.webp');
  });

  it('appends [active] when the scene is activated', async () => {
    const { tools } = build({ sceneName: 'C', sceneId: 'sc1', active: true, background: 'b.webp' });
    const out = await tools.handleCreateScene({
      name: 'C',
      backgroundPath: 'b.webp',
      activate: true,
    });
    expect(out).toBe('Created scene "C" (sc1) [active]\n  background: b.webp');
  });

  it('rejects an empty name', async () => {
    const { tools } = build();
    await expect(tools.handleCreateScene({ name: '', backgroundPath: 'b.webp' })).rejects.toThrow();
  });

  it('rejects a missing backgroundPath', async () => {
    const { tools } = build();
    await expect(tools.handleCreateScene({ name: 'X' })).rejects.toThrow();
  });

  it('rejects a non-integer width', async () => {
    const { tools } = build();
    await expect(
      tools.handleCreateScene({ name: 'X', backgroundPath: 'b', width: 12.5 })
    ).rejects.toThrow();
  });

  it('rejects padding above 0.5', async () => {
    const { tools } = build();
    await expect(
      tools.handleCreateScene({ name: 'X', backgroundPath: 'b', padding: 0.9 })
    ).rejects.toThrow();
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

describe('handleListScenes', () => {
  it('forwards .listScenes and formats scenes with dimensions + active', async () => {
    const { tools, calls } = build([
      {
        name: 'Cavern',
        id: 'sc1',
        active: true,
        dimensions: { width: 4000, height: 3000 },
        gridSize: 100,
        background: 'maps/cavern.webp',
      },
      { name: 'Empty', id: 'sc2', active: false, gridSize: 50 },
    ]);
    const out = await tools.handleListScenes({});
    expect(calls[0][0]).toBe('listScenes');
    expect(out).toContain('Scenes (2):');
    expect(out).toContain('- "Cavern" (sc1) [active] — 4000×3000px, grid 100');
    expect(out).toContain('background: maps/cavern.webp');
    expect(out).toContain('- "Empty" (sc2) — ?px, grid 50');
  });

  it('passes filter and includeActiveOnly through', async () => {
    const { tools, calls } = build([]);
    await tools.handleListScenes({ filter: 'cav', includeActiveOnly: true });
    expect(calls[0][1]).toMatchObject({ filter: 'cav', includeActiveOnly: true });
  });

  it('reports no scenes for an empty array', async () => {
    const { tools } = build([]);
    const out = await tools.handleListScenes({});
    expect(out).toBe('No scenes found.');
  });

  it('reports no scenes for a non-array result', async () => {
    const { tools } = build(undefined);
    const out = await tools.handleListScenes({});
    expect(out).toBe('No scenes found.');
  });
});

describe('handleUpdateScene', () => {
  it('forwards a valid update and formats result', async () => {
    const { tools, calls } = build({
      updated: true,
      sceneName: 'Cavern',
      sceneId: 'sc1',
      background: 'maps/new.webp',
    });
    const out = await tools.handleUpdateScene({
      sceneIdentifier: 'sc1',
      backgroundPath: 'maps/new.webp',
    });
    expect(calls[0][0]).toBe('updateScene');
    expect(calls[0][1]).toMatchObject({ sceneIdentifier: 'sc1', backgroundPath: 'maps/new.webp' });
    expect(out).toBe('Updated scene "Cavern" (sc1)\n  background: maps/new.webp');
  });

  it('reports not-found branch when updated === false', async () => {
    const { tools } = build({ updated: false, notFound: 'Ghost' });
    const out = await tools.handleUpdateScene({ sceneIdentifier: 'Ghost' });
    expect(out).toBe('Scene not found: "Ghost". Nothing changed.');
  });

  it('rejects an empty sceneIdentifier', async () => {
    const { tools } = build();
    await expect(tools.handleUpdateScene({ sceneIdentifier: '' })).rejects.toThrow();
  });

  it('rejects an empty backgroundPath when provided', async () => {
    const { tools } = build();
    await expect(
      tools.handleUpdateScene({ sceneIdentifier: 's', backgroundPath: '' })
    ).rejects.toThrow();
  });

  it('rejects padding above 0.5', async () => {
    const { tools } = build();
    await expect(tools.handleUpdateScene({ sceneIdentifier: 's', padding: 0.9 })).rejects.toThrow();
  });
});

describe('handleDeleteScene', () => {
  it('forwards .deleteScenes and lists deleted', async () => {
    const { tools, calls } = build({
      deletedCount: 1,
      deleted: [{ name: 'Cavern', id: 'sc1' }],
      notFound: [],
    });
    const out = await tools.handleDeleteScene({ identifiers: ['sc1'] });
    expect(calls[0][0]).toBe('deleteScenes');
    expect(calls[0][1]).toMatchObject({ identifiers: ['sc1'] });
    expect(out).toContain('Deleted 1 scene(s):');
    expect(out).toContain('- "Cavern" (sc1)');
    expect(out).not.toContain('not found:');
  });

  it('appends not-found list when some ids do not resolve', async () => {
    const { tools } = build({ deletedCount: 0, deleted: [], notFound: ['ghost'] });
    const out = await tools.handleDeleteScene({ identifiers: ['ghost'] });
    expect(out).toContain('Deleted 0 scene(s):');
    expect(out).toContain('not found: ghost');
  });

  it('rejects an empty identifiers array', async () => {
    const { tools } = build();
    await expect(tools.handleDeleteScene({ identifiers: [] })).rejects.toThrow();
  });

  it('rejects an identifier that is an empty string', async () => {
    const { tools } = build();
    await expect(tools.handleDeleteScene({ identifiers: [''] })).rejects.toThrow();
  });
});

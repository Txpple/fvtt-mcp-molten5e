/**
 * Unit tests for PlaylistTools (create/list/update/delete Playlist documents over the bridge).
 * Split out of asset-bridge.test.ts so each Node-side tool class has its own co-located test.
 * Covers zod input validation (bad input throws, never hits the bridge), the EXACT bridge method
 * name forwarded, and response formatting (empty-list, not-found, playing-flag branches).
 */

import { describe, it, expect } from 'vitest';
import { PlaylistTools } from './playlist.js';
import { makeLogger, makeFoundry } from './test-helpers.js';

function build(response: any = {}) {
  const { foundry, calls } = makeFoundry(response);
  const tools = new PlaylistTools({ foundry, logger: makeLogger() });
  return { tools, calls, foundry };
}

describe('PlaylistTools.getToolDefinitions', () => {
  it('exposes exactly the four playlist tools', () => {
    const { tools } = build();
    const names = tools
      .getToolDefinitions()
      .map(t => t.name)
      .sort();
    expect(names).toEqual(
      ['create-playlist', 'delete-playlist', 'list-playlists', 'update-playlist'].sort()
    );
  });

  it('every definition has an object inputSchema', () => {
    const { tools } = build();
    for (const def of tools.getToolDefinitions()) {
      expect(def.inputSchema.type).toBe('object');
    }
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

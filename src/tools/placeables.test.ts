/**
 * Unit tests for PlaceableTools (Tile CRUD over the shared placeable kernel).
 *
 * These handlers own: zod input parsing (required create fields; update needs one field beyond id;
 * delete needs ids), the exact page-op names + arg SHAPE forwarded across the bridge
 * (createSceneTiles/listSceneTiles/updateSceneTiles/deleteSceneTiles with items/patches/ids), and the
 * output shaping via utils/placeable-format. The page-side kernel + Tile descriptor are live-verified.
 */

import { describe, it, expect } from 'vitest';
import { PlaceableTools } from './placeables.js';
import { makeLogger, makeFoundry } from './test-helpers.js';

function build(response: any = {}) {
  const { foundry, calls } = makeFoundry(response);
  const tools = new PlaceableTools({ foundry, logger: makeLogger() });
  return { tools, calls, foundry };
}

describe('PlaceableTools.getToolDefinitions', () => {
  it('exposes the four Tile CRUD tools', () => {
    const { tools } = build();
    const names = tools
      .getToolDefinitions()
      .map(t => t.name)
      .sort();
    expect(names).toEqual(['create-tiles', 'delete-tiles', 'list-tiles', 'update-tiles']);
  });
});

describe('handleCreateTiles', () => {
  it('forwards {sceneIdentifier, items} and formats the created ids', async () => {
    const { tools, calls } = build({
      success: true,
      sceneId: 'sc1',
      sceneName: 'Cave',
      created: 1,
      items: [{ id: 'tileA', name: 'Blood Splatter' }],
    });
    const out = await tools.handleCreateTiles({
      sceneIdentifier: 'Cave',
      tiles: [{ src: 'worlds/w/props/blood.png', x: 100, y: 200, width: 280, height: 320 }],
    });
    expect(calls[0][0]).toBe('createSceneTiles');
    expect(calls[0][1]).toMatchObject({
      sceneIdentifier: 'Cave',
      items: [{ src: 'worlds/w/props/blood.png', x: 100, y: 200, width: 280, height: 320 }],
    });
    expect(out).toContain('Created 1 tile(s) on "Cave" (sc1)');
    expect(out).toContain('tileA — Blood Splatter');
  });

  it('surfaces per-tile errors + warnings from the kernel result', async () => {
    const { tools } = build({
      success: true,
      sceneId: 'sc1',
      sceneName: 'Cave',
      created: 0,
      errors: ['Tile 0: src (texture path) is required'],
      warnings: ['Supplied src "x.png" was not found on the server — ...'],
    });
    const out = await tools.handleCreateTiles({
      sceneIdentifier: 'Cave',
      tiles: [{ src: 'x.png', x: 0, y: 0, width: 10, height: 10 }],
    });
    expect(out).toContain('Created 0 tile(s)');
    expect(out).toContain('⚠ Tile 0: src (texture path) is required');
    expect(out).toContain('1 warning(s)');
  });

  it('reports scene-not-found without claiming tiles were created', async () => {
    const { tools } = build({ success: true, created: 0, notFound: 'Nowhere' });
    const out = await tools.handleCreateTiles({
      sceneIdentifier: 'Nowhere',
      tiles: [{ src: 'x.png', x: 0, y: 0, width: 10, height: 10 }],
    });
    expect(out).toBe('Scene not found: "Nowhere". No tiles created.');
  });

  it('rejects a tile missing required geometry', async () => {
    const { tools } = build();
    await expect(
      tools.handleCreateTiles({ sceneIdentifier: 'Cave', tiles: [{ src: 'x.png', x: 0, y: 0 }] })
    ).rejects.toThrow();
  });

  it('rejects an empty tiles array', async () => {
    const { tools } = build();
    await expect(tools.handleCreateTiles({ sceneIdentifier: 'Cave', tiles: [] })).rejects.toThrow();
  });
});

describe('handleListTiles', () => {
  it('passes the structured tile list straight through', async () => {
    const result = {
      found: true,
      sceneId: 'sc1',
      sceneName: 'Cave',
      count: 2,
      items: [
        { id: 't1', x: 0, y: 0, width: 100, height: 100, src: 'a.png' },
        { id: 't2', x: 200, y: 0, width: 100, height: 100, src: 'b.png' },
      ],
    };
    const { tools, calls } = build(result);
    const out = await tools.handleListTiles({ sceneIdentifier: 'Cave' });
    expect(calls[0][0]).toBe('listSceneTiles');
    expect(out).toEqual(result);
  });

  it('reports a not-found scene as a message', async () => {
    const { tools } = build({ found: false, notFound: 'Ghost' });
    const out = await tools.handleListTiles({ sceneIdentifier: 'Ghost' });
    expect(out).toBe('Scene not found: "Ghost" (no tiles).');
  });
});

describe('handleUpdateTiles', () => {
  it('forwards {sceneIdentifier, patches} and reports matched/updated', async () => {
    const { tools, calls } = build({
      success: true,
      sceneId: 'sc1',
      sceneName: 'Cave',
      matched: 1,
      updated: 1,
    });
    const out = await tools.handleUpdateTiles({
      sceneIdentifier: 'Cave',
      tiles: [{ id: 't1', width: 400, height: 460 }],
    });
    expect(calls[0][0]).toBe('updateSceneTiles');
    expect(calls[0][1]).toMatchObject({
      sceneIdentifier: 'Cave',
      patches: [{ id: 't1', width: 400, height: 460 }],
    });
    expect(out).toContain('Updated 1 of 1 matched tile(s) on "Cave" (sc1)');
  });

  it('reports unresolved ids, not fatal', async () => {
    const { tools } = build({
      success: true,
      sceneId: 'sc1',
      sceneName: 'Cave',
      matched: 0,
      updated: 0,
      notFoundIds: ['ghostTile'],
    });
    const out = await tools.handleUpdateTiles({
      sceneIdentifier: 'Cave',
      tiles: [{ id: 'ghostTile', x: 5 }],
    });
    expect(out).toContain('No tiles matched');
    expect(out).toContain('not found: ghostTile');
  });

  it('rejects a patch with no field beyond id', async () => {
    const { tools } = build();
    await expect(
      tools.handleUpdateTiles({ sceneIdentifier: 'Cave', tiles: [{ id: 't1' }] })
    ).rejects.toThrow();
  });
});

describe('handleDeleteTiles', () => {
  it('forwards tileIds as {ids} and reports the count + missing ids', async () => {
    const { tools, calls } = build({
      success: true,
      sceneId: 'sc1',
      sceneName: 'Cave',
      deleted: 1,
      notFoundIds: ['ghost'],
    });
    const out = await tools.handleDeleteTiles({
      sceneIdentifier: 'Cave',
      tileIds: ['t1', 'ghost'],
    });
    expect(calls[0][0]).toBe('deleteSceneTiles');
    expect(calls[0][1]).toMatchObject({ sceneIdentifier: 'Cave', ids: ['t1', 'ghost'] });
    expect(out).toContain('Deleted 1 tile(s) from "Cave" (sc1)');
    expect(out).toContain('1 id(s) not found: ghost');
  });

  it('rejects an empty tileIds array', async () => {
    const { tools } = build();
    await expect(
      tools.handleDeleteTiles({ sceneIdentifier: 'Cave', tileIds: [] })
    ).rejects.toThrow();
  });
});

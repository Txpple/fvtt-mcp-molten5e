/**
 * Unit tests for the Region domain: the pure teleport-destination helpers (Set/Array/legacy-singular
 * normalization + the remap state machine — moved here with the code from scenes.ts), the dump, and
 * the descriptor's create/patch mapping (incl. the ctx-powered grid-rect convenience and the
 * NEVER-emit-behaviors rule). The game-touching special ops (createSceneTeleporter, remap) are
 * live-verified by convention.
 */

import { describe, it, expect } from 'vitest';
import {
  dumpRegion,
  regionDescriptor,
  remapTeleportDestination,
  teleportDestUuid,
  teleportDestinationsOf,
} from './region.js';

describe('teleportDestUuid', () => {
  it('builds a v12+ region teleport destination UUID', () => {
    expect(teleportDestUuid('sABC', 'rXYZ')).toBe('Scene.sABC.Region.rXYZ');
  });
});

describe('teleportDestinationsOf', () => {
  it('reads the LIVE `destinations` SET (v14.364 SetField model value)', () => {
    // The teleportToken `destinations` field is a SetField: the live model exposes a Set (an array
    // only via toObject()). dumpRegion/remap read the live doc, so a Set must be handled.
    expect(teleportDestinationsOf({ destinations: new Set(['Scene.a.Region.b']) })).toEqual([
      'Scene.a.Region.b',
    ]);
  });

  it('reads a plain destinations ARRAY (toObject() shape)', () => {
    expect(
      teleportDestinationsOf({
        destinations: ['Scene.a.Region.b', 'Scene.c.Region.d'],
      })
    ).toEqual(['Scene.a.Region.b', 'Scene.c.Region.d']);
  });

  it('falls back to a singular `destination` for pre-migration data', () => {
    expect(teleportDestinationsOf({ destination: 'Scene.a.Region.b' })).toEqual([
      'Scene.a.Region.b',
    ]);
  });

  it('prefers the plural over a stale singular when both exist', () => {
    expect(
      teleportDestinationsOf({
        destinations: ['Scene.new.Region.new'],
        destination: 'Scene.old.Region.old',
      })
    ).toEqual(['Scene.new.Region.new']);
  });

  it('drops empty / non-string entries and returns [] for a non-teleport behavior', () => {
    expect(teleportDestinationsOf({ destinations: ['Scene.a.Region.b', '', 42, null] })).toEqual([
      'Scene.a.Region.b',
    ]);
    expect(teleportDestinationsOf({})).toEqual([]);
    expect(teleportDestinationsOf(undefined)).toEqual([]);
    expect(teleportDestinationsOf({ destination: '' })).toEqual([]);
  });
});

describe('remapTeleportDestination', () => {
  const sceneIdMap = { oldSceneA: 'newSceneA', oldSceneC: 'newSceneC' };
  const regionIdMap = { oldRegB: 'newRegB', oldRegD: 'newRegD' };

  it('rewrites a Scene.X.Region.Y destination using both maps', () => {
    const res = remapTeleportDestination('Scene.oldSceneC.Region.oldRegD', sceneIdMap, regionIdMap);
    expect(res).toEqual({ status: 'rewritten', dest: 'Scene.newSceneC.Region.newRegD' });
  });

  it('reports unchanged when the destination already equals the rewrite', () => {
    const res = remapTeleportDestination(
      'Scene.newSceneC.Region.newRegD',
      { newSceneC: 'newSceneC' },
      { newRegD: 'newRegD' }
    );
    expect(res.status).toBe('unchanged');
  });

  it('is IDEMPOTENT: a destination already holding the new ids (map VALUES) is unchanged, not unresolved', () => {
    const res = remapTeleportDestination('Scene.newSceneC.Region.newRegD', sceneIdMap, regionIdMap);
    expect(res.status).toBe('unchanged');
  });

  it('is no-match for a non-teleport / unset destination', () => {
    expect(remapTeleportDestination(undefined, sceneIdMap, regionIdMap).status).toBe('no-match');
    expect(remapTeleportDestination('', sceneIdMap, regionIdMap).status).toBe('no-match');
    expect(remapTeleportDestination('Macro.abc', sceneIdMap, regionIdMap).status).toBe('no-match');
  });

  it('is unresolved (and reports the original) when the target scene or region was not imported', () => {
    const res = remapTeleportDestination('Scene.ghost.Region.oldRegB', sceneIdMap, regionIdMap);
    expect(res.status).toBe('unresolved');
    expect(res.reason).toBe('Scene.ghost.Region.oldRegB');
    expect(
      remapTeleportDestination('Scene.oldSceneA.Region.gone', sceneIdMap, regionIdMap).status
    ).toBe('unresolved');
  });
});

describe('dumpRegion', () => {
  it('serializes shapes bounds + teleport destinations (live Set tolerated)', () => {
    const region = {
      id: 'r1',
      name: 'Teleporter → Cave',
      shapes: [{ type: 'rectangle', x: 700, y: 840, width: 140, height: 140 }],
      behaviors: {
        contents: [
          { type: 'teleportToken', system: { destinations: new Set(['Scene.s2.Region.r2']) } },
          { type: 'executeMacro', system: {} },
        ],
      },
    };
    expect(dumpRegion(region)).toEqual({
      id: 'r1',
      name: 'Teleporter → Cave',
      shapes: [{ type: 'rectangle', x: 700, y: 840, width: 140, height: 140 }],
      behaviors: [
        { type: 'teleportToken', destinations: ['Scene.s2.Region.r2'] },
        { type: 'executeMacro' },
      ],
    });
  });
});

describe('regionDescriptor.toCreateDoc', () => {
  it('carries shapes/color/visibility/behaviors whole and defaults the name by batch index', () => {
    const r = regionDescriptor.toCreateDoc!(
      {
        color: '#3fb0ff',
        visibility: 0,
        shapes: [{ type: 'rectangle', x: 0, y: 0, width: 140, height: 140 }],
        behaviors: [{ type: 'teleportToken', system: { destinations: ['Scene.a.Region.b'] } }],
      },
      { scene: {}, index: 1 }
    ) as { doc?: any };
    expect(r.doc).toMatchObject({
      name: 'Region 2',
      color: '#3fb0ff',
      visibility: 0,
      shapes: [{ type: 'rectangle' }],
      behaviors: [{ type: 'teleportToken' }],
    });
  });

  it('errors (isolated) when no shape is given', () => {
    const r = regionDescriptor.toCreateDoc!({ name: 'X', shapes: [] }, { scene: {}, index: 0 });
    expect((r as any).error).toMatch(/shape/);
  });
});

describe('regionDescriptor.buildPatch', () => {
  it('reshapes via the grid-rect convenience using the ctx scene geometry', () => {
    // 140px cells, background inset 280px — the snapped 3-cell-wide rect the review loop wants.
    const scene = { dimensions: { size: 140, sceneX: 280, sceneY: 280 } };
    const r = regionDescriptor.buildPatch!(
      {},
      { id: 'r1', rect: { x: 851, y: 881, widthCells: 3 } },
      { scene }
    ) as { changed: boolean; patch?: any };
    expect(r.changed).toBe(true);
    const shape = r.patch.shapes[0];
    expect(shape).toMatchObject({ type: 'rectangle', width: 420, height: 140 });
    expect((shape.x - 280) % 140).toBe(0); // grid-snapped
    expect((shape.y - 280) % 140).toBe(0);
  });

  it('explicit shapes win over rect; behaviors are NEVER emitted', () => {
    const r = regionDescriptor.buildPatch!(
      {},
      {
        id: 'r1',
        name: ' Trap ',
        shapes: [{ type: 'ellipse', x: 1, y: 2, radiusX: 3, radiusY: 4 }],
        rect: { x: 0, y: 0 },
        behaviors: [{ type: 'teleportToken' }],
      } as any,
      { scene: {} }
    ) as { patch?: any };
    expect(r.patch.name).toBe('Trap');
    expect(r.patch.shapes[0].type).toBe('ellipse');
    expect(r.patch).not.toHaveProperty('behaviors');
  });

  it('changed:false when only the id is supplied', () => {
    const r = regionDescriptor.buildPatch!({}, { id: 'r1' }, { scene: {} }) as {
      changed: boolean;
    };
    expect(r.changed).toBe(false);
  });
});

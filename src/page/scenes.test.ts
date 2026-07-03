/**
 * Offline unit tests for the pure scene helpers (src/page/scenes.ts) — fog-mode
 * mapping and weather-key normalization. These run in Node with no Foundry
 * globals; the page-coupled write paths (createScene/updateScene, image probe,
 * link resolution) are exercised by the live verify script.
 */

import { describe, it, expect } from 'vitest';
import {
  FOG_MODE_TO_NUMBER,
  fogModeToNumber,
  fogModeToName,
  normalizeWeatherKey,
  toV14WallRestriction,
  sidecarWallToV14,
  countWallsMissingSight,
  sidecarLightToV14,
  sidecarRegionToV14,
  remapTeleportDestination,
  TOM_CARTOS_FLAG_SCOPE,
  gridRectShape,
  teleportDestUuid,
} from './scenes.js';

describe('fogModeToNumber', () => {
  it('maps each mode name to its v14 numeric fog.mode', () => {
    expect(fogModeToNumber('disabled')).toBe(0);
    expect(fogModeToNumber('individual')).toBe(1);
    expect(fogModeToNumber('shared')).toBe(2);
  });

  it('matches the exported map', () => {
    expect(FOG_MODE_TO_NUMBER).toEqual({ disabled: 0, individual: 1, shared: 2 });
  });

  it('throws on an unknown mode', () => {
    expect(() => fogModeToNumber('bogus')).toThrow(/Invalid fogMode/);
  });
});

describe('fogModeToName', () => {
  it('maps numbers back to names', () => {
    expect(fogModeToName(0)).toBe('disabled');
    expect(fogModeToName(1)).toBe('individual');
    expect(fogModeToName(2)).toBe('shared');
  });

  it('stringifies unknown/absent values', () => {
    expect(fogModeToName(7)).toBe('7');
    expect(fogModeToName(undefined)).toBe('');
    expect(fogModeToName(null)).toBe('');
  });
});

describe('normalizeWeatherKey', () => {
  const keys = ['leaves', 'rain', 'rainStorm', 'fog', 'snow', 'blizzard'];

  it('passes through an exact key', () => {
    expect(normalizeWeatherKey('snow', keys)).toBe('snow');
    expect(normalizeWeatherKey('rainStorm', keys)).toBe('rainStorm');
  });

  it('normalizes case-insensitively to the canonical key', () => {
    expect(normalizeWeatherKey('SNOW', keys)).toBe('snow');
    expect(normalizeWeatherKey('rainstorm', keys)).toBe('rainStorm');
  });

  it('treats empty/nullish as "none"', () => {
    expect(normalizeWeatherKey('', keys)).toBe('');
    expect(normalizeWeatherKey(null, keys)).toBe('');
    expect(normalizeWeatherKey(undefined, keys)).toBe('');
  });

  it('throws on an unknown key, listing the available ones', () => {
    expect(() => normalizeWeatherKey('thunder', keys)).toThrow(/Unknown weather "thunder"/);
    expect(() => normalizeWeatherKey('thunder', keys)).toThrow(/snow/);
  });
});

describe('toV14WallRestriction', () => {
  it('maps legacy small ints to v14 WALL_SENSE_TYPES', () => {
    expect(toV14WallRestriction(0)).toBe(0); // NONE
    expect(toV14WallRestriction(1)).toBe(20); // legacy NORMAL → 20
    expect(toV14WallRestriction(2)).toBe(10); // legacy LIMITED → 10
    expect(toV14WallRestriction(3)).toBe(30); // PROXIMITY
    expect(toV14WallRestriction(4)).toBe(40); // DISTANCE
  });

  it('passes through values already in the v14 set', () => {
    for (const v of [0, 10, 20, 30, 40]) expect(toV14WallRestriction(v)).toBe(v);
  });

  it('treats non-positive / non-finite as NONE and unknown positive as NORMAL', () => {
    expect(toV14WallRestriction(-5)).toBe(0);
    expect(toV14WallRestriction(undefined)).toBe(0);
    expect(toV14WallRestriction(Number.NaN)).toBe(0);
    expect(toV14WallRestriction(7)).toBe(20);
    expect(toV14WallRestriction(99)).toBe(20);
  });
});

describe('sidecarWallToV14', () => {
  it('converts a legacy wall (sense → sight + light, small ints → v14)', () => {
    const w = sidecarWallToV14({ c: [10, 20, 30, 40], move: 1, sense: 1, sound: 1, door: 0 });
    expect(w).toEqual({ c: [10, 20, 30, 40], sight: 20, light: 20, move: 20, sound: 20, door: 0 });
  });

  it('maps a legacy LIMITED sense (2) to sight+light 10', () => {
    const w = sidecarWallToV14({ c: [0, 0, 5, 5], sense: 2 });
    expect(w?.sight).toBe(10);
    expect(w?.light).toBe(10);
  });

  it('writes coordinates verbatim (absolute canvas pixels, no scaling)', () => {
    expect(sidecarWallToV14({ c: [4045, 2697, 4045, 3149] })?.c).toEqual([4045, 2697, 4045, 3149]);
  });

  it('keeps a door type and preserves a v14-shaped wall without mirroring sense', () => {
    const w = sidecarWallToV14({ c: [1, 2, 3, 4], door: 1, sight: 20, light: 10 });
    expect(w?.door).toBe(1);
    expect(w?.sight).toBe(20);
    expect(w?.light).toBe(10); // explicit v14 light wins; no sense to mirror
  });

  it('returns null when coordinates are missing or invalid', () => {
    expect(sidecarWallToV14({})).toBeNull();
    expect(sidecarWallToV14({ c: [1, 2, 3] })).toBeNull();
    expect(sidecarWallToV14({ c: [1, 2, 3, Number.NaN] })).toBeNull();
  });

  it('omits sight when neither sight nor sense is given (Foundry then defaults it to NORMAL)', () => {
    // Regression: a wall carrying only the OTHER channels (the shape produced by a
    // remap that copied light/move/sound but dropped sight) must not invent a sight
    // value — it is omitted here and Foundry defaults it to NORMAL. countWallsMissingSight
    // is what surfaces that as a warning.
    const w = sidecarWallToV14({ c: [0, 0, 5, 5], light: 10, move: 20, sound: 10 });
    expect(w).not.toHaveProperty('sight');
    expect(w?.light).toBe(10);
    expect(w?.move).toBe(20);
  });

  it('passes authored fields through WHOLE (threshold, animation, flags) and strips source/cli ids', () => {
    // The "pass placeables whole" rule: a v12+ wall carries more than restriction channels —
    // threshold (proximity), animation (door swing/slide), flags — and those must survive import.
    const w = sidecarWallToV14({
      c: [0, 0, 5, 5],
      sight: 30,
      light: 20,
      move: 20,
      threshold: { sight: 12, attenuation: true },
      animation: { direction: 1, type: 'swing' },
      flags: { mod: { tag: 'x' } },
      _id: 'origWallId000000',
      _key: '!scenes.walls!s.w',
    } as any);
    expect(w).toMatchObject({
      threshold: { sight: 12, attenuation: true },
      animation: { direction: 1, type: 'swing' },
      flags: { mod: { tag: 'x' } },
      sight: 30,
    });
    expect(w).not.toHaveProperty('_id');
    expect(w).not.toHaveProperty('_key');
  });
});

describe('countWallsMissingSight', () => {
  it('flags walls that declare light/move/sound but omit both sight and sense', () => {
    // The exact dropped-sight signature: real coords + other channels, no sight/sense.
    const walls = [
      { c: [0, 0, 5, 5], light: 20, move: 20, sound: 20 },
      { c: [5, 5, 9, 9], move: 20 },
    ];
    expect(countWallsMissingSight(walls)).toBe(2);
  });

  it('does not flag walls that carry sight (v14) or sense (legacy)', () => {
    const walls = [
      { c: [0, 0, 5, 5], sight: 10, light: 10, move: 20 }, // v14 sight present
      { c: [5, 5, 9, 9], sense: 1, move: 20 }, // legacy sense present
      { c: [9, 9, 1, 1], sight: 0 }, // sight 0 (none) is explicit, not missing
    ];
    expect(countWallsMissingSight(walls)).toBe(0);
  });

  it('ignores bare {c}-only walls (no restriction channels = intentional default) and invalid coords', () => {
    const walls = [
      { c: [0, 0, 5, 5] }, // no channels at all → not the dropped-sight signature
      { c: [1, 2, 3] }, // invalid segment
      {}, // no coords
    ];
    expect(countWallsMissingSight(walls)).toBe(0);
  });

  it('returns 0 for a missing/empty wall list', () => {
    expect(countWallsMissingSight(undefined)).toBe(0);
    expect(countWallsMissingSight([])).toBe(0);
  });
});

describe('sidecarLightToV14', () => {
  it('nests legacy flat fields under config (tintColor→color, tintAlpha→alpha)', () => {
    const l = sidecarLightToV14({
      x: 2168,
      y: 3522,
      dim: 25,
      bright: 12.5,
      tintColor: '#FFAD00',
      tintAlpha: 0,
    });
    expect(l).toEqual({
      x: 2168,
      y: 3522,
      config: { dim: 25, bright: 12.5, color: '#FFAD00', alpha: 0 },
    });
  });

  it('accepts a v14-shaped light and merges an explicit config', () => {
    const l = sidecarLightToV14({ x: 1, y: 2, color: '#fff', alpha: 0.5, config: { angle: 90 } });
    expect(l).toEqual({ x: 1, y: 2, config: { color: '#fff', alpha: 0.5, angle: 90 } });
  });

  it('passes rotation through and writes x/y verbatim', () => {
    const l = sidecarLightToV14({ x: 100, y: 200, dim: 30, rotation: 45 });
    expect(l.x).toBe(100);
    expect(l.y).toBe(200);
    expect(l.rotation).toBe(45);
    expect((l.config as any).dim).toBe(30);
  });

  it('nests a LEGACY torch light fully (lightAnimation→config.animation, darkness→config.darkness) and strips legacy markers', () => {
    // The real v10 Into-the-Wilds shape: flat emission + a flat lightAnimation + a per-light darkness
    // {min,max} activation range + the legacy `t`/darknessThreshold markers. Dropping animation/darkness
    // silently kills the torch flicker and the darkness-activated glow.
    const l = sidecarLightToV14({
      t: 'l',
      x: 2471,
      y: 980,
      rotation: 0,
      dim: 12,
      bright: 6,
      angle: 0,
      tintColor: '#fcd674',
      tintAlpha: 0.16,
      lightAnimation: { speed: 3, intensity: 3, type: 'torch' },
      darknessThreshold: 0,
      darkness: { min: 0.5, max: 1 },
      hidden: false,
    } as any);
    expect(l.config).toEqual({
      dim: 12,
      bright: 6,
      color: '#fcd674',
      alpha: 0.16,
      angle: 0,
      animation: { speed: 3, intensity: 3, type: 'torch' },
      darkness: { min: 0.5, max: 1 },
    });
    expect(l).toMatchObject({ x: 2471, y: 980, rotation: 0, hidden: false });
    // legacy-only markers must not survive at the top level
    expect(l).not.toHaveProperty('t');
    expect(l).not.toHaveProperty('lightAnimation');
    expect(l).not.toHaveProperty('darkness');
    expect(l).not.toHaveProperty('darknessThreshold');
  });

  it('passes authored top-level fields through WHOLE (walls, vision, hidden, elevation, flags) and strips ids', () => {
    const l = sidecarLightToV14({
      x: 10,
      y: 20,
      rotation: 0,
      walls: false,
      vision: true,
      hidden: true,
      elevation: 5,
      flags: { mod: { tag: 'y' } },
      config: { dim: 30, bright: 10, color: '#fcd674', animation: { type: 'torch' } },
      _id: 'origLightId00000',
      _key: '!scenes.lights!s.l',
    } as any);
    expect(l).toMatchObject({
      x: 10,
      y: 20,
      walls: false,
      vision: true,
      hidden: true,
      elevation: 5,
      flags: { mod: { tag: 'y' } },
      config: { dim: 30, bright: 10, color: '#fcd674', animation: { type: 'torch' } },
    });
    expect(l).not.toHaveProperty('_id');
    expect(l).not.toHaveProperty('_key');
  });
});

describe('sidecarRegionToV14', () => {
  it('passes the region WHOLE (shapes, elevation, behaviors) and strips source/cli ids', () => {
    const r = sidecarRegionToV14({
      _id: 'regSourceId00001',
      _key: '!scenes.regions!s.r',
      _stats: { coreVersion: '13.351' },
      name: 'Stairs Up',
      color: '#abcdef',
      shapes: [{ type: 'rectangle', x: 0, y: 0, width: 100, height: 100 }],
      elevation: { bottom: 0, top: null },
      visibility: 0,
      behaviors: [
        { type: 'teleportToken', system: { destination: 'Scene.A.Region.B', choice: false } },
      ],
    } as any);
    expect(r).toMatchObject({
      name: 'Stairs Up',
      color: '#abcdef',
      shapes: [{ type: 'rectangle', x: 0, y: 0, width: 100, height: 100 }],
      elevation: { bottom: 0, top: null },
      behaviors: [{ type: 'teleportToken', system: { destination: 'Scene.A.Region.B' } }],
    });
    expect(r).not.toHaveProperty('_id');
    expect(r).not.toHaveProperty('_key');
    expect(r).not.toHaveProperty('_stats');
  });

  it('stamps the source _id into the provenance flag so the remap can map old→new', () => {
    const r = sidecarRegionToV14({ _id: 'regSourceId00001', shapes: [] } as any);
    expect((r?.flags as any)[TOM_CARTOS_FLAG_SCOPE]).toEqual({ sourceId: 'regSourceId00001' });
  });

  it('merges the source-id flag without clobbering existing flags', () => {
    const r = sidecarRegionToV14({
      _id: 'regSourceId00002',
      flags: { 'tom-cartos-import': { other: 1 }, mod: { x: 2 } },
    } as any);
    expect((r?.flags as any)['tom-cartos-import']).toEqual({
      other: 1,
      sourceId: 'regSourceId00002',
    });
    expect((r?.flags as any).mod).toEqual({ x: 2 });
  });

  it('omits the flag when there is no source _id, and returns null for non-objects', () => {
    const r = sidecarRegionToV14({ shapes: [] } as any);
    expect(r).not.toHaveProperty('flags');
    expect(sidecarRegionToV14(null as any)).toBeNull();
    expect(sidecarRegionToV14([] as any)).toBeNull();
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
      'Scene.newSceneA.Region.newRegB',
      { newSceneA: 'newSceneA' },
      { newRegB: 'newRegB' }
    );
    expect(res.status).toBe('unchanged');
  });

  it('is IDEMPOTENT: a destination already holding the new ids (map VALUES) is unchanged, not unresolved', () => {
    // Regression (caught live at the e2e): on a second remap pass the destination already points at
    // the NEW scene/region (the map values), which are NOT keys — the old code flagged these
    // already-correct teleporters as "unresolved". They must read as `unchanged`.
    const res = remapTeleportDestination('Scene.newSceneC.Region.newRegD', sceneIdMap, regionIdMap);
    expect(res.status).toBe('unchanged');
    // mixed: scene already-new but region still an old key → resolves to a fresh rewrite
    expect(
      remapTeleportDestination('Scene.oldSceneA.Region.oldRegB', sceneIdMap, regionIdMap).status
    ).toBe('rewritten');
  });

  it('is no-match for a non-teleport / unset destination', () => {
    expect(remapTeleportDestination(undefined, sceneIdMap, regionIdMap).status).toBe('no-match');
    expect(remapTeleportDestination('', sceneIdMap, regionIdMap).status).toBe('no-match');
    expect(remapTeleportDestination('Macro.abc', sceneIdMap, regionIdMap).status).toBe('no-match');
  });

  it('is unresolved (and reports the original) when the target scene or region was not imported', () => {
    const res = remapTeleportDestination(
      'Scene.notImported.Region.oldRegB',
      sceneIdMap,
      regionIdMap
    );
    expect(res.status).toBe('unresolved');
    expect(res.reason).toBe('Scene.notImported.Region.oldRegB');
    // region missing from the map also fails closed
    expect(
      remapTeleportDestination('Scene.oldSceneA.Region.gone', sceneIdMap, regionIdMap).status
    ).toBe('unresolved');
  });
});

describe('teleportDestUuid', () => {
  it('builds a v12+ region teleport destination UUID', () => {
    expect(teleportDestUuid('sABC', 'rXYZ')).toBe('Scene.sABC.Region.rXYZ');
  });
});

describe('gridRectShape', () => {
  // A padded cave: 140px cells, background inset 280px from the padded-canvas origin.
  const grid = { size: 140, sceneX: 280, sceneY: 280 };

  it('centers an un-snapped rectangle on the given point', () => {
    const s = gridRectShape(grid, 1000, 1000, 1, 1, false);
    expect(s).toMatchObject({ type: 'rectangle', width: 140, height: 140, x: 930, y: 930 });
  });

  it('snaps a 1x1 to the grid cell the center sits in (padding-aware)', () => {
    // center (851,881): col=floor((851-280)/140)=4, row=4 → cell top-left (840,840)
    const s = gridRectShape(grid, 851, 881, 1, 1, true);
    expect(s).toMatchObject({ x: 840, y: 840, width: 140, height: 140 });
  });

  it('grows a 3-wide trigger symmetrically around the center cell', () => {
    // center cell col 4 (x0 840) → one cell left (col 3, x 700), 3 cells wide (420px)
    const s = gridRectShape(grid, 851, 881, 3, 1, true);
    expect(s).toMatchObject({ x: 700, y: 840, width: 420, height: 140 });
  });

  it('sizes by whole cells and never smaller than 1 cell', () => {
    const s = gridRectShape(grid, 500, 500, 2, 0, false);
    expect(s.width).toBe(280); // 2 cells
    expect(s.height).toBe(140); // clamped up to 1 cell
  });

  it('falls back to a 100px cell when the grid size is missing', () => {
    const s = gridRectShape({ size: 0, sceneX: 0, sceneY: 0 }, 50, 50, 1, 1, false);
    expect(s).toMatchObject({ width: 100, height: 100, x: 0, y: 0 });
  });
});

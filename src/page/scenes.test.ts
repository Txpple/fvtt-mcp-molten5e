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
  sidecarLightToV14,
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
});

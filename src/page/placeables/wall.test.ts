/**
 * Unit tests for the Wall descriptor: the segment normalizer (wallSegment — the one x0..y1|c[4]
 * home), strict v14 enum validation (fresh authoring errors instead of coercing, unlike the legacy
 * sidecar import), threshold dot-paths, and the never-half-move patch rule. Kernel + wiring are
 * live-verified.
 */

import { describe, it, expect } from 'vitest';
import { wallSegment, wallEnumError, wallDescriptor } from './wall.js';

const CTX = { scene: {} };

describe('wallSegment', () => {
  it('normalizes x0,y0,x1,y1 and c:[4] to the canonical segment', () => {
    expect(wallSegment({ x0: 100, y0: 200, x1: 300, y1: 200 })).toEqual([100, 200, 300, 200]);
    expect(wallSegment({ c: [1, 2, 3, 4] })).toEqual([1, 2, 3, 4]);
  });

  it('returns null on partial/malformed segments (c wins when present)', () => {
    expect(wallSegment({ x0: 1, y0: 2, x1: 3 })).toBeNull();
    expect(wallSegment({ c: [1, 2, 3] })).toBeNull();
    expect(wallSegment({ c: [1, 2, 3, NaN] })).toBeNull();
    expect(wallSegment({})).toBeNull();
  });
});

describe('wallEnumError', () => {
  it('accepts the v14 sets and rejects off-enum values with a hint', () => {
    expect(wallEnumError({ move: 20, sight: 10, door: 2, ds: 1, dir: 0 })).toBeNull();
    expect(wallEnumError({ move: 10 })).toMatch(/move/); // move is 0|20 only
    expect(wallEnumError({ sight: 15 })).toMatch(/sight/);
    expect(wallEnumError({ door: 3 })).toMatch(/door/);
  });
});

describe('wallDescriptor.toCreateDoc', () => {
  it('builds a door wall with nested threshold', () => {
    const r = wallDescriptor.toCreateDoc!(
      {
        x0: 1000,
        y0: 1000,
        x1: 1100,
        y1: 1000,
        door: 1,
        ds: 0,
        sight: 20,
        thresholdSight: 10,
        thresholdAttenuation: true,
      },
      CTX
    ) as { doc?: any };
    expect(r.doc).toEqual({
      c: [1000, 1000, 1100, 1000],
      door: 1,
      ds: 0,
      sight: 20,
      threshold: { sight: 10, attenuation: true },
    });
  });

  it('errors (isolated) on a missing segment or off-enum channel', () => {
    expect((wallDescriptor.toCreateDoc!({ x0: 1, y0: 2 }, CTX) as any).error).toMatch(/segment/);
    expect((wallDescriptor.toCreateDoc!({ c: [0, 0, 10, 0], move: 5 }, CTX) as any).error).toMatch(
      /move/
    );
  });
});

describe('wallDescriptor.buildPatch', () => {
  it('patches door state + threshold dot-paths; moves only with a FULL segment', () => {
    const r = wallDescriptor.buildPatch!(
      {},
      { id: 'w1', ds: 2, door: 2, thresholdLight: 15, c: [5, 5, 50, 5] },
      CTX
    ) as { changed: boolean; patch?: any };
    expect(r.changed).toBe(true);
    expect(r.patch).toEqual({ ds: 2, door: 2, 'threshold.light': 15, c: [5, 5, 50, 5] });
  });

  it('drops a partial segment with a warning instead of half-moving the wall', () => {
    const r = wallDescriptor.buildPatch!({}, { id: 'w1', x0: 10, ds: 1 }, CTX) as {
      changed: boolean;
      patch?: any;
      warnings?: string[];
    };
    expect(r.patch).toEqual({ ds: 1 });
    expect(r.warnings?.join(' ')).toMatch(/segment ignored/);
  });

  it('skips the whole patch (changed:false) on an off-enum value', () => {
    const r = wallDescriptor.buildPatch!({}, { id: 'w1', sight: 15, ds: 1 }, CTX) as {
      changed: boolean;
      warnings?: string[];
    };
    expect(r.changed).toBe(false);
    expect(r.warnings?.join(' ')).toMatch(/sight/);
  });
});

describe('wallDescriptor.dump', () => {
  it('serializes the compact wall line (a 645-wall list must stay small)', () => {
    expect(
      wallDescriptor.dump({
        id: 'w1',
        c: [1, 2, 3, 4],
        move: 20,
        sight: 20,
        light: 20,
        sound: 0,
        dir: 0,
        door: 1,
        ds: 2,
        doorSound: 'woodBasic',
      })
    ).toEqual({
      id: 'w1',
      c: [1, 2, 3, 4],
      move: 20,
      sight: 20,
      light: 20,
      sound: 0,
      dir: 0,
      door: 1,
      ds: 2,
      doorSound: 'woodBasic',
    });
  });
});

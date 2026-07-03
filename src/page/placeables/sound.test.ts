/**
 * Unit tests for the AmbientSound descriptor's field mapping (toCreateDoc / buildPatch / dump).
 * darkness{} and effects{base,muffled} nest; the flat inputs fold in on create, and update writes
 * dot-paths so a partial change never wipes siblings. imgResolves fails OPEN offline, so no 404
 * warning fires here — the KEEP+WARN branch is live-verified. Kernel + wiring are live-verified.
 */

import { describe, it, expect } from 'vitest';
import { soundDescriptor } from './sound.js';

const CTX = { scene: {} };

describe('soundDescriptor.toCreateDoc', () => {
  it('builds the doc with nested darkness + effects from flat inputs', async () => {
    const r = (await soundDescriptor.toCreateDoc!(
      {
        x: 1200,
        y: 900,
        path: 'worlds/w/audio/waterfall.ogg',
        radius: 30,
        name: 'Waterfall',
        volume: 0.8,
        repeat: true,
        walls: false,
        darknessMin: 0.2,
        baseEffect: 'lowpass',
        baseEffectIntensity: 7,
        muffledEffect: 'muffle',
      },
      CTX
    )) as { doc?: any };
    expect(r.doc).toMatchObject({
      x: 1200,
      y: 900,
      path: 'worlds/w/audio/waterfall.ogg',
      radius: 30,
      name: 'Waterfall',
      volume: 0.8,
      repeat: true,
      walls: false,
      darkness: { min: 0.2 },
      effects: { base: { type: 'lowpass', intensity: 7 }, muffled: { type: 'muffle' } },
    });
  });

  it('errors (isolated, not thrown) on missing coordinates, path, or radius', async () => {
    expect(
      (await soundDescriptor.toCreateDoc!({ y: 0, path: 'a.ogg', radius: 5 }, CTX)).error
    ).toMatch(/x/);
    expect((await soundDescriptor.toCreateDoc!({ x: 0, y: 0, radius: 5 }, CTX)).error).toMatch(
      /path/
    );
    expect((await soundDescriptor.toCreateDoc!({ x: 0, y: 0, path: 'a.ogg' }, CTX)).error).toMatch(
      /radius/
    );
  });
});

describe('soundDescriptor.buildPatch', () => {
  it('writes darkness/effects dot-paths and top-level scalars for only-supplied fields', async () => {
    const r = await soundDescriptor.buildPatch!(
      {},
      {
        id: 's1',
        radius: 45,
        volume: 0.5,
        easing: false,
        darknessMax: 0.9,
        baseEffect: 'reverb',
        muffledEffectIntensity: 3,
      },
      CTX
    );
    expect(r.changed).toBe(true);
    expect(r.patch).toEqual({
      radius: 45,
      volume: 0.5,
      easing: false,
      'darkness.max': 0.9,
      'effects.base.type': 'reverb',
      'effects.muffled.intensity': 3,
    });
  });

  it('changed:false when only the id is supplied', async () => {
    const r = await soundDescriptor.buildPatch!({}, { id: 's1' }, CTX);
    expect(r.changed).toBe(false);
  });
});

describe('soundDescriptor.dump', () => {
  it('serializes the salient sound fields', () => {
    const doc = {
      id: 's1',
      name: 'Fire',
      x: 10,
      y: 20,
      radius: 15,
      path: 'worlds/w/audio/fire.ogg',
      volume: 0.5,
      repeat: true,
      walls: true,
      easing: true,
      hidden: false,
      elevation: 0,
      darkness: { min: 0, max: 1 },
      effects: { base: { type: 'lowpass', intensity: 5 } },
    };
    expect(soundDescriptor.dump(doc)).toMatchObject({
      id: 's1',
      name: 'Fire',
      radius: 15,
      path: 'worlds/w/audio/fire.ogg',
      volume: 0.5,
      repeat: true,
      darkness: { min: 0, max: 1 },
      baseEffect: 'lowpass',
    });
  });
});

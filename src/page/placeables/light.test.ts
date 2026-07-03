/**
 * Unit tests for the AmbientLight descriptor's field mapping (toCreateDoc / buildPatch / dump).
 * Emission nests under `config{}`; the flat inputs fold in on create, and update writes `config.*`
 * dot-paths so a partial change never wipes the rest. All sync (no asset check). Kernel + wiring are
 * live-verified.
 */

import { describe, it, expect } from 'vitest';
import { lightDescriptor } from './light.js';

// The kernel always passes a ctx; the Light descriptor doesn't use it.
const CTX = { scene: {} };

describe('lightDescriptor.toCreateDoc', () => {
  it('folds flat emission inputs into the nested config (incl. animation + darkness range)', () => {
    const r = lightDescriptor.toCreateDoc!(
      {
        x: 500,
        y: 600,
        dim: 40,
        bright: 20,
        color: '#fcd674',
        animationType: 'torch',
        animationSpeed: 5,
        animationIntensity: 5,
        darknessMin: 0.1,
        walls: true,
      },
      CTX
    ) as { doc?: any };
    expect(r.doc).toMatchObject({
      x: 500,
      y: 600,
      walls: true,
      config: {
        dim: 40,
        bright: 20,
        color: '#fcd674',
        animation: { type: 'torch', speed: 5, intensity: 5 },
        darkness: { min: 0.1 },
      },
    });
  });

  it('errors on a missing center coordinate', () => {
    expect((lightDescriptor.toCreateDoc!({ x: 0 }, CTX) as { error?: string }).error).toMatch(/y/);
  });
});

describe('lightDescriptor.buildPatch', () => {
  it('writes config.* dot-paths for emission (partial change preserves the rest)', () => {
    const r = lightDescriptor.buildPatch!(
      {},
      { id: 'l1', x: 10, dim: 60, color: '#ffffff', animationType: 'pulse', darknessMin: 0.2 },
      CTX
    ) as { changed: boolean; patch?: any };
    expect(r.changed).toBe(true);
    expect(r.patch).toEqual({
      x: 10,
      'config.dim': 60,
      'config.color': '#ffffff',
      'config.animation.type': 'pulse',
      'config.darkness.min': 0.2,
    });
  });

  it('changed:false when only the id is supplied', () => {
    const r = lightDescriptor.buildPatch!({}, { id: 'l1' }, CTX) as { changed: boolean };
    expect(r.changed).toBe(false);
  });
});

describe('lightDescriptor.dump', () => {
  it('reads the salient emission fields out of config', () => {
    const doc = {
      id: 'l1',
      x: 1,
      y: 2,
      rotation: 0,
      hidden: false,
      walls: true,
      vision: false,
      config: { dim: 40, bright: 20, color: '#fcd674', angle: 360, animation: { type: 'torch' } },
    };
    expect(lightDescriptor.dump(doc)).toMatchObject({
      id: 'l1',
      dim: 40,
      bright: 20,
      color: '#fcd674',
      animation: 'torch',
    });
  });
});

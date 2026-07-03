/**
 * Unit tests for the Tile descriptor's field mapping (toCreateDoc / buildPatch / dump).
 *
 * These are the type-specific correctness the kernel delegates: nested TextureData / occlusion /
 * restrictions / video paths, the width/height-is-size vs texture.scaleX-is-image-zoom distinction, and
 * only-supplied-field patching. imgResolves fails OPEN offline (no network), so no 404 warning fires
 * here — the asset-substitution branch is live-verified. The kernel + page wiring are live-verified.
 */

import { describe, it, expect } from 'vitest';
import { tileDescriptor } from './tile.js';

// The kernel always passes a ctx; the Tile descriptor doesn't use it.
const CTX = { scene: {} };

describe('tileDescriptor.dump', () => {
  it('serializes the salient tile fields (size = width/height, image zoom = texture.scaleX)', () => {
    const doc = {
      id: 't1',
      name: 'Roof',
      x: 100,
      y: 200,
      width: 300,
      height: 400,
      rotation: 15,
      elevation: 5,
      sort: 2,
      hidden: true,
      locked: false,
      texture: { src: 'worlds/w/roof.png', scaleX: 1.5, scaleY: 1.5 },
    };
    expect(tileDescriptor.dump(doc)).toEqual({
      id: 't1',
      name: 'Roof',
      x: 100,
      y: 200,
      width: 300,
      height: 400,
      rotation: 15,
      elevation: 5,
      sort: 2,
      hidden: true,
      locked: false,
      src: 'worlds/w/roof.png',
      scaleX: 1.5,
      scaleY: 1.5,
    });
  });
});

describe('tileDescriptor.toCreateDoc', () => {
  it('builds the nested texture + occlusion(Set as array) + restrictions + video from flat inputs', async () => {
    const r = await tileDescriptor.toCreateDoc!(
      {
        src: 'worlds/w/prop.png',
        x: 10,
        y: 20,
        width: 280,
        height: 320,
        rotation: 90,
        tint: '#ff8800',
        fit: 'contain',
        occlusionMode: 1,
        restrictLight: true,
        videoLoop: true,
        videoVolume: 0,
      },
      CTX
    );
    expect(r.doc).toMatchObject({
      texture: { src: 'worlds/w/prop.png', tint: '#ff8800', fit: 'contain' },
      x: 10,
      y: 20,
      width: 280,
      height: 320,
      rotation: 90,
      occlusion: { modes: [1] }, // SetField written as an array
      restrictions: { light: true },
      video: { loop: true, volume: 0 },
    });
  });

  it('errors (isolated, not thrown) on a missing required field', async () => {
    expect(
      (await tileDescriptor.toCreateDoc!({ x: 0, y: 0, width: 1, height: 1 }, CTX)).error
    ).toMatch(/src/);
    expect(
      (await tileDescriptor.toCreateDoc!({ src: 'a.png', x: 0, y: 0, width: 1 }, CTX)).error
    ).toMatch(/height/);
  });
});

describe('tileDescriptor.buildPatch', () => {
  it('maps only-supplied fields to dot-paths (resize via width/height; image zoom via texture.scaleX)', async () => {
    const r = await tileDescriptor.buildPatch!(
      {},
      { id: 't1', width: 400, height: 460, x: 50, scaleX: 2, occlusionMode: 4, hidden: true },
      CTX
    );
    expect(r.changed).toBe(true);
    expect(r.patch).toEqual({
      width: 400,
      height: 460,
      x: 50,
      'texture.scaleX': 2,
      'occlusion.modes': [4],
      hidden: true,
    });
  });

  it('reports changed:false when only the id is supplied', async () => {
    const r = await tileDescriptor.buildPatch!({}, { id: 't1' }, CTX);
    expect(r.changed).toBe(false);
    expect(r.patch).toEqual({});
  });
});

/**
 * Unit tests for the Tile descriptor's field mapping (toCreateDoc / buildPatch / dump).
 *
 * These are the type-specific correctness the kernel delegates: nested TextureData / occlusion /
 * restrictions / video paths, the width/height-is-size vs texture.scaleX-is-image-zoom distinction,
 * only-supplied-field patching, and the v14 anchor conversion — the doc's x/y is its texture-anchor
 * point (default 0.5/0.5 = the tile's CENTER; live-probed 14.364) while the tool contract is
 * TOP-LEFT, so every read/write converts through anchor·size at this seam. imgResolves fails OPEN
 * offline (no network), so no 404 warning fires here — the asset-substitution branch is
 * live-verified. The kernel + page wiring are live-verified.
 */

import { describe, it, expect } from 'vitest';
import { tileDescriptor } from './tile.js';

// The kernel always passes a ctx; the Tile descriptor doesn't use it.
const CTX = { scene: {} };

describe('tileDescriptor.dump', () => {
  it('serializes the salient fields, reporting x/y as the render TOP-LEFT (doc − anchor·size)', () => {
    const doc = {
      id: 't1',
      name: 'Roof',
      // Doc anchor point (center, default 0.5 anchor): (250, 400) for a 300×400 tile → TL (100, 200).
      x: 250,
      y: 400,
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

  it('respects a non-default texture anchor (anchor 0 ⇒ doc x/y already IS the top-left)', () => {
    const doc = {
      id: 't2',
      x: 250,
      y: 400,
      width: 300,
      height: 400,
      texture: { src: 'a.png', anchorX: 0, anchorY: 0 },
    };
    expect(tileDescriptor.dump(doc)).toMatchObject({ x: 250, y: 400 });
  });
});

describe('tileDescriptor.toCreateDoc', () => {
  it('converts the tool top-left x/y to the doc anchor point (+size/2) and nests texture/occlusion/restrictions/video', async () => {
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
      x: 150, // 10 + 280/2 — v14 stores the CENTER (default anchor 0.5)
      y: 180, // 20 + 320/2
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
  // A live doc the kernel would hand us: 200×100 tile, doc anchor (center) at (200, 300) → TL (100, 250).
  const EXISTING = { x: 200, y: 300, width: 200, height: 100, texture: { src: 'a.png' } };

  it('maps only-supplied fields to dot-paths, converting x/y and re-anchoring on resize', async () => {
    const r = await tileDescriptor.buildPatch!(
      EXISTING,
      { id: 't1', x: 50, width: 400, height: 460, scaleX: 2, occlusionMode: 4, hidden: true },
      CTX
    );
    expect(r.changed).toBe(true);
    expect(r.patch).toEqual({
      width: 400,
      height: 460,
      x: 250, // new TL 50 + 400/2
      y: 480, // no y given: TL 250 stays fixed → 250 + 460/2
      'texture.scaleX': 2,
      'occlusion.modes': [4],
      hidden: true,
    });
  });

  it('MOVE: an incoming x is the new top-left, written as doc x + anchor·width', async () => {
    const r = await tileDescriptor.buildPatch!(EXISTING, { id: 't1', x: 150 }, CTX);
    expect(r.patch).toEqual({ x: 250 }); // 150 + 200/2
  });

  it('RESIZE without x/y keeps the top-left corner fixed (the doc anchor point shifts)', async () => {
    const r = await tileDescriptor.buildPatch!(EXISTING, { id: 't1', width: 300 }, CTX);
    expect(r.patch).toEqual({ width: 300, x: 250 }); // TL stays 100 → 100 + 300/2
  });

  it('reports changed:false for a no-op move (x equal to the current top-left)', async () => {
    const r = await tileDescriptor.buildPatch!(EXISTING, { id: 't1', x: 100 }, CTX);
    expect(r.changed).toBe(false);
    expect(r.patch).toEqual({});
  });

  it('reports changed:false when only the id is supplied', async () => {
    const r = await tileDescriptor.buildPatch!(EXISTING, { id: 't1' }, CTX);
    expect(r.changed).toBe(false);
    expect(r.patch).toEqual({});
  });
});

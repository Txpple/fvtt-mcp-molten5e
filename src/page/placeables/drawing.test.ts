/**
 * Unit tests for the Drawing descriptor: the friendly-shapeType→enum mapping with per-type required
 * dims (buildDrawingShape), shape.* dot-path patching (never clobbers type/points), and the compact
 * dump. Kernel + wiring are live-verified.
 */

import { describe, it, expect } from 'vitest';
import { buildDrawingShape, drawingDescriptor } from './drawing.js';

const CTX = { scene: {} };

describe('buildDrawingShape', () => {
  it('maps rectangle/ellipse to r/e with width+height', () => {
    expect(buildDrawingShape({ shapeType: 'rectangle', width: 300, height: 200 }).shape).toEqual({
      type: 'r',
      width: 300,
      height: 200,
    });
    expect(buildDrawingShape({ shapeType: 'ellipse', width: 100, height: 80 }).shape).toEqual({
      type: 'e',
      width: 100,
      height: 80,
    });
  });

  it('defaults to rectangle when shapeType is omitted', () => {
    expect(buildDrawingShape({ width: 10, height: 10 }).shape).toMatchObject({ type: 'r' });
  });

  it('maps circle to c with radius, polygon to p with flat point pairs', () => {
    expect(buildDrawingShape({ shapeType: 'circle', radius: 120 }).shape).toEqual({
      type: 'c',
      radius: 120,
    });
    expect(
      buildDrawingShape({ shapeType: 'polygon', points: [0, 0, 100, 0, 50, 80] }).shape
    ).toEqual({ type: 'p', points: [0, 0, 100, 0, 50, 80] });
  });

  it('errors on missing per-type dims and unknown types', () => {
    expect(buildDrawingShape({ shapeType: 'rectangle', width: 300 }).error).toMatch(/height/);
    expect(buildDrawingShape({ shapeType: 'circle' }).error).toMatch(/radius/);
    expect(buildDrawingShape({ shapeType: 'polygon', points: [0, 0, 1, 1] }).error).toMatch(
      /pairs/
    );
    expect(buildDrawingShape({ shapeType: 'polygon', points: [0, 0, 1, 1, 2] }).error).toMatch(
      /pairs/
    );
    expect(buildDrawingShape({ shapeType: 'blob' }).error).toMatch(/unknown shapeType/);
  });
});

describe('drawingDescriptor.toCreateDoc', () => {
  it('builds a text-labeled rectangle with style fields', async () => {
    const r = (await drawingDescriptor.toCreateDoc!(
      {
        x: 400,
        y: 500,
        shapeType: 'rectangle',
        width: 600,
        height: 300,
        text: 'Secret Area',
        fontSize: 32,
        fillType: 1,
        fillColor: '#ff0000',
        fillAlpha: 0.2,
        strokeWidth: 4,
        hidden: true,
      },
      CTX
    )) as { doc?: any };
    expect(r.doc).toMatchObject({
      x: 400,
      y: 500,
      shape: { type: 'r', width: 600, height: 300 },
      text: 'Secret Area',
      fontSize: 32,
      fillType: 1,
      fillColor: '#ff0000',
      fillAlpha: 0.2,
      strokeWidth: 4,
      hidden: true,
    });
  });

  it('errors (isolated) on missing origin or bad shape dims', async () => {
    expect(
      (await drawingDescriptor.toCreateDoc!({ shapeType: 'circle', radius: 5 }, CTX)).error
    ).toMatch(/x/);
    expect(
      (await drawingDescriptor.toCreateDoc!({ x: 0, y: 0, shapeType: 'circle' }, CTX)).error
    ).toMatch(/radius/);
  });
});

describe('drawingDescriptor.buildPatch', () => {
  it('patches geometry via shape.* dot-paths and styles at top level', async () => {
    const r = await drawingDescriptor.buildPatch!(
      {},
      { id: 'd1', x: 50, width: 800, height: 400, text: '', strokeColor: '#00ff00', hidden: false },
      CTX
    );
    expect(r.changed).toBe(true);
    expect(r.patch).toEqual({
      x: 50,
      'shape.width': 800,
      'shape.height': 400,
      text: '',
      strokeColor: '#00ff00',
      hidden: false,
    });
  });

  it('warns and skips a shapeType change or malformed points instead of half-applying', async () => {
    const r = await drawingDescriptor.buildPatch!(
      {},
      { id: 'd1', shapeType: 'circle', points: [1, 2, 3], rotation: 45 },
      CTX
    );
    expect(r.changed).toBe(true); // rotation still applies
    expect(r.patch).toEqual({ rotation: 45 });
    expect(r.warnings?.join(' ')).toMatch(/shapeType cannot be changed/);
    expect(r.warnings?.join(' ')).toMatch(/points ignored/);
  });
});

describe('drawingDescriptor.dump', () => {
  it('serializes shape geometry with the friendly type name', () => {
    expect(
      drawingDescriptor.dump({
        id: 'd1',
        x: 1,
        y: 2,
        shape: { type: 'p', points: [0, 0, 10, 0, 5, 5] },
        rotation: 0,
        elevation: 0,
        sort: 0,
        text: 'Trap!',
        fillType: 0,
        strokeColor: '#ff0000',
        hidden: true,
        locked: false,
        interface: false,
      })
    ).toMatchObject({ id: 'd1', shapeType: 'polygon', pointCount: 3, text: 'Trap!', hidden: true });
  });
});

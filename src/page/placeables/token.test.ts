/** Unit test for the read-only Token descriptor's dump (disposition-name mapping + art fields). */

import { describe, it, expect } from 'vitest';
import { tokenDescriptor } from './token.js';

describe('tokenDescriptor.dump', () => {
  it('maps the numeric disposition to a name and surfaces art src + scale', () => {
    const doc = {
      id: 'tk1',
      name: 'Dead Guard',
      x: 300,
      y: 400,
      width: 1,
      height: 1,
      rotation: 90,
      elevation: 0,
      hidden: false,
      lockRotation: true,
      disposition: -1,
      actorId: 'actorA',
      texture: { src: 'tokens/guard.webp', scaleX: 1.5 },
      sort: 0,
    };
    expect(tokenDescriptor.dump(doc)).toMatchObject({
      id: 'tk1',
      name: 'Dead Guard',
      disposition: 'hostile',
      actorId: 'actorA',
      src: 'tokens/guard.webp',
      scale: 1.5,
      lockRotation: true,
    });
  });

  it('passes an unknown disposition through unchanged and nulls a missing actorId', () => {
    const out = tokenDescriptor.dump({ id: 'x', disposition: 7, actorId: '', texture: {} });
    expect(out.disposition).toBe(7);
    expect(out.actorId).toBeNull();
  });

  it('is list-only (no create/update hooks)', () => {
    expect(tokenDescriptor.toCreateDoc).toBeUndefined();
    expect(tokenDescriptor.buildPatch).toBeUndefined();
  });
});

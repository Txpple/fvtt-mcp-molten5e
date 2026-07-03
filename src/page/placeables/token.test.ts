/**
 * Unit tests for the Token placeable file: the dump (disposition-name mapping + art fields), the
 * pure placement-override builder (place-tokens), and the pure placed-token patch builder
 * (update-token, incl. the lockRotation auto-unlock gotcha). The game-touching resolve/place/update
 * paths are live-verified by convention.
 */

import { describe, it, expect } from 'vitest';
import {
  buildHpPatch,
  buildTokenUpdate,
  tokenDescriptor,
  tokenPlacementOverrides,
} from './token.js';

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

  it('supports place (create) but NOT generic update (that is the bespoke update-token)', () => {
    expect(tokenDescriptor.toCreateDoc).toBeDefined();
    expect(tokenDescriptor.buildPatch).toBeUndefined();
  });
});

describe('tokenPlacementOverrides — the pure place-tokens override builder', () => {
  it('requires x and y', () => {
    expect(tokenPlacementOverrides({ y: 5 }).error).toMatch(/x/);
    expect(tokenPlacementOverrides({ x: 5 }).error).toMatch(/y/);
  });

  it('overrides only supplied fields (house prototype defaults survive)', () => {
    const { overrides } = tokenPlacementOverrides({ x: 100, y: 200 });
    expect(overrides).toEqual({ x: 100, y: 200 });
  });

  it('maps disposition names to CONST numbers (case-insensitive)', () => {
    expect(tokenPlacementOverrides({ x: 0, y: 0, disposition: 'hostile' }).overrides).toMatchObject(
      { disposition: -1 }
    );
    expect(tokenPlacementOverrides({ x: 0, y: 0, disposition: 'Secret' }).overrides).toMatchObject({
      disposition: -2,
    });
    expect(tokenPlacementOverrides({ x: 0, y: 0, disposition: 'buddy' }).error).toMatch(
      /disposition/
    );
  });

  it('passes hidden/elevation/rotation and trims a name override', () => {
    const { overrides } = tokenPlacementOverrides({
      x: 1,
      y: 2,
      hidden: true,
      elevation: 10,
      rotation: 45,
      name: '  Hobgoblin Captain  ',
    });
    expect(overrides).toEqual({
      x: 1,
      y: 2,
      hidden: true,
      elevation: 10,
      rotation: 45,
      name: 'Hobgoblin Captain',
    });
  });
});

describe('buildTokenUpdate — the pure placed-token patch builder (update-token)', () => {
  it('sets rotation and always carries the _id', () => {
    const { update, changed } = buildTokenUpdate({ id: 't1' }, { rotation: 90 });
    expect(update).toMatchObject({ _id: 't1', rotation: 90 });
    expect(changed).toBe(true);
  });

  it('maps `scale` onto BOTH texture.scaleX and texture.scaleY', () => {
    const { update } = buildTokenUpdate({ id: 't1' }, { scale: 1.5 });
    expect(update['texture.scaleX']).toBe(1.5);
    expect(update['texture.scaleY']).toBe(1.5);
  });

  it('GOTCHA: rotating a lockRotation:true token AUTO-UNLOCKS it and warns', () => {
    const { update, warnings } = buildTokenUpdate(
      { id: 't1', lockRotation: true },
      { rotation: 45 }
    );
    expect(update.rotation).toBe(45);
    expect(update.lockRotation).toBe(false);
    expect(warnings.some(w => /auto-unlocked/i.test(w))).toBe(true);
  });

  it('does NOT touch lockRotation when rotating an already-unlocked token', () => {
    const { update, warnings } = buildTokenUpdate(
      { id: 't1', lockRotation: false },
      { rotation: 45 }
    );
    expect(update).not.toHaveProperty('lockRotation');
    expect(warnings).toEqual([]);
  });

  it('respects an EXPLICIT lockRotation:true but warns the rotation will be hidden', () => {
    const { update, warnings } = buildTokenUpdate(
      { id: 't1', lockRotation: false },
      { rotation: 45, lockRotation: true }
    );
    expect(update.lockRotation).toBe(true);
    expect(warnings.some(w => /will hide/i.test(w))).toBe(true);
  });

  it('randomizeRotation uses the injected RNG (deterministic) and unlocks a locked token', () => {
    const { update } = buildTokenUpdate(
      { id: 't1', lockRotation: true },
      { randomizeRotation: true },
      () => 0.5
    );
    expect(update.rotation).toBe(180); // floor(0.5 * 360)
    expect(update.lockRotation).toBe(false);
  });

  it('randomizeRotation overrides an explicit rotation', () => {
    const { update } = buildTokenUpdate(
      { id: 't1' },
      { rotation: 10, randomizeRotation: true },
      () => 0
    );
    expect(update.rotation).toBe(0); // from the RNG, not the 10
  });

  it('passes through elevation / hidden / x / y and trims name', () => {
    const { update } = buildTokenUpdate(
      { id: 't1' },
      { elevation: 5, hidden: true, x: 100, y: 200, name: '  Corpse  ' }
    );
    expect(update).toMatchObject({ elevation: 5, hidden: true, x: 100, y: 200, name: 'Corpse' });
  });

  it('ignores an empty/whitespace name and reports changed:false when nothing but _id is set', () => {
    const { update, changed } = buildTokenUpdate({ id: 't1' }, { name: '   ' });
    expect(update).toEqual({ _id: 't1' });
    expect(changed).toBe(false);
  });

  it('maps displayName / displayBars friendly keys onto CONST.TOKEN_DISPLAY_MODES numbers', () => {
    const { update } = buildTokenUpdate({ id: 't1' }, { displayName: 'always', displayBars: 'hover' });
    expect(update.displayName).toBe(50); // ALWAYS
    expect(update.displayBars).toBe(30); // HOVER
  });

  it('maps displayName "none" to 0 (a falsy value that must still be written)', () => {
    const { update, changed } = buildTokenUpdate({ id: 't1' }, { displayName: 'none' });
    expect(update.displayName).toBe(0);
    expect(changed).toBe(true);
  });

  it('warns on an unknown display mode and does NOT write it', () => {
    const { update, warnings } = buildTokenUpdate({ id: 't1' }, { displayName: 'sometimes' });
    expect(update).not.toHaveProperty('displayName');
    expect(warnings.some(w => /unknown displayName/i.test(w))).toBe(true);
  });

  it('sets the bar attributes via dot-path and clears a bar with "" → null', () => {
    const { update } = buildTokenUpdate({ id: 't1' }, { bar1: 'attributes.hp', bar2: '' });
    expect(update['bar1.attribute']).toBe('attributes.hp');
    expect(update['bar2.attribute']).toBeNull();
  });

  it('toggles the dynamic token ring via ring.enabled (both true and false register a change)', () => {
    expect(buildTokenUpdate({ id: 't1' }, { ring: false }).update['ring.enabled']).toBe(false);
    expect(buildTokenUpdate({ id: 't1' }, { ring: false }).changed).toBe(true);
    expect(buildTokenUpdate({ id: 't1' }, { ring: true }).update['ring.enabled']).toBe(true);
  });
});

describe('buildHpPatch — the pure per-token HP patch builder (update-token hp)', () => {
  it('returns null when no hp object is supplied', () => {
    expect(buildHpPatch(undefined)).toBeNull();
  });

  it('returns null for an empty hp object (nothing to change)', () => {
    expect(buildHpPatch({})).toBeNull();
  });

  it('maps current HP onto the system.attributes.hp.value dot-path', () => {
    expect(buildHpPatch({ value: 20 })).toEqual({ 'system.attributes.hp.value': 20 });
  });

  it('maps value + max together (the "reset to a lower max" case)', () => {
    expect(buildHpPatch({ value: 35, max: 35 })).toEqual({
      'system.attributes.hp.value': 35,
      'system.attributes.hp.max': 35,
    });
  });

  it('writes temp and tempmax when given', () => {
    expect(buildHpPatch({ temp: 5, tempmax: -3 })).toEqual({
      'system.attributes.hp.temp': 5,
      'system.attributes.hp.tempmax': -3,
    });
  });

  it('treats 0 as a real value (a downed creature), not an absent field', () => {
    expect(buildHpPatch({ value: 0 })).toEqual({ 'system.attributes.hp.value': 0 });
  });

  it('writes ONLY the sub-fields supplied (max stays untouched when only value is set)', () => {
    const patch = buildHpPatch({ value: 16 });
    expect(patch).not.toBeNull();
    expect(patch).not.toHaveProperty('system.attributes.hp.max');
  });
});

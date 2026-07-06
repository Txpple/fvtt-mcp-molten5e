/**
 * Unit tests for buildFreeCastUpdate — the pure core of add-free-cast. Fixtures mirror the live
 * shapes: a Bless-like single-activity spell and a Hunter's-Mark-like multi-activity spell (whose
 * premium copy ships the pattern natively).
 */

import { describe, it, expect } from 'vitest';
import { buildFreeCastUpdate } from './free-cast.js';

const NEW_ID = 'testFreeCastId00';

function blessLike() {
  return {
    name: 'Bless',
    type: 'spell',
    system: {
      uses: { max: '', spent: 0, recovery: [] },
      activities: {
        dnd5eactivity000: {
          _id: 'dnd5eactivity000',
          type: 'utility',
          sort: 0,
          activation: { type: 'action', value: null, override: false },
          consumption: { targets: [], scaling: { allowed: false }, spellSlot: true },
        },
      },
    },
  };
}

function huntersMarkLike() {
  return {
    name: "Hunter's Mark",
    type: 'spell',
    system: {
      uses: {
        max: '@scale.ranger.favored-enemy',
        spent: 1,
        recovery: [{ period: 'lr', type: 'recoverAll' }],
      },
      activities: {
        dnd5eactivity000: {
          _id: 'dnd5eactivity000',
          type: 'damage',
          sort: 200000,
          activation: { type: '', override: true },
          consumption: { targets: [], scaling: { allowed: false }, spellSlot: false },
        },
        castActivity0000: {
          _id: 'castActivity0000',
          type: 'utility',
          sort: 100000,
          name: 'Mark Creature',
          activation: { type: 'bonus', override: false },
          consumption: { targets: [], scaling: { allowed: false }, spellSlot: true },
        },
        moveMarkActivity: {
          _id: 'moveMarkActivity',
          type: 'utility',
          sort: 300000,
          activation: { type: 'bonus', override: true },
          consumption: { targets: [], scaling: { allowed: false }, spellSlot: false },
        },
      },
    },
  };
}

describe('buildFreeCastUpdate', () => {
  it('wires uses + a convention-named forward onto a single-activity spell', () => {
    const built = buildFreeCastUpdate(blessLike(), { grantedBy: 'Magic Initiate' }, NEW_ID);
    expect(built.activityId).toBe(NEW_ID);
    expect(built.activityName).toBe('Bless - Magic Initiate');
    expect(built.targetActivityId).toBe('dnd5eactivity000');
    expect(built.reused).toBe(false);
    expect(built.warnings).toEqual([]);

    const uses = built.update['system.uses'] as any;
    expect(uses).toEqual({ max: '1', spent: 0, recovery: [{ period: 'lr', type: 'recoverAll' }] });

    const fwd = built.update[`system.activities.${NEW_ID}`] as any;
    expect(fwd.type).toBe('forward');
    expect(fwd.name).toBe('Bless - Magic Initiate');
    expect(fwd.activity).toEqual({ id: 'dnd5eactivity000' });
    expect(fwd.consumption.targets).toEqual([
      { type: 'itemUses', target: '', value: '1', scaling: {} },
    ]);
    // The forward inherits the target's activation type so a bonus-action spell stays bonus.
    expect(fwd.activation).toEqual({ type: 'action', override: false });
  });

  it('targets the lowest-sort slot-consuming activity, skipping non-cast activities', () => {
    const spell = huntersMarkLike();
    const built = buildFreeCastUpdate(spell, { grantedBy: 'Favored Enemy', uses: 2 }, NEW_ID);
    // damage (sort 200000, spellSlot false) and move-mark (spellSlot false) are skipped.
    expect(built.targetActivityId).toBe('castActivity0000');
    const fwd = built.update[`system.activities.${NEW_ID}`] as any;
    expect(fwd.activation.type).toBe('bonus');
    expect((built.update['system.uses'] as any).max).toBe('2');
  });

  it('supports a formula uses value and preserves spent on a re-run', () => {
    const spell = huntersMarkLike();
    const built = buildFreeCastUpdate(
      spell,
      { grantedBy: 'Favored Enemy', uses: '@scale.ranger.favored-enemy' },
      NEW_ID
    );
    const uses = built.update['system.uses'] as any;
    expect(uses.max).toBe('@scale.ranger.favored-enemy');
    expect(uses.spent).toBe(1); // spent use survives the edit
    expect(built.warnings).toEqual([]); // same max → no overwrite warning
  });

  it('warns when overwriting a different existing uses.max', () => {
    const spell = huntersMarkLike();
    const built = buildFreeCastUpdate(spell, { grantedBy: 'Favored Enemy', uses: 3 }, NEW_ID);
    expect(built.warnings.some(w => w.includes('overwritten'))).toBe(true);
  });

  it('updates an existing forward in place instead of duplicating (idempotent re-run)', () => {
    const spell = huntersMarkLike();
    (spell.system.activities as any).existingForward0 = {
      _id: 'existingForward0',
      type: 'forward',
      name: 'Mark Creature (free casting)',
      activity: { id: 'castActivity0000' },
      consumption: { targets: [{ type: 'itemUses', target: '', value: '1', scaling: {} }] },
    };
    const built = buildFreeCastUpdate(spell, { grantedBy: 'Favored Enemy' }, NEW_ID);
    expect(built.reused).toBe(true);
    expect(built.activityId).toBe('existingForward0');
    expect(built.update['system.activities.existingForward0']).toBeDefined();
    expect(built.update[`system.activities.${NEW_ID}`]).toBeUndefined();
    expect((built.update['system.activities.existingForward0'] as any).name).toBe(
      "Hunter's Mark - Favored Enemy"
    );
    expect(built.warnings.some(w => w.includes('updated it in place'))).toBe(true);
  });

  it('honors an explicit activityId', () => {
    const spell = huntersMarkLike();
    const built = buildFreeCastUpdate(
      spell,
      { grantedBy: 'Favored Enemy', activityId: 'moveMarkActivity' },
      NEW_ID
    );
    expect(built.targetActivityId).toBe('moveMarkActivity');
  });

  it('rejects a non-spell item', () => {
    expect(() =>
      buildFreeCastUpdate({ name: 'Sword', type: 'weapon', system: {} }, { grantedBy: 'X' }, NEW_ID)
    ).toThrow(/spells only/);
  });

  it('rejects a spell with no slot-consuming cast activity', () => {
    const spell = blessLike();
    spell.system.activities.dnd5eactivity000.consumption.spellSlot = false;
    expect(() => buildFreeCastUpdate(spell, { grantedBy: 'X' }, NEW_ID)).toThrow(
      /no slot-consuming cast activity/
    );
  });

  it('rejects an unknown explicit activityId and a forward as the target', () => {
    const spell = huntersMarkLike();
    expect(() =>
      buildFreeCastUpdate(spell, { grantedBy: 'X', activityId: 'nope' }, NEW_ID)
    ).toThrow(/not found/);
    (spell.system.activities as any).fwd0000000000000 = {
      type: 'forward',
      activity: { id: 'castActivity0000' },
    };
    expect(() =>
      buildFreeCastUpdate(spell, { grantedBy: 'X', activityId: 'fwd0000000000000' }, NEW_ID)
    ).toThrow(/itself a forward/);
  });

  it('rejects an unknown recovery period and a blank grantedBy', () => {
    expect(() =>
      buildFreeCastUpdate(blessLike(), { grantedBy: 'X', recoveryPeriod: 'fortnight' }, NEW_ID)
    ).toThrow(/recoveryPeriod/);
    expect(() => buildFreeCastUpdate(blessLike(), { grantedBy: '  ' }, NEW_ID)).toThrow(
      /grantedBy/
    );
  });
});

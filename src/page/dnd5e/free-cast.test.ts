/**
 * Unit tests for the pure core of add-free-cast: buildFreeCastActivityPlan (the cast activity on
 * the granting FEATURE — the native Additional-Spells shape) and buildRepertoireCleanup (the
 * migration OFF the old forward-on-the-spell shape). Fixtures mirror the live shapes verified on
 * Gren Greenmantle 2026-07-05.
 */

import { describe, it, expect } from 'vitest';
import { buildFreeCastActivityPlan, buildRepertoireCleanup } from './free-cast.js';

const NEW_ID = 'testFreeCastId00';

const BLESS_FACTS = {
  uuid: 'Compendium.dnd-players-handbook.spells.Item.phbsplBless00000',
  name: 'Bless',
  level: 1,
  properties: ['vocal', 'somatic', 'material'],
  activationType: 'action',
};

const HEALING_WORD_FACTS = {
  uuid: 'Compendium.dnd-players-handbook.spells.Item.phbsplHealingWo0',
  name: 'Healing Word',
  level: 1,
  properties: ['vocal'],
  activationType: 'bonus',
};

function magicInitiateLike() {
  return {
    name: 'Magic Initiate',
    type: 'feat',
    system: { activities: {} },
  };
}

/** A repertoire spell carrying the OLD free-cast shape (pool + forward), as the old tool wrote it. */
function oldShapeBless() {
  return {
    name: 'Bless',
    type: 'spell',
    system: {
      prepared: 1,
      uses: { max: '1', spent: 0, recovery: [{ period: 'lr', type: 'recoverAll' }] },
      activities: {
        dnd5eactivity000: {
          _id: 'dnd5eactivity000',
          type: 'utility',
          consumption: { targets: [], spellSlot: true },
        },
        mcpFwdFreeCast01: {
          _id: 'mcpFwdFreeCast01',
          type: 'forward',
          name: 'Bless - Magic Initiate',
          activity: { id: 'dnd5eactivity000' },
        },
      },
    },
  };
}

describe('buildFreeCastActivityPlan', () => {
  it('plans a self-contained cast activity on the feature (the Additional Spells shape)', () => {
    const plan = buildFreeCastActivityPlan(magicInitiateLike(), BLESS_FACTS, {}, NEW_ID);
    expect(plan.activityId).toBe(NEW_ID);
    expect(plan.activityName).toBe('Bless - Magic Initiate');
    expect(plan.reused).toBe(false);
    expect(plan.warnings).toEqual([]);

    const act = plan.update[`system.activities.${NEW_ID}`] as any;
    expect(act.type).toBe('cast');
    expect(act.name).toBe('Bless - Magic Initiate');
    expect(act.spell.uuid).toBe(BLESS_FACTS.uuid);
    expect(act.spell.level).toBe(1);
    expect(act.spell.properties).toEqual(['vocal', 'somatic', 'material']);
    // spellbook: true is what projects the entry into the native "Additional Spells" section.
    expect(act.spell.spellbook).toBe(true);
    // The pool lives ON the activity: 1/long rest, one activity-use per cast, never a spell slot.
    expect(act.uses).toEqual({
      spent: 0,
      max: '1',
      recovery: [{ period: 'lr', type: 'recoverAll' }],
    });
    expect(act.consumption.spellSlot).toBe(false);
    expect(act.consumption.targets).toEqual([
      { type: 'activityUses', value: '1', target: '', scaling: { mode: '', formula: '' } },
    ]);
  });

  it("inherits the SPELL's own casting time (Healing Word stays a bonus action)", () => {
    const plan = buildFreeCastActivityPlan(magicInitiateLike(), HEALING_WORD_FACTS, {}, NEW_ID);
    const act = plan.update[`system.activities.${NEW_ID}`] as any;
    expect(act.activation.type).toBe('bonus');
    expect(plan.activityName).toBe('Healing Word - Magic Initiate');
  });

  it('supports a formula uses pool and a non-default recovery period', () => {
    const plan = buildFreeCastActivityPlan(
      { name: 'Favored Enemy', type: 'feat', system: { activities: {} } },
      { ...BLESS_FACTS, name: "Hunter's Mark" },
      { uses: '@scale.ranger.favored-enemy', recoveryPeriod: 'sr' },
      NEW_ID
    );
    const act = plan.update[`system.activities.${NEW_ID}`] as any;
    expect(act.uses.max).toBe('@scale.ranger.favored-enemy');
    expect(act.uses.recovery).toEqual([{ period: 'sr', type: 'recoverAll' }]);
    expect(plan.activityName).toBe("Hunter's Mark - Favored Enemy");
  });

  it('patches an existing cast activity for the same spell in place via sub-paths', () => {
    const feature = magicInitiateLike();
    (feature.system.activities as any).existingCast0000 = {
      _id: 'existingCast0000',
      type: 'cast',
      name: 'Bless - Magic Initiate',
      spell: { uuid: BLESS_FACTS.uuid },
      uses: { max: '1', spent: 1, recovery: [{ period: 'lr', type: 'recoverAll' }] },
    };
    const plan = buildFreeCastActivityPlan(feature, BLESS_FACTS, { uses: 2 }, NEW_ID);
    expect(plan.reused).toBe(true);
    expect(plan.activityId).toBe('existingCast0000');
    expect(plan.update[`system.activities.${NEW_ID}`]).toBeUndefined();
    const base = 'system.activities.existingCast0000';
    expect(plan.update[`${base}.uses.max`]).toBe('2');
    expect(plan.update[`${base}.uses.recovery`]).toEqual([{ period: 'lr', type: 'recoverAll' }]);
    expect(plan.update[`${base}.consumption.spellSlot`]).toBe(false);
    // Spent uses survive BY OMISSION — the patch must not touch uses.spent.
    expect(plan.update[`${base}.uses.spent`]).toBeUndefined();
    // REGRESSION GUARD: resending spell.uuid makes dnd5e delete + re-mint the cached spellbook
    // copy (preUpdateActivities treats it as a spell change) — the patch must never include it.
    expect(JSON.stringify(plan.update)).not.toContain(BLESS_FACTS.uuid);
    expect(plan.warnings.some(w => w.includes('updated it in place'))).toBe(true);
  });

  it('does NOT reuse a cast activity linking a DIFFERENT spell (two grants can share a feature)', () => {
    const feature = magicInitiateLike();
    (feature.system.activities as any).otherSpellCast00 = {
      _id: 'otherSpellCast00',
      type: 'cast',
      spell: { uuid: 'Compendium.dnd-players-handbook.spells.Item.phbsplSomethingE' },
    };
    const plan = buildFreeCastActivityPlan(feature, BLESS_FACTS, {}, NEW_ID);
    expect(plan.reused).toBe(false);
    expect(plan.activityId).toBe(NEW_ID);
  });

  it('rejects a spell as the granting feature and an unknown recovery period', () => {
    expect(() =>
      buildFreeCastActivityPlan(
        { name: 'Bless', type: 'spell', system: {} },
        BLESS_FACTS,
        {},
        NEW_ID
      )
    ).toThrow(/ON the granting FEATURE/);
    expect(() =>
      buildFreeCastActivityPlan(
        magicInitiateLike(),
        BLESS_FACTS,
        { recoveryPeriod: 'fortnight' },
        NEW_ID
      )
    ).toThrow(/recoveryPeriod/);
  });
});

describe('buildRepertoireCleanup', () => {
  it('strips the old shape: forwards + on-spell pool, and raises prepared to always-prepared', () => {
    const cleanup = buildRepertoireCleanup(oldShapeBless());
    expect(cleanup.update).not.toBeNull();
    expect(cleanup.removedForwardIds).toEqual(['mcpFwdFreeCast01']);
    expect(cleanup.clearedPool).toBe(true);
    expect(cleanup.raisedPrepared).toBe(true);
    expect(cleanup.update!['system.activities.-=mcpFwdFreeCast01']).toBeNull();
    expect(cleanup.update!['system.uses']).toEqual({ max: '', spent: 0, recovery: [] });
    expect(cleanup.update!['system.prepared']).toBe(2);
    expect(cleanup.warnings.length).toBe(2); // forwards + pool (prepared raise is silent)
  });

  it("strips the premium native forward too (Hunter's Mark converts like everything else)", () => {
    const hm = {
      name: "Hunter's Mark",
      type: 'spell',
      system: {
        prepared: 2,
        uses: { max: '@scale.ranger.favored-enemy', spent: 1, recovery: [{ period: 'lr' }] },
        activities: {
          castActivity0000: { _id: 'castActivity0000', type: 'utility' },
          nativeForward000: {
            _id: 'nativeForward000',
            type: 'forward',
            name: "Hunter's Mark - Favored Enemy",
            activity: { id: 'castActivity0000' },
          },
        },
      },
    };
    const cleanup = buildRepertoireCleanup(hm);
    expect(cleanup.removedForwardIds).toEqual(['nativeForward000']);
    expect(cleanup.clearedPool).toBe(true);
    expect(cleanup.raisedPrepared).toBe(false); // already always-prepared
    expect(cleanup.update!['system.prepared']).toBeUndefined();
  });

  it('returns update: null for an already-clean always-prepared spell', () => {
    const clean = {
      name: 'Chromatic Orb',
      type: 'spell',
      system: {
        prepared: 2,
        uses: { max: '', spent: 0, recovery: [] },
        activities: {
          dnd5eactivity000: { _id: 'dnd5eactivity000', type: 'attack' },
        },
      },
    };
    const cleanup = buildRepertoireCleanup(clean);
    expect(cleanup.update).toBeNull();
    expect(cleanup.removedForwardIds).toEqual([]);
    expect(cleanup.clearedPool).toBe(false);
    expect(cleanup.raisedPrepared).toBe(false);
    expect(cleanup.warnings).toEqual([]);
  });

  it('raises prepared on an otherwise-clean spell (the known-caster always-prepared rule)', () => {
    const cleanup = buildRepertoireCleanup({
      name: 'Bless',
      type: 'spell',
      system: { prepared: 1, uses: { max: '' }, activities: {} },
    });
    expect(cleanup.update).toEqual({ 'system.prepared': 2 });
    expect(cleanup.raisedPrepared).toBe(true);
  });

  it('rejects a non-spell item', () => {
    expect(() => buildRepertoireCleanup({ name: 'Sword', type: 'weapon', system: {} })).toThrow(
      /spells only/
    );
  });
});

/**
 * Offline unit tests for the shared activity builder (src/page/dnd5e/activities.ts).
 *
 * The attack + save cases pin the EXACT object shapes that addAttackToActor /
 * addAttackWithSaveToActor used to build inline — proving routing those tools through buildActivity
 * is behaviorally identical (no drift). The heal/check/utility/damage cases assert the lean shapes
 * (dnd5e fills the rest on create, verified live).
 */

import { describe, it, expect } from 'vitest';
import { buildActivity, damagePartToActivity } from './activities.js';

describe('damagePartToActivity', () => {
  it('maps a raw part to the dnd5e activity-part shape', () => {
    expect(damagePartToActivity({ number: 2, denomination: 6, type: 'fire' })).toEqual({
      types: ['fire'],
      number: 2,
      denomination: 6,
      bonus: '',
      scaling: { mode: '', number: 1 },
      custom: { enabled: false },
    });
  });
});

describe("buildActivity('attack') — byte-equivalent to the old inline attack activity", () => {
  it('2014 melee, no bonus, single base part (no activity parts)', () => {
    const act = buildActivity('attack', {
      id: 'ACT0000000000000',
      activationType: 'action',
      attackType: 'melee',
      attackBonus: 0,
      classification: 'weapon',
      includeBase: true,
      damageParts: [],
    });
    expect(act).toEqual({
      _id: 'ACT0000000000000',
      type: 'attack',
      name: '',
      img: '',
      sort: 0,
      description: {},
      activation: { type: 'action', value: 1, condition: '', override: false },
      duration: { units: '', value: '', override: false },
      target: {
        template: {
          count: '',
          contiguous: false,
          type: '',
          size: '',
          width: '',
          height: '',
          units: '',
        },
        affects: { count: '', type: '', choice: false, special: '' },
        prompt: true,
        override: false,
      },
      range: { units: 'self', override: false },
      uses: { spent: 0, max: '', recovery: [] },
      consumption: { targets: [], scaling: { allowed: false, max: '' }, spellSlot: true },
      attack: {
        ability: '',
        bonus: '',
        critical: { threshold: null },
        flat: false,
        type: { value: 'melee', classification: 'weapon' },
      },
      damage: { critical: { bonus: '' }, includeBase: true, parts: [] },
      effects: [],
      save: { ability: '', dc: { formula: '', calculation: '' } },
    });
  });

  it('2024 sets attack.ability and emits extra damage parts; bonus formats to a string', () => {
    const act = buildActivity('attack', {
      id: 'ACT0000000000000',
      attackType: 'ranged',
      attackBonus: 2,
      classification: '',
      ability: 'dex',
      damageParts: [{ number: 1, denomination: 4, type: 'fire' }],
    });
    expect(act.attack.ability).toBe('dex');
    expect(act.attack.bonus).toBe('2');
    expect(act.attack.type).toEqual({ value: 'ranged', classification: '' });
    expect(act.damage.parts).toEqual([
      damagePartToActivity({ number: 1, denomination: 4, type: 'fire' }),
    ]);
  });
});

describe("buildActivity('save') — byte-equivalent to the old inline save activity", () => {
  it('builds the sort-1 save activity with independent damage', () => {
    const act = buildActivity('save', {
      id: 'SAV0000000000000',
      sort: 1,
      activationType: 'action',
      saveAbility: 'con',
      saveDC: 15,
      onSave: 'none',
      damageParts: [{ number: 2, denomination: 6, type: 'poison' }],
    });
    expect(act).toEqual({
      _id: 'SAV0000000000000',
      type: 'save',
      name: '',
      sort: 1,
      description: {},
      activation: { type: 'action', value: 1, override: false },
      duration: { units: 'inst', concentration: false, override: false },
      effects: [],
      range: { units: 'self', override: false },
      uses: { spent: 0, recovery: [] },
      consumption: { scaling: { allowed: false }, spellSlot: true, targets: [] },
      target: {
        template: {
          count: '',
          contiguous: false,
          type: '',
          size: '',
          width: '',
          height: '',
          units: '',
        },
        affects: { count: '1', type: 'creature', choice: false, special: '' },
        override: false,
        prompt: true,
      },
      damage: {
        onSave: 'none',
        parts: [damagePartToActivity({ number: 2, denomination: 6, type: 'poison' })],
      },
      save: { ability: ['con'], dc: { calculation: '', formula: '15' } },
    });
  });
});

describe('buildActivity — lean types (heal / check / utility / damage)', () => {
  it('heal carries a healing object', () => {
    const a = buildActivity('heal', {
      id: 'H',
      name: 'Cure',
      healing: { number: 2, denomination: 8, type: 'healing' },
    });
    expect(a.type).toBe('heal');
    expect(a.name).toBe('Cure');
    expect(a.healing).toMatchObject({ number: 2, denomination: 8, types: ['healing'] });
  });

  it('check carries ability + dc + associated skills', () => {
    const a = buildActivity('check', {
      id: 'C',
      checkAbility: 'dex',
      checkDC: 15,
      skills: ['acr'],
    });
    expect(a.type).toBe('check');
    expect(a.check).toEqual({
      associated: ['acr'],
      ability: 'dex',
      dc: { calculation: '', formula: '15' },
    });
  });

  it('utility is minimal (e.g. Multiattack)', () => {
    const a = buildActivity('utility', { id: 'U', name: 'Multiattack' });
    expect(a.type).toBe('utility');
    expect(a.name).toBe('Multiattack');
  });

  it('damage carries activity parts', () => {
    const a = buildActivity('damage', {
      id: 'D',
      damageParts: [{ number: 3, denomination: 6, type: 'fire' }],
    });
    expect(a.type).toBe('damage');
    expect(a.damage.parts).toHaveLength(1);
  });

  it('cast (save spell, charged) — byte-equivalent to the live Wand of Fireballs shape', () => {
    const a = buildActivity('cast', {
      id: 'CAST000000000000',
      name: 'Cast Fireball',
      spellUuid: 'Compendium.dnd-players-handbook.spells.Item.phbsplFireball00',
      level: 3,
      spellProperties: ['vocal', 'somatic', 'material'],
      saveDC: 15,
      charges: 1,
    });
    expect(a).toEqual({
      _id: 'CAST000000000000',
      type: 'cast',
      name: 'Cast Fireball',
      img: '',
      sort: 0,
      spell: {
        uuid: 'Compendium.dnd-players-handbook.spells.Item.phbsplFireball00',
        challenge: { save: 15, attack: null, override: true },
        level: 3,
        properties: ['vocal', 'somatic', 'material'],
        spellbook: true,
      },
      activation: { type: 'action', value: null, override: false },
      consumption: {
        scaling: { allowed: false, max: '' },
        spellSlot: false,
        targets: [{ type: 'itemUses', value: '1', target: '', scaling: { mode: '', formula: '' } }],
      },
      description: { chatFlavor: '' },
      duration: { units: 'inst', concentration: false, override: false },
      range: { override: false, units: 'self' },
      target: {
        template: { contiguous: false, units: 'ft', stationary: false },
        affects: { choice: false },
        override: false,
        prompt: true,
      },
      uses: { spent: 0, recovery: [], max: '' },
      flags: {},
      visibility: {
        level: {},
        requireAttunement: false,
        requireIdentification: false,
        requireMagic: false,
      },
    });
  });

  it('cast challenge: attackBonus pins a fixed spell-attack (no save key)', () => {
    const a = buildActivity('cast', {
      id: 'C',
      spellUuid: 'Compendium.dnd-players-handbook.spells.Item.phbsplWitchBolt0',
      attackBonus: 5,
      charges: 1,
    });
    expect(a.spell.challenge).toEqual({ attack: 5, override: true });
  });

  it('cast challenge: neither saveDC nor attackBonus defers to the caster (override:false)', () => {
    const a = buildActivity('cast', {
      id: 'C',
      spellUuid: 'Compendium.dnd-players-handbook.spells.Item.phbsplMagicMissi',
      charges: 1,
    });
    expect(a.spell.challenge).toEqual({ attack: null, override: false });
  });

  it('cast without charges is at-will (empty consumption targets)', () => {
    const a = buildActivity('cast', {
      id: 'C',
      spellUuid: 'Compendium.dnd-players-handbook.spells.Item.phbsplRayOfFrost',
      level: 0,
    });
    expect(a.consumption.targets).toEqual([]);
    expect(a.consumption.spellSlot).toBe(false);
  });

  it('throws on an unknown activity type', () => {
    expect(() => buildActivity('bogus', { id: 'X' })).toThrow(/Unknown activity type/);
  });
});

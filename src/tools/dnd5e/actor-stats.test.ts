/**
 * Unit tests for the dnd5e actor extractors (the single get-actor basicInfo/stats path).
 * Pure functions over a raw Foundry actor document, so no bridge/mocks needed.
 */

import { describe, it, expect } from 'vitest';
import { extractActorStats, extractActorBasicInfo, extractDefenses } from './actor-stats.js';

describe('extractActorBasicInfo', () => {
  it('pulls HP, AC, level, class and a string race', () => {
    const info = extractActorBasicInfo({
      system: {
        attributes: { hp: { value: 18, max: 22, temp: 0 }, ac: { value: 15 } },
        details: { level: { value: 3 }, class: 'Wizard', race: 'Elf' },
      },
    });
    expect(info).toEqual({
      hitPoints: { current: 18, max: 22, temp: 0 },
      armorClass: 15,
      level: 3,
      class: 'Wizard',
      race: 'Elf',
    });
  });

  it('collapses an embedded race item document to its name', () => {
    const info = extractActorBasicInfo({
      system: { details: { race: { name: 'Dwarf', _id: 'r1' } } },
    });
    expect(info.race).toBe('Dwarf');
  });

  it('returns an empty object when system data is missing', () => {
    expect(extractActorBasicInfo({})).toEqual({});
  });

  it('prefers the derived AC value over the (absent) source value', () => {
    const info = extractActorBasicInfo({
      // toObject() source has no ac.value, only calc/flat — the live derived block carries value.
      system: { attributes: { ac: { calc: 'natural', flat: 15 } } },
      derived: { ac: { value: 15 } },
    });
    expect(info.armorClass).toBe(15);
  });
});

describe('extractActorStats', () => {
  it('extracts a PC: abilities/skills with dnd5e value+modifier, no NPC-only fields', () => {
    const stats = extractActorStats({
      name: 'Aria',
      type: 'character',
      system: {
        attributes: { hp: { value: 18, max: 22, temp: 0 }, ac: { value: 15 } },
        details: { level: { value: 3 } },
        abilities: { int: { value: 16, mod: 3 } },
        skills: { arc: { value: 1, ability: 'int' } },
      },
    });
    expect(stats.name).toBe('Aria');
    expect(stats.type).toBe('character');
    expect(stats.level).toBe(3);
    expect(stats.hitPoints).toEqual({ current: 18, max: 22, temp: 0 });
    expect(stats.armorClass).toBe(15);
    expect(stats.abilities.int).toEqual({ value: 16, modifier: 3 });
    // proficiency is derived from the multiplier in `value` (dnd5e has no `proficient` field)
    expect(stats.skills.arc).toEqual({ value: 1, modifier: 0, proficient: 1 });
    // NPC-only fields and spellcasting are absent for a non-spellcaster PC
    expect(stats.creatureType).toBeUndefined();
    expect(stats.legendaryActions).toBeUndefined();
    expect(stats.spellcasting).toBeUndefined();
    expect(stats.saves).toBeUndefined();
  });

  it('surfaces 2024 weapon-mastery kinds and omits the field when unset', () => {
    const withMastery = extractActorStats({
      name: 'Morgash',
      type: 'character',
      system: {
        traits: { weaponProf: { mastery: { value: ['greatsword', 'maul'], bonus: [] } } },
      },
    });
    expect(withMastery.weaponMasteries).toEqual(['greatsword', 'maul']);

    const without = extractActorStats({
      name: 'Salyth',
      type: 'character',
      system: { traits: { weaponProf: { mastery: { value: [], bonus: [] } } } },
    });
    expect(without.weaponMasteries).toBeUndefined();
  });

  it('extracts an NPC: CR, creature type/size/alignment, legendary actions', () => {
    const stats = extractActorStats({
      name: 'Goblin Boss',
      type: 'npc',
      system: {
        details: { cr: 0.25, type: { value: 'humanoid' }, alignment: 'neutral evil' },
        traits: { size: 'small' },
        attributes: { hp: { value: 21, max: 21 }, ac: { value: 17 } },
        abilities: { dex: { value: 14, mod: 2 } },
        resources: { legact: { value: 3, max: 3 } },
      },
    });
    expect(stats.challengeRating).toBe(0.25);
    expect(stats.creatureType).toBe('humanoid');
    expect(stats.size).toBe('small');
    expect(stats.alignment).toBe('neutral evil');
    expect(stats.legendaryActions).toEqual({ available: 3, max: 3 });
    expect(stats.abilities.dex).toEqual({ value: 14, modifier: 2 });
  });

  it('summarizes spellcasting when system.spells is present', () => {
    const stats = extractActorStats({
      name: 'Mage',
      type: 'npc',
      system: { spells: { spell1: { value: 4, max: 4 } } },
    });
    expect(stats.spellcasting).toEqual({ hasSpells: true, spellLevel: 0 });
  });

  it('consumes the derived block for ability mods, skill totals/passive, AC, init, legact, and xp', () => {
    const stats = extractActorStats({
      name: 'Barbed Devil',
      type: 'npc',
      system: {
        // SOURCE (toObject) shape: no mods, no skill totals, ac has no value, legact no value.
        details: { cr: 5, type: { value: 'fiend' } },
        attributes: { hp: { value: 110, max: 110 }, ac: { calc: 'natural', flat: 15 } },
        abilities: { str: { value: 20, proficient: 1 } },
        skills: { prc: { value: 2, ability: 'wis' } },
        resources: { legact: { max: 0, spent: 0 } },
      },
      derived: {
        abilities: { str: { mod: 5 } },
        skills: { prc: { total: 8, passive: 18, mod: 2 } },
        ac: { value: 15 },
        init: { total: 3 },
        legact: { value: 0, max: 0 },
        xp: { value: 1800 },
      },
    });
    expect(stats.armorClass).toBe(15);
    expect(stats.initiative).toBe(3);
    expect(stats.abilities.str).toEqual({ value: 20, modifier: 5 });
    // value 2 = expertise → proficient flag derived as 1 (was wrongly reported 0)
    expect(stats.skills.prc).toEqual({ value: 2, modifier: 8, proficient: 1, passive: 18 });
    expect(stats.legendaryActions).toEqual({ available: 0, max: 0 });
    expect(stats.xp).toBe(1800);
  });

  it('is safe on an actor with no system data', () => {
    const stats = extractActorStats({ name: 'Blank', type: 'npc' });
    expect(stats).toEqual({ name: 'Blank', type: 'npc' });
  });

  it('surfaces damage and condition traits as `defenses`', () => {
    // Previously unreadable: di/dr/dv/ci were write-only through update-actor, so get-actor
    // could not answer "is this skeleton Vulnerable to bludgeoning?" — the 2024 MM shape.
    const stats = extractActorStats({
      name: 'Skeleton',
      type: 'npc',
      system: {
        traits: {
          di: { value: ['poison'], bypasses: [], custom: '' },
          dr: { value: [], bypasses: [], custom: '' },
          dv: { value: ['bludgeoning'], bypasses: [], custom: '' },
          ci: { value: ['exhaustion', 'poisoned'], custom: '' },
        },
      },
    });
    expect(stats.defenses).toEqual({
      damageImmunities: ['poison'],
      damageVulnerabilities: ['bludgeoning'],
      conditionImmunities: ['exhaustion', 'poisoned'],
    });
    // empty buckets are omitted rather than reported as []
    expect(stats.defenses.damageResistances).toBeUndefined();
  });

  it('reports the bypasses qualifier, which inverts the meaning of a resistance', () => {
    const stats = extractActorStats({
      name: 'Ghost',
      type: 'npc',
      system: {
        traits: {
          dr: { value: ['bludgeoning', 'slashing'], bypasses: ['mgc'], custom: 'cold iron' },
        },
      },
    });
    expect(stats.defenses).toEqual({
      damageResistances: ['bludgeoning', 'slashing', 'cold iron'],
      bypasses: ['mgc'],
    });
  });

  it('omits defenses entirely when the creature has none', () => {
    const stats = extractActorStats({
      name: 'Commoner',
      type: 'npc',
      system: { traits: { di: { value: [] }, size: { value: 'med' } } },
    });
    expect(stats.defenses).toBeUndefined();
  });
});

describe('extractDefenses', () => {
  it('returns undefined for absent or malformed traits rather than throwing', () => {
    expect(extractDefenses(undefined)).toBeUndefined();
    expect(extractDefenses(null)).toBeUndefined();
    expect(extractDefenses('nonsense')).toBeUndefined();
    expect(extractDefenses({})).toBeUndefined();
    expect(extractDefenses({ di: { value: 'not-an-array' } })).toBeUndefined();
  });

  it('appends a free-text custom entry to its bucket', () => {
    expect(
      extractDefenses({ dr: { value: ['fire'], custom: 'damage from silvered weapons' } })
    ).toEqual({ damageResistances: ['fire', 'damage from silvered weapons'] });
  });

  it('keeps a bucket that is custom-text only', () => {
    expect(extractDefenses({ ci: { value: [], custom: 'cannot be surprised' } })).toEqual({
      conditionImmunities: ['cannot be surprised'],
    });
  });

  it('de-duplicates bypasses unioned across the damage buckets', () => {
    expect(
      extractDefenses({
        dr: { value: ['slashing'], bypasses: ['mgc', 'ada'] },
        di: { value: ['piercing'], bypasses: ['mgc'] },
      })
    ).toEqual({
      damageImmunities: ['piercing'],
      damageResistances: ['slashing'],
      bypasses: ['mgc', 'ada'],
    });
  });
});

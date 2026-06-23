/**
 * Unit tests for the dnd5e actor extractors (the single get-actor basicInfo/stats path).
 * Pure functions over a raw Foundry actor document, so no bridge/mocks needed.
 */

import { describe, it, expect } from 'vitest';
import { extractActorStats, extractActorBasicInfo } from './actor-stats.js';

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
        skills: { arc: { value: 5, proficient: true, ability: 'int' } },
      },
    });
    expect(stats.name).toBe('Aria');
    expect(stats.type).toBe('character');
    expect(stats.level).toBe(3);
    expect(stats.hitPoints).toEqual({ current: 18, max: 22, temp: 0 });
    expect(stats.armorClass).toBe(15);
    expect(stats.abilities.int).toEqual({ value: 16, modifier: 3 });
    expect(stats.skills.arc).toEqual({ value: 5, modifier: 0, proficient: true });
    // NPC-only fields and spellcasting are absent for a non-spellcaster PC
    expect(stats.creatureType).toBeUndefined();
    expect(stats.legendaryActions).toBeUndefined();
    expect(stats.spellcasting).toBeUndefined();
    expect(stats.saves).toBeUndefined();
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

  it('is safe on an actor with no system data', () => {
    const stats = extractActorStats({ name: 'Blank', type: 'npc' });
    expect(stats).toEqual({ name: 'Blank', type: 'npc' });
  });
});

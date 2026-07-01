/**
 * Offline unit tests for the pure NPC-authoring helpers (src/page/dnd5e/npc.ts): CR
 * normalize/format, the skills block, and buildNpcActorData — the deterministic dnd5e 5.3.3
 * system-data construction extracted from createNpcActor. No Foundry globals, so these run in
 * Node and guard the system-data shape that was previously only checked by the live suite.
 */

import { describe, it, expect, vi } from 'vitest';
import { npcNormalizeCR, npcFormatCR, npcBuildSkillsBlock, buildNpcActorData } from './npc.js';
import type { NpcInput } from './npc.js';

describe('npcNormalizeCR', () => {
  it('parses fractional CRs and integers', () => {
    expect(npcNormalizeCR('1/8')).toBeCloseTo(0.125);
    expect(npcNormalizeCR('1/4')).toBe(0.25);
    expect(npcNormalizeCR('1/2')).toBe(0.5);
    expect(npcNormalizeCR('5')).toBe(5);
    expect(npcNormalizeCR(0)).toBe(0);
    expect(npcNormalizeCR(12)).toBe(12);
  });
});

describe('npcFormatCR', () => {
  it('round-trips the canonical fractional labels and rounds others', () => {
    expect(npcFormatCR(0)).toBe('0');
    expect(npcFormatCR(0.125)).toBe('1/8');
    expect(npcFormatCR(0.25)).toBe('1/4');
    expect(npcFormatCR(0.5)).toBe('1/2');
    expect(npcFormatCR(2)).toBe('2');
    expect(npcFormatCR(11)).toBe('11');
  });
});

describe('npcBuildSkillsBlock', () => {
  it('seeds all 18 skills with their governing ability, flags proficient(1)/expert(2), drops unknowns', () => {
    const out = npcBuildSkillsBlock([
      { skill: 'Perception', proficiency: 'proficient' },
      { skill: 'Stealth', proficiency: 'expert' },
      { skill: 'Underwater Basket Weaving', proficiency: 'proficient' },
    ]);
    // full 18-skill set (like a compendium NPC), unknown skill ignored
    expect(Object.keys(out)).toHaveLength(18);
    expect(out.prc).toEqual({ value: 1, ability: 'wis' });
    expect(out.ste).toEqual({ value: 2, ability: 'dex' });
    // non-proficient skills are still present at value 0, each carrying its ability
    expect(out.ath).toEqual({ value: 0, ability: 'str' });
    expect(out.per).toEqual({ value: 0, ability: 'cha' });
  });
});

function baseNpc(overrides: Partial<NpcInput> = {}): NpcInput {
  return {
    name: 'Test Goblin',
    creatureType: 'humanoid',
    creatureSubtype: 'goblinoid',
    size: 'small',
    alignment: 'neutral evil',
    cr: '1/4',
    hpAverage: 7,
    hpFormula: '2d6',
    acMode: 'default',
    abilities: { str: 8, dex: 14, con: 10, int: 10, wis: 8, cha: 8 },
    savingThrows: ['dex'],
    walkSpeed: 30,
    flySpeed: 0,
    swimSpeed: 0,
    climbSpeed: 0,
    burrowSpeed: 0,
    hover: false,
    darkvision: 60,
    blindsight: 0,
    tremorsense: 0,
    truesight: 0,
    specialSenses: '',
    skills: [{ skill: 'Stealth', proficiency: 'expert' }],
    damageImmunities: [],
    damageResistances: [],
    damageVulnerabilities: [],
    conditionImmunities: [],
    languages: ['common', 'goblin'],
    languagesCustom: '',
    biography: 'A small menace.',
    sourceBook: 'MM',
    sourcePage: '166',
    sourceRules: '2014',
    ...overrides,
  };
}

describe('buildNpcActorData', () => {
  it('constructs a well-formed dnd5e npc system-data model (no folder key)', () => {
    const { actorData, normalizedCR, warnings } = buildNpcActorData(baseNpc());
    expect(warnings).toEqual([]);
    expect(normalizedCR).toBe(0.25);
    expect(actorData.type).toBe('npc');
    expect(actorData.folder).toBeUndefined(); // caller assigns the folder
    expect(actorData.system.details.cr).toBe(0.25);
    expect(actorData.system.traits.size).toBe('sm'); // 'small' → 'sm'
    expect(actorData.system.attributes.hp).toMatchObject({ value: 7, max: 7, formula: '2d6' });
    // all 18 skills seeded with their ability; the proficient one carries its value
    expect(Object.keys(actorData.system.skills)).toHaveLength(18);
    expect(actorData.system.skills.ste).toEqual({ value: 2, ability: 'dex' });
    expect(actorData.system.skills.ath).toEqual({ value: 0, ability: 'str' });
  });

  it('sets save-proficiency flags from savingThrows', () => {
    const { actorData } = buildNpcActorData(baseNpc({ savingThrows: ['dex', 'con'] }));
    expect(actorData.system.abilities.dex.proficient).toBe(1);
    expect(actorData.system.abilities.con.proficient).toBe(1);
    expect(actorData.system.abilities.str.proficient).toBe(0);
  });

  it('defaults the portrait + token to a real creatureType icon (rule 8 — no mystery-man)', () => {
    const undead = buildNpcActorData(baseNpc({ creatureType: 'undead' })).actorData;
    expect(undead.img).toMatch(/^icons\/.+\.webp$/);
    expect(undead.img).not.toMatch(/icons\/svg\//);
    expect(undead.prototypeToken.texture.src).toBe(undead.img);
    // distinct types get distinct icons
    const dragon = buildNpcActorData(baseNpc({ creatureType: 'dragon' })).actorData;
    expect(dragon.img).not.toBe(undead.img);
  });

  it('respects an explicit img override for the portrait + token', () => {
    const { actorData } = buildNpcActorData(
      baseNpc({ img: 'icons/creatures/abilities/dragon-fire-breath-orange.webp' })
    );
    expect(actorData.img).toBe('icons/creatures/abilities/dragon-fire-breath-orange.webp');
    expect(actorData.prototypeToken.texture.src).toBe(actorData.img);
  });

  it('names the prototype token for the NPC so dragged tokens read the creature name', () => {
    const { actorData } = buildNpcActorData(baseNpc({ name: 'Gravewidow' }));
    expect(actorData.prototypeToken.name).toBe('Gravewidow');
  });

  it('uses a flat AC block only in "flat" mode', () => {
    expect(buildNpcActorData(baseNpc()).actorData.system.attributes.ac).toEqual({
      calc: 'default',
    });
    const flat = buildNpcActorData(baseNpc({ acMode: 'flat', acValue: 17 }));
    expect(flat.actorData.system.attributes.ac).toEqual({ calc: 'flat', flat: 17 });
  });

  it('defaults an unknown size to "med"', () => {
    const { actorData } = buildNpcActorData(baseNpc({ size: 'colossal' }));
    expect(actorData.system.traits.size).toBe('med');
  });

  it('warns (without blocking) on unknown damage types and conditions', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { warnings } = buildNpcActorData(
        baseNpc({ damageResistances: ['fire', 'kryptonite'], conditionImmunities: ['hexed'] })
      );
      expect(warnings).toHaveLength(2);
      expect(warnings.some(w => w.includes('kryptonite'))).toBe(true);
      expect(warnings.some(w => w.includes('hexed'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

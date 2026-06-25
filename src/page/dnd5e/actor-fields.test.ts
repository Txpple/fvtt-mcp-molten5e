/**
 * Offline unit tests for the shared dnd5e actor-field mappers (src/page/dnd5e/actor-fields.ts).
 * Pure functions, so they run in Node — they back both NPC creation and actor editing, so a
 * regression here would silently corrupt either path.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeSize,
  normalizeSkill,
  normalizeCR,
  formatCR,
  CREATURE_TYPES,
  CONDITION_TYPES,
  ARMOR_CALC,
  DAMAGE_TYPES,
  ABILITIES,
  SKILL_ABILITY,
  SKILL_KEYS,
} from './actor-fields.js';

describe('normalizeSize', () => {
  it('accepts long names and short codes, case-insensitively', () => {
    expect(normalizeSize('medium')).toBe('med');
    expect(normalizeSize('Large')).toBe('lg');
    expect(normalizeSize('grg')).toBe('grg');
    expect(normalizeSize('GARGANTUAN')).toBe('grg');
  });
  it('returns undefined for an unknown size', () => {
    expect(normalizeSize('colossal')).toBeUndefined();
    expect(normalizeSize('')).toBeUndefined();
  });
});

describe('normalizeSkill', () => {
  it('maps full names and keys to the dnd5e key', () => {
    expect(normalizeSkill('Perception')).toBe('prc');
    expect(normalizeSkill('sleight of hand')).toBe('slt');
    expect(normalizeSkill('prc')).toBe('prc');
  });
  it('returns undefined for an unknown skill', () => {
    expect(normalizeSkill('Underwater Basket Weaving')).toBeUndefined();
  });
});

describe('SKILL_ABILITY', () => {
  it('maps every one of the 18 skill keys to a valid ability', () => {
    expect(Object.keys(SKILL_ABILITY).sort()).toEqual([...SKILL_KEYS].sort());
    for (const ability of Object.values(SKILL_ABILITY)) {
      expect(ABILITIES).toContain(ability);
    }
  });
  it('uses the canonical dnd5e governing abilities', () => {
    expect(SKILL_ABILITY.ath).toBe('str'); // Athletics
    expect(SKILL_ABILITY.per).toBe('cha'); // Persuasion
    expect(SKILL_ABILITY.prc).toBe('wis'); // Perception
    expect(SKILL_ABILITY.arc).toBe('int'); // Arcana
  });
});

describe('normalizeCR / formatCR', () => {
  it('round-trips canonical fractional CRs', () => {
    expect(normalizeCR('1/8')).toBeCloseTo(0.125);
    expect(normalizeCR('5')).toBe(5);
    expect(normalizeCR(0.25)).toBe(0.25);
    expect(formatCR(0.25)).toBe('1/4');
    expect(formatCR(5)).toBe('5');
    expect(formatCR(0)).toBe('0');
  });
});

describe('canonical value sets (live CONFIG.DND5E)', () => {
  it('has the expected sizes/counts', () => {
    expect(CREATURE_TYPES.size).toBe(14);
    expect(CONDITION_TYPES.size).toBe(26);
    expect(ARMOR_CALC.has('natural')).toBe(true);
    expect(DAMAGE_TYPES.has('vitality')).toBe(true); // 5.3.3 added none/vitality
    expect(DAMAGE_TYPES.has('none')).toBe(true);
    expect(ABILITIES).toEqual(['str', 'dex', 'con', 'int', 'wis', 'cha']);
  });
});

/**
 * Offline unit tests for the pure creature-index helpers (src/page/creature-index.ts):
 * projectIndexEntry (compendium INDEX entry -> flat CreatureIndexEntry) and passesCriteria
 * (the filtering contract). No Foundry globals — these guard the index-read rewrite that replaced
 * the former full-document scan, plus the index-specific approximations and the size-key mapping.
 */

import { describe, it, expect } from 'vitest';
import { projectIndexEntry, passesCriteria } from './creature-index.js';

// A compendium index entry as getIndex({fields: CREATURE_INDEX_FIELDS}) returns it: core fields
// plus only the requested system dot-paths, expanded into nested objects.
function indexEntry(overrides: any = {}) {
  return {
    _id: 'abc123',
    name: 'Aarakocra Aeromancer',
    type: 'npc',
    img: 'modules/dnd-monster-manual/assets/aero.webp',
    system: {
      details: { cr: 4, type: { value: 'elemental' }, alignment: 'Neutral' },
      traits: { size: 'med' },
      attributes: { hp: { max: 66 }, ac: { flat: 16 }, spell: { level: 5 } },
      resources: { legact: { max: 3 } },
    },
    ...overrides,
  };
}

describe('projectIndexEntry', () => {
  it('maps a full index entry into the flat contract', () => {
    const out = projectIndexEntry(indexEntry(), 'dnd-monster-manual.actors', 'Monster Manual');
    expect(out).toEqual({
      id: 'abc123',
      name: 'Aarakocra Aeromancer',
      type: 'npc',
      pack: 'dnd-monster-manual.actors',
      packLabel: 'Monster Manual',
      challengeRating: 4,
      creatureType: 'elemental',
      size: 'med', // dnd5e key, not 'medium'
      hitPoints: 66,
      armorClass: 16,
      hasSpells: true, // spell.level > 0
      hasLegendaryActions: true, // legact.max > 0
      alignment: 'neutral',
      description: '',
      img: 'modules/dnd-monster-manual/assets/aero.webp',
    });
  });

  it('handles fractional CR strings (defensive)', () => {
    const out = projectIndexEntry(
      indexEntry({ system: { details: { cr: '1/4' }, traits: { size: 'sm' } } }),
      'p',
      'P'
    );
    expect(out.challengeRating).toBe(0.25);
  });

  it('treats legact.max of 0 as NO legendary actions (object present, number zero)', () => {
    const out = projectIndexEntry(
      indexEntry({ system: { resources: { legact: { max: 0 } }, attributes: {} } }),
      'p',
      'P'
    );
    expect(out.hasLegendaryActions).toBe(false);
  });

  it('treats a missing/zero spell.level as NO spells', () => {
    const noSpell = projectIndexEntry(indexEntry({ system: { attributes: {} } }), 'p', 'P');
    expect(noSpell.hasSpells).toBe(false);
    const zeroSpell = projectIndexEntry(
      indexEntry({ system: { attributes: { spell: { level: 0 } } } }),
      'p',
      'P'
    );
    expect(zeroSpell.hasSpells).toBe(false);
  });

  it('defaults armorClass to 10 when ac.flat is absent (ac.value is derived, not indexed)', () => {
    const out = projectIndexEntry(
      indexEntry({ system: { attributes: { ac: { calc: 'default' } } } }),
      'p',
      'P'
    );
    expect(out.armorClass).toBe(10);
  });
});

describe('passesCriteria', () => {
  const dragon = projectIndexEntry(
    indexEntry({
      name: 'Adult Red Dragon',
      system: {
        details: { cr: 17, type: { value: 'dragon' } },
        traits: { size: 'huge' },
        attributes: { spell: { level: 0 } },
        resources: { legact: { max: 3 } },
      },
    }),
    'dnd-monster-manual.actors',
    'MM'
  );

  it('matches a friendly size enum against the stored dnd5e key', () => {
    const med = projectIndexEntry(indexEntry({ system: { traits: { size: 'med' } } }), 'p', 'P');
    expect(passesCriteria(med, { size: 'medium' })).toBe(true);
    expect(passesCriteria(med, { size: 'large' })).toBe(false);
  });

  it('filters by CR range and exact', () => {
    expect(passesCriteria(dragon, { challengeRating: { min: 15, max: 20 } })).toBe(true);
    expect(passesCriteria(dragon, { challengeRating: { min: 1, max: 5 } })).toBe(false);
    expect(passesCriteria(dragon, { challengeRating: 17 })).toBe(true);
    expect(passesCriteria(dragon, { challengeRating: 16 })).toBe(false);
  });

  it('filters by creature type, legendary, and spellcasting flags', () => {
    expect(passesCriteria(dragon, { creatureType: 'Dragon' })).toBe(true);
    expect(passesCriteria(dragon, { creatureType: 'fiend' })).toBe(false);
    expect(passesCriteria(dragon, { hasLegendaryActions: true })).toBe(true);
    expect(passesCriteria(dragon, { hasSpells: true })).toBe(false);
  });
});

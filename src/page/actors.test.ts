/**
 * Unit tests for extractDamageProfile — the PURE damage-theme reader create-actor-from-compendium uses
 * to surface a copied creature's attack damage types (rule 7: a reskin must reconcile off-theme damage,
 * not reflavor in prose). The async createActorFromCompendium (live copy) is covered by the integration
 * suite + scripts/verify-reskin-visibility.mjs.
 */

import { describe, it, expect } from 'vitest';
import { extractDamageProfile } from './actors.js';

// Minimal source-item shapes (as toSource(item) yields): a weapon's base damage + activity parts.
const weapon = (name: string, baseTypes: string[]) => ({
  name,
  type: 'weapon',
  system: { damage: { base: { types: baseTypes } } },
});
const saveFeat = (name: string, partTypes: string[]) => ({
  name,
  type: 'feat',
  system: { activities: { a1: { type: 'save', damage: { parts: [{ types: partTypes }] } } } },
});

describe('extractDamageProfile', () => {
  it('reads a weapon base damage type', () => {
    const p = extractDamageProfile([weapon('Radiant Flail', ['radiant'])]);
    expect(p.damageTypes).toEqual(['radiant']);
    expect(p.attacks).toEqual([{ name: 'Radiant Flail', types: ['radiant'] }]);
  });

  it('reads damage types from a feat save activity', () => {
    const p = extractDamageProfile([saveFeat('Holy Nova', ['radiant', 'fire'])]);
    expect(p.damageTypes).toEqual(['fire', 'radiant']); // sorted + unioned
    expect(p.attacks[0]).toEqual({ name: 'Holy Nova', types: ['fire', 'radiant'] });
  });

  it('unions across items and de-dupes/sorts the overall type set', () => {
    const p = extractDamageProfile([
      weapon('Bite', ['piercing']),
      saveFeat('Searing Light', ['radiant']),
      weapon('Smite', ['radiant', 'bludgeoning']),
    ]);
    expect(p.damageTypes).toEqual(['bludgeoning', 'piercing', 'radiant']);
    expect(p.attacks).toHaveLength(3);
  });

  it('ignores non-weapon/feat items and items with no damage', () => {
    const p = extractDamageProfile([
      { name: 'Plate Armor', type: 'equipment', system: { armor: { value: 18 } } },
      { name: 'Magic Resistance', type: 'feat', system: { activities: {} } },
    ]);
    expect(p.damageTypes).toEqual([]);
    expect(p.attacks).toEqual([]);
  });

  it('is safe on empty/garbage input', () => {
    expect(extractDamageProfile([])).toEqual({ damageTypes: [], attacks: [] });
    expect(extractDamageProfile(undefined as any)).toEqual({ damageTypes: [], attacks: [] });
  });
});

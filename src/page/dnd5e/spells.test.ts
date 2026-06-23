/**
 * Offline unit tests for planSpellcasting (src/page/dnd5e/spells.ts) — the pure SRD spell-slot
 * resolution extracted from setActorSpellcasting. Runs in Node with no Foundry globals, closing
 * part of the page-layer coverage gap: these slot tables were previously exercised only by the
 * gated live integration suite.
 */

import { describe, it, expect } from 'vitest';
import { planSpellcasting } from './spells.js';

describe('planSpellcasting — full casters', () => {
  it('level 1 wizard: one 1st-level slot, the casting ability, nothing else', () => {
    const { updates, slots, warnings } = planSpellcasting('wizard', 1, 'int');
    expect(updates['system.attributes.spellcasting']).toBe('int');
    expect(updates['system.spells.spell1.max']).toBe(2);
    expect(updates['system.spells.spell1.value']).toBe(2);
    expect(updates['system.spells.spell2.max']).toBe(0);
    expect(updates['system.spells.spell9.max']).toBe(0);
    expect(slots).toEqual({
      spell1: 2,
      spell2: 0,
      spell3: 0,
      spell4: 0,
      spell5: 0,
      spell6: 0,
      spell7: 0,
      spell8: 0,
      spell9: 0,
    });
    expect(warnings).toEqual([]);
  });

  it('level 20 cleric matches the SRD top row [4,3,3,3,3,2,2,1,1]', () => {
    const { slots } = planSpellcasting('cleric', 20, 'wis');
    expect(slots).toEqual({
      spell1: 4,
      spell2: 3,
      spell3: 3,
      spell4: 3,
      spell5: 3,
      spell6: 2,
      spell7: 2,
      spell8: 1,
      spell9: 1,
    });
  });

  it('an unknown class defaults to the full-caster table', () => {
    const { slots } = planSpellcasting('sorcerer', 5, 'cha');
    expect(slots).toEqual({
      spell1: 4,
      spell2: 3,
      spell3: 2,
      spell4: 0,
      spell5: 0,
      spell6: 0,
      spell7: 0,
      spell8: 0,
      spell9: 0,
    });
  });
});

describe('planSpellcasting — half + artificer casters', () => {
  it('artificer rounds UP: level 1 has a slot', () => {
    const { slots, warnings } = planSpellcasting('artificer', 1, 'int');
    expect(slots.spell1).toBe(2);
    expect(warnings).toEqual([]);
  });

  it('artificer level 5 matches [4,2,...]', () => {
    const { slots } = planSpellcasting('artificer', 5, 'int');
    expect(slots).toMatchObject({ spell1: 4, spell2: 2, spell3: 0 });
  });

  it('paladin level 1 has no slots and warns', () => {
    const { slots, warnings } = planSpellcasting('paladin', 1, 'cha');
    expect(slots.spell1).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('paladin level 1 has no spell slots');
  });

  it('ranger level 2 unlocks one 1st-level slot, no warning', () => {
    const { slots, warnings } = planSpellcasting('ranger', 2, 'wis');
    expect(slots.spell1).toBe(2);
    expect(warnings).toEqual([]);
  });
});

describe('planSpellcasting — warlock pact magic', () => {
  it('level 1: a single 1st-level pact slot, all regular slots zeroed', () => {
    const { updates, slots } = planSpellcasting('warlock', 1, 'cha');
    expect(slots).toEqual({ pact: { max: 1, level: 1 } });
    expect(updates['system.spells.pact.max']).toBe(1);
    expect(updates['system.spells.pact.value']).toBe(1);
    expect(updates['system.spells.pact.level']).toBe(1);
    for (let i = 1; i <= 9; i++) {
      expect(updates[`system.spells.spell${i}.max`]).toBe(0);
    }
  });

  it('level 11: three 5th-level pact slots', () => {
    const { slots } = planSpellcasting('warlock', 11, 'cha');
    expect(slots).toEqual({ pact: { max: 3, level: 5 } });
  });

  it('level 20: four 5th-level pact slots', () => {
    const { slots } = planSpellcasting('warlock', 20, 'cha');
    expect(slots).toEqual({ pact: { max: 4, level: 5 } });
  });
});

describe('planSpellcasting — level validation', () => {
  it.each([0, 21, -1, 1.5, Number.NaN])('rejects out-of-range/non-integer level %s', lvl => {
    expect(() => planSpellcasting('wizard', lvl, 'int')).toThrow(/integer 1-20/);
  });
});

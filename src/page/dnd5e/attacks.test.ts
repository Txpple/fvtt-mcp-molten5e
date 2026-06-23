/**
 * Offline unit tests for the pure attack-assembly helpers (src/page/dnd5e/attacks.ts).
 * These encode two subtle dnd5e shape rules that are easy to get wrong: the first damage part is
 * the weapon BASE (so only the rest become activity parts), and melee vs ranged choose reach vs
 * normal/long range. Run in Node with no Foundry globals.
 */

import { describe, it, expect } from 'vitest';
import { buildActivityDamageParts, buildAttackRange, type DamagePart } from './attacks.js';

describe('buildActivityDamageParts', () => {
  it('drops the first part (the weapon base) — a single part yields no activity parts', () => {
    const parts: DamagePart[] = [{ number: 1, denomination: 8, type: 'slashing' }];
    expect(buildActivityDamageParts(parts)).toEqual([]);
  });

  it('emits parts[1..] in the dnd5e activity shape', () => {
    const parts: DamagePart[] = [
      { number: 1, denomination: 8, type: 'slashing' }, // base
      { number: 2, denomination: 6, type: 'fire' }, // bonus
    ];
    expect(buildActivityDamageParts(parts)).toEqual([
      {
        types: ['fire'],
        number: 2,
        denomination: 6,
        bonus: '',
        scaling: { mode: '', number: 1 },
        custom: { enabled: false },
      },
    ]);
  });

  it('handles multiple bonus parts', () => {
    const parts: DamagePart[] = [
      { number: 1, denomination: 6, type: 'piercing' },
      { number: 1, denomination: 4, type: 'cold' },
      { number: 1, denomination: 4, type: 'necrotic' },
    ];
    const out = buildActivityDamageParts(parts);
    expect(out).toHaveLength(2);
    expect(out.map(p => (p.types as string[])[0])).toEqual(['cold', 'necrotic']);
  });
});

describe('buildAttackRange', () => {
  it('melee uses reach (defaulting to 5 ft) with no long range', () => {
    expect(buildAttackRange({ attackType: 'melee', reachFt: 10 })).toEqual({
      value: 10,
      long: null,
      units: 'ft',
    });
    expect(buildAttackRange({ attackType: 'melee' })).toEqual({
      value: 5,
      long: null,
      units: 'ft',
    });
  });

  it('ranged uses normal + long range', () => {
    expect(buildAttackRange({ attackType: 'ranged', rangeFt: 80, longRangeFt: 320 })).toEqual({
      value: 80,
      long: 320,
      units: 'ft',
    });
  });

  it('ranged without a long range leaves long null', () => {
    expect(buildAttackRange({ attackType: 'ranged', rangeFt: 60 })).toEqual({
      value: 60,
      long: null,
      units: 'ft',
    });
  });
});

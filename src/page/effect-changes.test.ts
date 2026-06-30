import { describe, expect, it } from 'vitest';
import { normalizeChange, summarizeChanges } from './effect-changes.js';

// These lock the dnd5e/Foundry-v14 ActiveEffect change mapping. If a Foundry version renumbers
// CONST.ACTIVE_EFFECT_MODES or changes the { key, value, type, phase } shape, these fail OFFLINE
// instead of letting the live write path silently author a wrong effect.

describe('normalizeChange', () => {
  it('passes a string type through and stringifies the value (with phase default)', () => {
    expect(normalizeChange({ key: 'system.attributes.ac.bonus', value: 2, type: 'add' })).toEqual({
      key: 'system.attributes.ac.bonus',
      value: '2',
      type: 'add',
      phase: 'initial',
    });
  });

  it('maps every legacy numeric mode to its v14 string type (CONST.ACTIVE_EFFECT_MODES)', () => {
    const modeToType: Array<[number, string]> = [
      [0, 'custom'],
      [1, 'multiply'],
      [2, 'add'],
      [3, 'downgrade'],
      [4, 'upgrade'],
      [5, 'override'],
    ];
    for (const [mode, type] of modeToType) {
      expect(normalizeChange({ key: 'k', value: 1, mode }).type).toBe(type);
    }
  });

  it('falls back to "add" for an unknown numeric mode', () => {
    expect(normalizeChange({ key: 'k', value: 1, mode: 99 }).type).toBe('add');
  });

  it('defaults type to "add" when neither type nor mode is present', () => {
    expect(normalizeChange({ key: 'k', value: 1 }).type).toBe('add');
  });

  it('prefers an explicit string type over a legacy numeric mode', () => {
    expect(normalizeChange({ key: 'k', value: 1, type: 'override', mode: 2 }).type).toBe(
      'override'
    );
  });

  it('coerces a missing key to "" and missing/null value to "", but keeps a 0 value', () => {
    expect(normalizeChange({})).toEqual({ key: '', value: '', type: 'add', phase: 'initial' });
    expect(normalizeChange({ key: 'k', value: null }).value).toBe('');
    expect(normalizeChange({ key: 'k', value: 0 }).value).toBe('0');
  });

  it('passes an explicit phase through', () => {
    expect(normalizeChange({ key: 'k', value: 1, phase: 'final' }).phase).toBe('final');
  });
});

describe('summarizeChanges', () => {
  it('returns [] for missing or empty input', () => {
    expect(summarizeChanges(undefined as any)).toEqual([]);
    expect(summarizeChanges([])).toEqual([]);
  });

  it('surfaces type from a string type or a legacy numeric mode', () => {
    expect(
      summarizeChanges([
        { key: 'a', value: '1', type: 'override' },
        { key: 'b', value: '2', mode: 2 },
      ])
    ).toEqual([
      { key: 'a', value: '1', type: 'override' },
      { key: 'b', value: '2', type: 'add' },
    ]);
  });

  it('reports an undefined type for an unknown legacy mode', () => {
    expect(summarizeChanges([{ key: 'c', value: '3', mode: 99 }])).toEqual([
      { key: 'c', value: '3', type: undefined },
    ]);
  });
});

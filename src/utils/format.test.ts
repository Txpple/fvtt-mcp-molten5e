/**
 * Unit tests for the shared response-formatting helpers — focused on the unresolved-@scale
 * advisory (the copy tools REPORT the dangling token; the skill sets the die) and its wiring
 * into the compendium import report.
 */

import { describe, it, expect } from 'vitest';
import { formatUnresolvedScale, formatImportReport } from './format.js';

describe('formatUnresolvedScale', () => {
  it('returns empty string for no occurrences', () => {
    expect(formatUnresolvedScale([])).toBe('');
    expect(formatUnresolvedScale(undefined as any)).toBe('');
  });

  it('renders the label, dot-path, and dangling formula for each occurrence', () => {
    const out = formatUnresolvedScale([
      {
        label: 'Fire Breath Weapon',
        path: 'system.activities.abc.damage.parts.0.bonus',
        formula: '@scale.dragonborn.breath-damage',
      },
    ]);
    expect(out).toContain('1 unresolved');
    expect(out).toContain('Fire Breath Weapon');
    expect(out).toContain('system.activities.abc.damage.parts.0.bonus');
    expect(out).toContain('@scale.dragonborn.breath-damage');
  });

  it('counts multiple occurrences', () => {
    const out = formatUnresolvedScale([
      { label: 'A', path: 'p1', formula: '@scale.x' },
      { label: 'B', path: 'p2', formula: '@scale.y' },
    ]);
    expect(out).toContain('2 unresolved');
  });

  it('REPORTS the token but proposes no replacement value (tools do, skills decide)', () => {
    const out = formatUnresolvedScale([{ label: 'X', path: 'p', formula: '@scale.cleric.x' }]);
    // The advisory makes the boundary explicit and never names a die for the reader.
    expect(out).toContain('does not choose the value');
    expect(out).not.toMatch(/\b\d+d\d+\b/); // no invented die like "1d10"
  });
});

describe('formatImportReport — unresolved @scale wiring', () => {
  const baseResult = (added: any[]) => ({
    actor: { id: 'a1', name: 'Drako' },
    added,
    skipped: [],
    notFound: [],
    failed: [],
    warnings: [],
  });

  it('appends the advisory and aggregates tokens when an added feature reports @scale', () => {
    const out = formatImportReport(
      baseResult([
        {
          name: 'Fire Breath Weapon',
          packId: 'dnd-players-handbook.origins',
          packLabel: 'PHB Origins',
          itemId: 'i1',
          unresolvedScale: [
            {
              path: 'system.activities.b.damage.parts.0.bonus',
              formula: '@scale.dragonborn.breath-damage',
            },
          ],
        },
      ]),
      1,
      'Features'
    );
    expect(out.message).toContain('1 unresolved');
    expect(out.message).toContain('Fire Breath Weapon');
    expect(out.message).toContain('@scale.dragonborn.breath-damage');
    expect(out.unresolvedScale).toEqual([
      {
        label: 'Fire Breath Weapon',
        path: 'system.activities.b.damage.parts.0.bonus',
        formula: '@scale.dragonborn.breath-damage',
      },
    ]);
  });

  it('omits the advisory and the field entirely for a clean import', () => {
    const out = formatImportReport(
      baseResult([{ name: 'Pack Tactics', packId: 'p', packLabel: 'MM', itemId: 'i2' }]),
      1,
      'Features'
    );
    expect(out.message).not.toContain('unresolved');
    expect(out.unresolvedScale).toBeUndefined();
  });
});

/**
 * Unit tests for buildResultEditPatches — the pure core of update-rolltable's TARGETED per-entry
 * edit mode (the surgical alternative to the destructive whole-set replace). What the pure fn owns:
 * roll-face vs resultId targeting (with ambiguity / not-found / duplicate isolation), only-supplied-
 * field patch shaping (an untouched entry gets NO patch — its stored bytes never rewritten), range
 * validation, and the warn-only overlap/gap layout check. The async description resolution (uuid →
 * @UUID enricher + SRD guard) is buildResultDescription's job, exercised by the live verify script.
 */

import { describe, it, expect } from 'vitest';
import { buildResultEditPatches } from './collections.js';

// A tuned d4: three entries, the middle one double-weighted [2-3].
const EXISTING = [
  { id: 'rA', range: [1, 1] },
  { id: 'rB', range: [2, 3] },
  { id: 'rC', range: [4, 4] },
];

describe('buildResultEditPatches — targeting', () => {
  it('targets by roll face (the "entry 07" idiom) and patches only the supplied field', () => {
    const { patches, errors, warnings } = buildResultEditPatches(EXISTING, [
      { roll: 2, description: 'fixed text' },
    ]);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(patches).toEqual([{ _id: 'rB', description: 'fixed text' }]);
  });

  it('targets by resultId (unambiguous even with overlapping ranges)', () => {
    const { patches, errors } = buildResultEditPatches(EXISTING, [{ resultId: 'rC', weight: 2 }]);
    expect(errors).toEqual([]);
    expect(patches).toEqual([{ _id: 'rC', weight: 2 }]);
  });

  it('isolates a roll no entry covers — the good edit still applies', () => {
    const { patches, errors } = buildResultEditPatches(EXISTING, [
      { roll: 99, description: 'x' },
      { roll: 4, description: 'ok' },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/editResults\[0\].*no entry covers roll 99/);
    expect(patches).toEqual([{ _id: 'rC', description: 'ok' }]);
  });

  it('errors on an ambiguous roll (overlapping ranges) and points at resultId', () => {
    const overlapping = [
      { id: 'r1', range: [1, 3] },
      { id: 'r2', range: [3, 5] },
    ];
    const { patches, errors } = buildResultEditPatches(overlapping, [
      { roll: 3, description: 'x' },
    ]);
    expect(patches).toEqual([]);
    expect(errors[0]).toMatch(/ambiguous.*resultId/);
  });

  it('errors on an unknown resultId, a missing target, and a duplicate target', () => {
    const { patches, errors } = buildResultEditPatches(EXISTING, [
      { resultId: 'ghost', description: 'x' },
      { description: 'no target' },
      { roll: 1, description: 'first' },
      { resultId: 'rA', description: 'second — same entry' },
    ]);
    expect(patches).toEqual([{ _id: 'rA', description: 'first' }]);
    expect(errors).toHaveLength(3);
    expect(errors[0]).toMatch(/no result with id "ghost"/);
    expect(errors[1]).toMatch(/provide roll.*or resultId/);
    expect(errors[2]).toMatch(/duplicate target.*editResults\[2\]/);
  });

  it('labels errors by the CALLER index when edits were dropped upstream', () => {
    // editResults[0] failed content resolution page-side; the survivor carries index 1.
    const { errors } = buildResultEditPatches(EXISTING, [{ index: 1, roll: 99, description: 'x' }]);
    expect(errors[0]).toMatch(/editResults\[1\]/);
  });
});

describe('buildResultEditPatches — patch shaping', () => {
  it('combines description + weight + range in one patch; floors the weight', () => {
    const { patches, errors } = buildResultEditPatches(EXISTING, [
      { roll: 1, description: 'd', weight: 2.9, range: [1, 2] },
    ]);
    expect(errors).toEqual([]);
    expect(patches).toEqual([{ _id: 'rA', description: 'd', weight: 2, range: [1, 2] }]);
  });

  it('a weight/range-only edit never touches the description', () => {
    const { patches } = buildResultEditPatches(EXISTING, [{ roll: 4, range: [4, 5] }]);
    expect(patches[0]).not.toHaveProperty('description');
  });

  it('rejects a malformed range and an edit with nothing to change', () => {
    const { patches, errors } = buildResultEditPatches(EXISTING, [
      { roll: 1, range: [5, 2] as [number, number] },
      { roll: 4 },
    ]);
    expect(patches).toEqual([]);
    expect(errors[0]).toMatch(/range must be \[low, high\]/);
    expect(errors[1]).toMatch(/nothing to change/);
  });
});

describe('buildResultEditPatches — layout warnings (never blocking)', () => {
  it('warns on an overlap introduced by a range edit', () => {
    const { patches, warnings } = buildResultEditPatches(EXISTING, [
      { roll: 1, range: [1, 2] }, // now collides with rB's [2,3]
    ]);
    expect(patches).toHaveLength(1); // still applied
    expect(warnings.some(w => /overlap/.test(w))).toBe(true);
  });

  it('warns on a coverage gap introduced by a range edit', () => {
    const { warnings } = buildResultEditPatches(EXISTING, [
      { resultId: 'rC', range: [6, 6] }, // leaves roll 4–5 uncovered
    ]);
    expect(warnings.some(w => /gap.*4–5/.test(w))).toBe(true);
  });

  it('stays silent when no range was edited, even if the existing layout is odd', () => {
    const gappy = [
      { id: 'r1', range: [1, 1] },
      { id: 'r2', range: [5, 5] },
    ];
    const { warnings } = buildResultEditPatches(gappy, [{ roll: 1, description: 'x' }]);
    expect(warnings).toEqual([]);
  });
});

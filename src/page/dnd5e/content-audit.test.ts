/**
 * Unit tests for the content-audit pure scanner (rule 7 — GM-fudge / pretend-reskin language). The
 * impure auditContent (live game.* gathering) is covered by scripts/verify-content-audit.mjs. The hard
 * part here is precision: catch the real reflavor phrasings the user flagged WITHOUT false-positiving on
 * legitimate rules text.
 */

import { describe, it, expect } from 'vitest';
import { findFudgeLanguage } from './content-audit.js';

describe('findFudgeLanguage — catches the flagged fudge phrasings', () => {
  const FUDGE = [
    'GM, treat its Radiant Flame as necrotic damage.',
    'Treat its Light feature as gloom instead.',
    'This mace deals necrotic in place of bludgeoning.',
    'The ability is reflavored as cold.',
    'Just reflavour the fire as shadow.',
    "Pretend it's necrotic for this villain.",
    'Its holy light is really gloom.',
  ];
  for (const text of FUDGE) {
    it(`flags: "${text}"`, () => {
      expect(findFudgeLanguage(text).length).toBeGreaterThan(0);
    });
  }
});

describe('findFudgeLanguage — does NOT flag legitimate text', () => {
  const CLEAN = [
    'A creature that fails the save takes 4d6 necrotic damage.',
    'On a hit, the target is knocked prone and takes 2d8 slashing damage.',
    'The area counts as difficult terrain until the start of your next turn.',
    'This blade is really sharp and well balanced.', // "is really" w/o a theme word
    'Treat the target as prone for the next attack.', // "treat the target" — no possessive
    'The wielder gains resistance to fire damage while attuned.',
    '',
  ];
  for (const text of CLEAN) {
    it(`does not flag: "${text}"`, () => {
      expect(findFudgeLanguage(text)).toEqual([]);
    });
  }
});

describe('findFudgeLanguage — mechanics', () => {
  it('strips HTML before scanning and returns clean snippets', () => {
    const hits = findFudgeLanguage('<p>GM, <em>treat its</em> bite as poison.</p>');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).not.toContain('<');
  });

  it('handles null/undefined/non-string safely', () => {
    expect(findFudgeLanguage(null)).toEqual([]);
    expect(findFudgeLanguage(undefined)).toEqual([]);
  });

  it('caps at 5 snippets', () => {
    const many = Array.from({ length: 10 }, () => 'pretend').join('. ');
    expect(findFudgeLanguage(many).length).toBeLessThanOrEqual(5);
  });
});

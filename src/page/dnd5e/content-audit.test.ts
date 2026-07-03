/**
 * Unit tests for the content-audit pure scanners: rule 7 (findFudgeLanguage — GM-fudge / pretend-reskin
 * language) and rule 12 (findGmLeakLanguage — a GM-note / spoiler leaked into a player-visible item
 * description). The impure auditContent (live game.* gathering) is covered by
 * scripts/verify-content-audit.mjs. The hard part here is precision: catch the real phrasings the user
 * flagged WITHOUT false-positiving on legitimate in-world flavor or rules text.
 */

import { describe, it, expect } from 'vitest';
import { findFudgeLanguage, findGmLeakLanguage } from './content-audit.js';

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

describe('findGmLeakLanguage — catches GM-note / spoiler leaks in a player-visible description (rule 12)', () => {
  const LEAKS = [
    // The exact leak this rule was written for (the "sealed letter" GM aside).
    'GM: a ready-made thread if you want one. Fill in the name and the news to suit your table.',
    'GM — this letter points to the villain in Greenrest.',
    'GM, decide what the note says.',
    'GM note: the seal hides a map to the shard.',
    'The DM can decide what it contains.',
    'The Dungeon Master should flesh this out.',
    'A ready-made hook for your campaign.',
    'Adjust the details to suit your table.',
    'Fill in the recipient as you see fit.',
    'Leave the name blank for your players to discover.',
  ];
  for (const text of LEAKS) {
    it(`flags: "${text}"`, () => {
      expect(findGmLeakLanguage(text).length).toBeGreaterThan(0);
    });
  }

  it('strips HTML and returns a clean snippet', () => {
    const hits = findGmLeakLanguage('<p><em>GM:</em> fill in the name here.</p>');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).not.toContain('<');
  });

  it('handles null/undefined safely', () => {
    expect(findGmLeakLanguage(null)).toEqual([]);
    expect(findGmLeakLanguage(undefined)).toEqual([]);
  });
});

describe('findGmLeakLanguage — does NOT flag legitimate in-world item flavor', () => {
  const CLEAN = [
    // The rewritten, innocuous letter description — must read clean.
    'An unsealed letter, its wax seal already broken, addressed to someone in Daggerford. The few ' +
      'lines inside are an ordinary letter home: that the roads had been kind, and that there was ' +
      'nothing to worry about.',
    'The wielder gains resistance to fire damage while attuned.',
    'On a hit, the target takes 2d6 fire damage until the start of your next turn.', // "your next turn" is not meta
    'A finely balanced blade forged for the queen’s guard.',
    'You find a folded map tucked into the lining of the cloak.',
    'This potion smells of crushed mint; drink it to regain hit points.',
    '',
  ];
  for (const text of CLEAN) {
    it(`does not flag: "${text.slice(0, 40)}…"`, () => {
      expect(findGmLeakLanguage(text)).toEqual([]);
    });
  }
});

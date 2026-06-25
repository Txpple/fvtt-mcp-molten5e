import { describe, it, expect } from 'vitest';
import {
  isSrdPack,
  isPremiumBookPack,
  packPriority,
  assertNoSrdPacks,
  PREMIUM_BOOK_PREFIXES,
  DEFAULT_SPELL_PACKS,
  DEFAULT_FEATURE_PACKS,
} from './compendium-sources.js';

describe('compendium-sources — library policy (design.md §2.3: books only, never SRD)', () => {
  describe('isSrdPack', () => {
    it.each([
      'dnd5e.spells24',
      'dnd5e.monsterfeatures24',
      'dnd5e.classes24',
      'dnd5e.classfeatures',
      'dnd5e.monsters',
      'dnd5e.spells',
      'dnd5e.equipment24',
    ])('flags %s as SRD', pack => {
      expect(isSrdPack(pack)).toBe(true);
    });

    it.each([
      'dnd-players-handbook.spells',
      'dnd-monster-manual.actors',
      'some-module.items',
    ])('does not flag %s as SRD', pack => {
      expect(isSrdPack(pack)).toBe(false);
    });
  });

  describe('isPremiumBookPack', () => {
    it.each([
      'dnd-monster-manual.actors',
      'dnd-players-handbook.classes',
      'dnd-dungeon-masters-guide.equipment',
    ])('flags %s as a premium book', pack => {
      expect(isPremiumBookPack(pack)).toBe(true);
    });

    it.each([
      'dnd5e.spells24',
      'dnd5e.monsters',
      'some-module.items',
    ])('does not flag %s as a premium book', pack => {
      expect(isPremiumBookPack(pack)).toBe(false);
    });
  });

  describe('packPriority (premium first, SRD last)', () => {
    it('ranks premium books first (0)', () => {
      expect(packPriority('dnd-monster-manual.actors')).toBe(0);
    });
    it('ranks SRD packs last (2)', () => {
      expect(packPriority('dnd5e.spells24')).toBe(2);
    });
    it('ranks other non-SRD packs in the middle (1)', () => {
      expect(packPriority('some-module.items')).toBe(1);
    });
    it('sorts premium ahead of SRD', () => {
      const sorted = ['dnd5e.spells24', 'dnd-players-handbook.spells'].sort(
        (a, b) => packPriority(a) - packPriority(b)
      );
      expect(sorted[0]).toBe('dnd-players-handbook.spells');
    });
  });

  describe('authoring tool defaults never include an SRD pack', () => {
    it('DEFAULT_SPELL_PACKS is premium-book-only', () => {
      expect(DEFAULT_SPELL_PACKS.length).toBeGreaterThan(0);
      for (const pack of DEFAULT_SPELL_PACKS) {
        expect(isSrdPack(pack), `${pack} must not be an SRD pack`).toBe(false);
        expect(isPremiumBookPack(pack), `${pack} must be a premium book pack`).toBe(true);
      }
    });

    it('DEFAULT_FEATURE_PACKS is premium-book-only', () => {
      expect(DEFAULT_FEATURE_PACKS.length).toBeGreaterThan(0);
      for (const pack of DEFAULT_FEATURE_PACKS) {
        expect(isSrdPack(pack), `${pack} must not be an SRD pack`).toBe(false);
        expect(isPremiumBookPack(pack), `${pack} must be a premium book pack`).toBe(true);
      }
    });

    it('the premium-book set never lists an SRD prefix', () => {
      for (const prefix of PREMIUM_BOOK_PREFIXES) {
        expect(prefix.startsWith('dnd5e.')).toBe(false);
      }
    });
  });

  describe('assertNoSrdPacks (the active pull guard — design.md §2.3 by construction)', () => {
    it('throws on a single SRD pack id', () => {
      expect(() => assertNoSrdPacks('dnd5e.spells24', 'import-item')).toThrow(/SRD/);
    });

    it('throws if ANY pack in a list is SRD, naming the offender', () => {
      expect(() => assertNoSrdPacks(['dnd-players-handbook.spells', 'dnd5e.spells24'])).toThrow(
        /dnd5e\.spells24/
      );
    });

    it('points at the premium equivalent in the message', () => {
      expect(() => assertNoSrdPacks('dnd5e.monsters')).toThrow(/premium/i);
    });

    it('passes for premium-only packs (single or list)', () => {
      expect(() => assertNoSrdPacks('dnd-dungeon-masters-guide.equipment')).not.toThrow();
      expect(() =>
        assertNoSrdPacks(['dnd-monster-manual.features', 'dnd-players-handbook.classes'])
      ).not.toThrow();
    });
  });
});

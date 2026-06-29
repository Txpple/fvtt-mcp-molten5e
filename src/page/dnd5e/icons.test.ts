/**
 * Unit tests for the authored-document icon resolver (rule 8 — no blank art). These pin the pure
 * contract: resolveAuthoredIcon is TOTAL (never returns a placeholder, for any input), subtype
 * precedence works, and every curated path is a core `icons/...` file (not a module/system path).
 * The actual "does this file exist in Foundry" check is the live scripts/verify-icons.mjs.
 */

import { describe, it, expect } from 'vitest';
import { resolveAuthoredIcon, isPlaceholderIcon, PLACEHOLDER_ICON_PATTERN } from './icons.js';

// Every authored kind a builder asks the resolver for (must each map to a real, specific icon).
const ITEM_KINDS = [
  'weapon',
  'armor',
  'shield',
  'wondrous',
  'consumable',
  'tool',
  'loot',
  'container',
];
const FEATURE_KINDS = ['passive', 'save', 'aura', 'attack', 'attack-with-save'];
const ALL_KINDS = [...ITEM_KINDS, ...FEATURE_KINDS, 'spell'];

const SUBTYPES: Array<[string, string]> = [
  ['wondrous', 'ring'],
  ['wondrous', 'rod'],
  ['wondrous', 'wand'],
  ['wondrous', 'cloak'],
  ['wondrous', 'clothing'],
  ['wondrous', 'amulet'],
  ['consumable', 'potion'],
  ['consumable', 'poison'],
  ['consumable', 'scroll'],
  ['consumable', 'ammo'],
  ['consumable', 'food'],
  ['loot', 'gem'],
  ['loot', 'art'],
  ['loot', 'trade'],
];

describe('isPlaceholderIcon', () => {
  it('treats missing/empty as a placeholder', () => {
    expect(isPlaceholderIcon(undefined)).toBe(true);
    expect(isPlaceholderIcon(null)).toBe(true);
    expect(isPlaceholderIcon('')).toBe(true);
  });

  it('matches the monochrome core + dnd5e placeholder families', () => {
    expect(isPlaceholderIcon('icons/svg/daze.svg')).toBe(true);
    expect(isPlaceholderIcon('icons/svg/mystery-man.svg')).toBe(true);
    expect(isPlaceholderIcon('systems/dnd5e/icons/svg/items/feature.svg')).toBe(true);
    expect(isPlaceholderIcon('systems/dnd5e/icons/svg/monster.svg')).toBe(true);
  });

  it('does NOT flag real full-colour core/module art', () => {
    expect(isPlaceholderIcon('icons/weapons/swords/swords-sharp-worn.webp')).toBe(false);
    expect(isPlaceholderIcon('icons/consumables/potions/bottle-round-corked-green.webp')).toBe(
      false
    );
    expect(isPlaceholderIcon('modules/dnd-monster-manual/assets/portraits/archmage.webp')).toBe(
      false
    );
  });

  it('PLACEHOLDER_ICON_PATTERN only matches the icons/svg segment', () => {
    expect(PLACEHOLDER_ICON_PATTERN.test('icons/weapons/swords/sword.webp')).toBe(false);
    expect(PLACEHOLDER_ICON_PATTERN.test('a/b/icons/svg/x.svg')).toBe(true);
  });
});

describe('resolveAuthoredIcon', () => {
  it('returns a real, non-placeholder icon for every authored kind', () => {
    for (const kind of ALL_KINDS) {
      const icon = resolveAuthoredIcon(kind);
      expect(isPlaceholderIcon(icon), `${kind} → ${icon}`).toBe(false);
      expect(icon, `${kind} must be a core icon`).toMatch(/^icons\/.+\.webp$/);
    }
  });

  it('every curated icon is a module-independent core path (never module/ or systems/)', () => {
    for (const kind of ALL_KINDS) {
      const icon = resolveAuthoredIcon(kind);
      expect(icon.startsWith('icons/')).toBe(true);
      expect(icon.startsWith('modules/')).toBe(false);
      expect(icon.startsWith('systems/')).toBe(false);
    }
  });

  it('subtype takes precedence over the bare kind when a kind:subtype entry exists', () => {
    // ring/scroll/etc. resolve to a subtype-specific icon distinct from the bare-kind default.
    expect(resolveAuthoredIcon('wondrous', { subtype: 'ring' })).not.toBe(
      resolveAuthoredIcon('wondrous')
    );
    expect(resolveAuthoredIcon('consumable', { subtype: 'scroll' })).not.toBe(
      resolveAuthoredIcon('consumable')
    );
    // potion subtype intentionally equals the consumable default (a potion IS the canonical consumable).
    expect(resolveAuthoredIcon('consumable', { subtype: 'potion' })).toBe(
      resolveAuthoredIcon('consumable')
    );
  });

  it('every declared subtype resolves to a real, non-placeholder icon', () => {
    for (const [kind, subtype] of SUBTYPES) {
      const icon = resolveAuthoredIcon(kind, { subtype });
      expect(isPlaceholderIcon(icon), `${kind}:${subtype} → ${icon}`).toBe(false);
      expect(icon).toMatch(/^icons\/.+\.webp$/);
    }
  });

  it('falls back to the bare kind for an unknown subtype', () => {
    expect(resolveAuthoredIcon('weapon', { subtype: 'no-such-subtype' })).toBe(
      resolveAuthoredIcon('weapon')
    );
  });

  it('is total — an entirely unknown kind still returns a real, non-placeholder icon', () => {
    const icon = resolveAuthoredIcon('totally-made-up-kind');
    expect(isPlaceholderIcon(icon)).toBe(false);
    expect(icon).toMatch(/^icons\/.+\.webp$/);
  });

  it('is case-insensitive on kind and subtype', () => {
    expect(resolveAuthoredIcon('WEAPON')).toBe(resolveAuthoredIcon('weapon'));
    expect(resolveAuthoredIcon('Wondrous', { subtype: 'RING' })).toBe(
      resolveAuthoredIcon('wondrous', { subtype: 'ring' })
    );
  });
});

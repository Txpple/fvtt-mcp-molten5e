/**
 * Offline unit tests for the pure faceted-search helpers (src/page/compendium-facets.ts):
 * packIdFromUuid, buildFacetFilters (facets -> dnd5e {k,o,v}), projectHit, passesPostFilters,
 * and matchesFilters (the fallback evaluator). No Foundry globals. The live fetch wrapper
 * (searchCompendiumFaceted) is exercised by the spike / live re-verify, not here.
 */

import { describe, it, expect } from 'vitest';
import {
  packIdFromUuid,
  buildFacetFilters,
  projectHit,
  passesPostFilters,
  matchesFilters,
  type FacetedSearchArgs,
} from './compendium-facets.js';

describe('packIdFromUuid', () => {
  it('extracts <scope>.<pack> from a compendium uuid', () => {
    expect(packIdFromUuid('Compendium.dnd-monster-manual.actors.Actor.mmAberrantCultis')).toBe(
      'dnd-monster-manual.actors'
    );
    expect(packIdFromUuid('Compendium.dnd5e.spells.Item.abc')).toBe('dnd5e.spells');
  });
  it('returns null for non-compendium / malformed uuids', () => {
    expect(packIdFromUuid('Actor.local123')).toBeNull();
    expect(packIdFromUuid(undefined)).toBeNull();
    expect(packIdFromUuid('')).toBeNull();
  });
});

describe('buildFacetFilters', () => {
  it('creature: CR range -> gte/lte, type/size -> in (size mapped to dnd5e key)', () => {
    const f = buildFacetFilters('creature', {
      documentType: 'creature',
      challengeRating: { min: 5, max: 8 },
      creatureType: 'Dragon',
      size: 'large',
    } as FacetedSearchArgs);
    expect(f).toEqual([
      { k: 'system.details.cr', o: 'gte', v: 5 },
      { k: 'system.details.cr', o: 'lte', v: 8 },
      { k: 'system.details.type.value', o: 'in', v: ['dragon'] },
      { k: 'system.traits.size', o: 'in', v: ['lg'] },
    ]);
  });

  it('creature: exact CR -> _ operator; hasSpells is NOT a filter (post-filtered)', () => {
    const f = buildFacetFilters('creature', {
      documentType: 'creature',
      challengeRating: 17,
      hasSpells: true,
    } as FacetedSearchArgs);
    expect(f).toEqual([{ k: 'system.details.cr', o: '_', v: 17 }]);
  });

  it('spell: level range + school; damageType is NOT a filter (two-stage)', () => {
    const f = buildFacetFilters('spell', {
      documentType: 'spell',
      spellLevel: { max: 3 },
      spellSchool: ['Evo', 'abj'],
      damageType: 'fire',
    } as FacetedSearchArgs);
    expect(f).toEqual([
      { k: 'system.level', o: 'lte', v: 3 },
      { k: 'system.school', o: 'in', v: ['evo', 'abj'] },
    ]);
  });

  it('spell: full school names normalize to dnd5e keys; unknown passes through lowercased', () => {
    const f = buildFacetFilters('spell', {
      documentType: 'spell',
      spellSchool: ['Evocation', 'necromancy', 'Whatever'],
    } as FacetedSearchArgs);
    expect(f).toEqual([{ k: 'system.school', o: 'in', v: ['evo', 'nec', 'whatever'] }]);
  });

  it('gear: rarity/itemType -> in, properties -> hasany', () => {
    const f = buildFacetFilters('gear', {
      documentType: 'gear',
      rarity: ['rare', 'veryRare'],
      itemType: 'wondrous',
      properties: ['mgc'],
    } as FacetedSearchArgs);
    expect(f).toEqual([
      { k: 'system.rarity', o: 'in', v: ['rare', 'veryRare'] },
      { k: 'system.type.value', o: 'in', v: ['wondrous'] },
      { k: 'system.properties', o: 'hasany', v: ['mgc'] },
    ]);
  });
});

describe('projectHit', () => {
  it('creature: derives facets incl. approximate flags + pack from uuid', () => {
    const hit = projectHit(
      {
        _id: 'x',
        name: 'Adult Red Dragon',
        type: 'npc',
        img: 'a.webp',
        uuid: 'Compendium.dnd-monster-manual.actors.Actor.x',
        system: {
          details: { cr: 17, type: { value: 'Dragon' } },
          traits: { size: 'huge' },
          attributes: { spell: { level: 0 } },
          resources: { legact: { max: 3 } },
        },
      },
      'creature',
      'Monster Manual'
    );
    expect(hit).toMatchObject({
      id: 'x',
      name: 'Adult Red Dragon',
      type: 'npc',
      pack: 'dnd-monster-manual.actors',
      packLabel: 'Monster Manual',
      facets: {
        challengeRating: 17,
        creatureType: 'dragon',
        size: 'huge',
        hasSpells: false,
        hasLegendaryActions: true,
      },
    });
  });

  it('gear: magical reflects the mgc property', () => {
    const hit = projectHit(
      {
        _id: 'i',
        name: 'Ioun Stone',
        type: 'equipment',
        uuid: 'Compendium.dnd-dungeon-masters-guide.equipment.Item.i',
        system: { rarity: 'veryRare', type: { value: 'wondrous' }, properties: ['mgc'] },
      },
      'gear',
      'DMG'
    );
    expect(hit.facets).toMatchObject({ rarity: 'veryRare', itemType: 'wondrous', magical: true });
  });
});

describe('passesPostFilters', () => {
  const dragon = projectHit(
    {
      _id: 'x',
      name: 'Adult Red Dragon',
      type: 'npc',
      uuid: 'Compendium.dnd-monster-manual.actors.Actor.x',
      system: {
        details: { cr: 17, type: { value: 'dragon' } },
        resources: { legact: { max: 3 } },
        attributes: {},
      },
    },
    'creature',
    'MM'
  );

  it('name substring (case-insensitive)', () => {
    expect(
      passesPostFilters(dragon, {
        documentType: 'creature',
        name: 'red dragon',
      } as FacetedSearchArgs)
    ).toBe(true);
    expect(
      passesPostFilters(dragon, { documentType: 'creature', name: 'goblin' } as FacetedSearchArgs)
    ).toBe(false);
  });

  it('hasLegendaryActions / hasSpells flags', () => {
    expect(
      passesPostFilters(dragon, {
        documentType: 'creature',
        hasLegendaryActions: true,
      } as FacetedSearchArgs)
    ).toBe(true);
    expect(
      passesPostFilters(dragon, { documentType: 'creature', hasSpells: true } as FacetedSearchArgs)
    ).toBe(false);
  });
});

describe('matchesFilters (fallback evaluator)', () => {
  const entry = {
    type: 'npc',
    system: {
      details: { cr: 6, type: { value: 'fiend' } },
      traits: { size: 'med' },
      properties: ['mgc'],
    },
  };
  it('evaluates _, gte, lte, in, hasany', () => {
    expect(matchesFilters(entry, [{ k: 'system.details.cr', o: 'gte', v: 5 }])).toBe(true);
    expect(matchesFilters(entry, [{ k: 'system.details.cr', o: 'lte', v: 5 }])).toBe(false);
    expect(
      matchesFilters(entry, [{ k: 'system.details.type.value', o: 'in', v: ['fiend', 'undead'] }])
    ).toBe(true);
    expect(matchesFilters(entry, [{ k: 'system.details.cr', o: '_', v: 6 }])).toBe(true);
    expect(matchesFilters(entry, [{ k: 'system.properties', o: 'hasany', v: ['mgc'] }])).toBe(true);
    expect(matchesFilters(entry, [{ k: 'system.properties', o: 'hasany', v: ['ada'] }])).toBe(
      false
    );
  });
  it('all filters must pass (AND)', () => {
    expect(
      matchesFilters(entry, [
        { k: 'system.details.cr', o: 'gte', v: 5 },
        { k: 'system.traits.size', o: 'in', v: ['lg'] },
      ])
    ).toBe(false);
  });
});

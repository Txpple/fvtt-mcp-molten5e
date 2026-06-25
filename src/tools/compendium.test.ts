/**
 * Unit tests for CompendiumTools (search-compendium, get-compendium-entry,
 * search-compendium-creatures, list-compendium-packs).
 *
 * These handlers own three things before/around the bridge call:
 *   1. zod input validation — required fields, min-length strings, enum
 *      membership, numeric bounds (bad input throws, never returns a result).
 *   2. correct bridge method name + payload forwarding.
 *   3. response shaping — the structured object built from the bridge result,
 *      including empty-vs-populated and optional-filter branches.
 *
 * Note: handleSearchCompendium and handleListCreaturesByCriteria first call
 * getGameSystem() -> detectGameSystem(), which calls
 * 'getWorldInfo' and caches the result in a module-level
 * variable. clearSystemCache() is called in beforeEach so each test controls
 * the detected system deterministically.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CompendiumTools } from './compendium.js';
import { clearSystemCache } from '../utils/system-detection.js';
import { makeLogger, makeFoundry } from './test-helpers.js';

/**
 * Build a CompendiumTools wired to a function-based foundry bridge.
 *
 * @param worldSystem  system id returned by getWorldInfo (drives detection)
 * @param bridgeResult result returned for every non-getWorldInfo call
 */
function build(worldSystem: string = 'dnd5e', bridgeResult: any = []) {
  const { foundry, calls } = makeFoundry((method: string) => {
    if (method === 'getWorldInfo') {
      return { system: worldSystem };
    }
    return bridgeResult;
  });
  const tools = new CompendiumTools({ foundry, logger: makeLogger() });
  return { tools, calls, foundry };
}

beforeEach(() => {
  clearSystemCache();
});

describe('CompendiumTools.getToolDefinitions', () => {
  it('exposes exactly the six compendium tools', () => {
    const { tools } = build();
    const names = tools
      .getToolDefinitions()
      .map(t => t.name)
      .sort();
    expect(names).toEqual([
      'get-compendium-entry',
      'list-compendium-packs',
      'search-compendium',
      'search-compendium-creatures',
      'search-compendium-items',
      'search-compendium-spells',
    ]);
  });

  it('every definition has an object inputSchema', () => {
    const { tools } = build();
    for (const def of tools.getToolDefinitions()) {
      expect(def.inputSchema.type).toBe('object');
    }
  });

  it('marks the expected required fields per tool', () => {
    const { tools } = build();
    const byName = Object.fromEntries(tools.getToolDefinitions().map(d => [d.name, d]));
    expect(byName['search-compendium'].inputSchema.required).toEqual(['query']);
    expect(byName['get-compendium-entry'].inputSchema.required).toEqual(['packId', 'itemId']);
    expect(byName['search-compendium-creatures'].inputSchema.required).toEqual([]);
    expect(byName['search-compendium-spells'].inputSchema.required).toEqual([]);
    expect(byName['search-compendium-items'].inputSchema.required).toEqual([]);
  });
});

describe('handleSearchCompendium', () => {
  it('forwards query + packType + filters to searchCompendium and shapes the result', async () => {
    const bridgeResults = [
      { id: 'i1', name: 'Goblin', type: 'npc', pack: 'p1', packLabel: 'Monsters' },
      { id: 'i2', name: 'Goblin Boss', type: 'npc', pack: 'p1', packLabel: 'Monsters' },
    ];
    const { tools, calls } = build('dnd5e', bridgeResults);

    const out = await tools.handleSearchCompendium({
      query: 'goblin',
      packType: 'Actor',
    });

    // getWorldInfo (detection) then the search call.
    const searchCall = calls.find(c => c[0] === 'searchCompendium');
    expect(searchCall).toBeDefined();
    expect(searchCall![1]).toEqual({
      query: 'goblin',
      packType: 'Actor',
      filters: undefined,
    });

    expect(out.query).toBe('goblin');
    expect(out.gameSystem).toBe('dnd5e');
    expect(out.filterDescription).toBe('no filters');
    expect(out.totalFound).toBe(2);
    expect(out.showing).toBe(2);
    expect(out.hasMore).toBe(false);
    expect(out.results).toHaveLength(2);
    expect(out.results[0]).toMatchObject({
      id: 'i1',
      name: 'Goblin',
      type: 'npc',
      pack: { id: 'p1', label: 'Monsters' },
    });
  });

  it('describes filters and includes them in the bridge payload', async () => {
    const { tools, calls } = build('dnd5e', []);
    const out = await tools.handleSearchCompendium({
      query: 'dragon',
      filters: { challengeRating: 12, creatureType: 'dragon' },
    });

    const searchCall = calls.find(c => c[0] === 'searchCompendium');
    expect(searchCall![1].filters).toEqual({
      challengeRating: 12,
      creatureType: 'dragon',
    });
    expect(out.filterDescription).toBe('CR 12, dragon');
  });

  it('reports an empty result set cleanly', async () => {
    const { tools } = build('dnd5e', []);
    const out = await tools.handleSearchCompendium({ query: 'zzzznothing' });
    expect(out.totalFound).toBe(0);
    expect(out.showing).toBe(0);
    expect(out.results).toEqual([]);
    expect(out.hasMore).toBe(false);
  });

  it('sets hasMore and caps results when more than limit are returned', async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      id: `id${i}`,
      name: `Item ${i}`,
      type: 'weapon',
      pack: 'p',
      packLabel: 'Gear',
    }));
    const { tools } = build('dnd5e', many);
    const out = await tools.handleSearchCompendium({ query: 'sword', limit: 2 });
    expect(out.totalFound).toBe(5);
    expect(out.showing).toBe(2);
    expect(out.results).toHaveLength(2);
    expect(out.hasMore).toBe(true);
  });

  it('rejects a query shorter than 2 characters', async () => {
    const { tools } = build();
    await expect(tools.handleSearchCompendium({ query: 'a' })).rejects.toThrow();
  });

  it('rejects a missing query', async () => {
    const { tools } = build();
    await expect(tools.handleSearchCompendium({})).rejects.toThrow();
  });

  it('rejects a limit above the maximum of 50', async () => {
    const { tools } = build();
    await expect(tools.handleSearchCompendium({ query: 'dragon', limit: 51 })).rejects.toThrow();
  });

  it('rejects a limit below the minimum of 1', async () => {
    const { tools } = build();
    await expect(tools.handleSearchCompendium({ query: 'dragon', limit: 0 })).rejects.toThrow();
  });

  it('drops SRD (dnd5e.*) hits and counts only book results (enforced backstop)', async () => {
    const bridgeResults = [
      { id: 'b1', name: 'Goblin', type: 'npc', pack: 'dnd-monster-manual.actors', packLabel: 'MM' },
      { id: 's1', name: 'Goblin', type: 'npc', pack: 'dnd5e.monsters', packLabel: 'SRD' },
      { id: 's2', name: 'Goblin Boss', type: 'npc', pack: 'dnd5e.monsters', packLabel: 'SRD' },
    ];
    const { tools } = build('dnd5e', bridgeResults);

    const out = await tools.handleSearchCompendium({ query: 'goblin' });

    // Only the premium-book hit survives; SRD rows are not results and do not inflate counts.
    expect(out.totalFound).toBe(1);
    expect(out.showing).toBe(1);
    expect(out.hasMore).toBe(false);
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({ id: 'b1', pack: { id: 'dnd-monster-manual.actors' } });
  });
});

describe('handleGetCompendiumItem', () => {
  it('forwards packId + itemId (as documentId) and shapes a full entry', async () => {
    const item = {
      id: 'doc1',
      name: 'Longsword',
      type: 'weapon',
      pack: 'p1',
      packLabel: 'Equipment',
      img: 'icons/sword.png',
      system: {
        description: { value: '<p>A fine blade.</p>' },
        damage: { parts: [['1d8', 'slashing']] },
      },
      items: [],
      effects: [],
      fullData: { foo: 'bar' },
    };
    const { tools, calls } = build('dnd5e', item);

    const out = await tools.handleGetCompendiumItem({
      packId: 'p1',
      itemId: 'doc1',
    });

    expect(calls[0][0]).toBe('getCompendiumDocumentFull');
    expect(calls[0][1]).toEqual({ packId: 'p1', documentId: 'doc1' });

    expect(out.mode).toBe('full');
    expect(out.id).toBe('doc1');
    expect(out.name).toBe('Longsword');
    expect(out.type).toBe('weapon');
    expect(out.pack).toEqual({ id: 'p1', label: 'Equipment' });
    expect(out.hasImage).toBe(true);
    expect(out.imageUrl).toBe('icons/sword.png');
    // HTML stripped out of the description.
    expect(out.fullDescription).toBe('A fine blade.');
    expect(out.fullData).toEqual({ foo: 'bar' });
    expect(out.effects).toEqual([]);
  });

  it('returns a compact stat block when compact=true', async () => {
    const item = {
      id: 'mon1',
      name: 'Ancient Dragon',
      type: 'npc',
      pack: 'p2',
      packLabel: 'Monsters',
      img: null,
      system: {
        attributes: { ac: { value: 22 }, hp: { max: 367 } },
        details: { cr: 24, type: { value: 'dragon' } },
      },
      items: [],
    };
    const { tools } = build('dnd5e', item);

    const out = await tools.handleGetCompendiumItem({
      packId: 'p2',
      itemId: 'mon1',
      compact: true,
    });

    expect(out.mode).toBe('compact');
    expect(out.hasImage).toBe(false);
    expect(out.stats).toMatchObject({
      armorClass: 22,
      hitPoints: 367,
      challengeRating: 24,
      creatureType: 'dragon',
    });
  });

  it('throws when the bridge returns no item', async () => {
    const { tools } = build('dnd5e', null);
    await expect(tools.handleGetCompendiumItem({ packId: 'p', itemId: 'missing' })).rejects.toThrow(
      /Failed to retrieve item/
    );
  });

  it('rejects an empty packId', async () => {
    const { tools } = build();
    await expect(tools.handleGetCompendiumItem({ packId: '', itemId: 'x' })).rejects.toThrow();
  });

  it('rejects an empty itemId', async () => {
    const { tools } = build();
    await expect(tools.handleGetCompendiumItem({ packId: 'p', itemId: '' })).rejects.toThrow();
  });

  it('rejects a missing itemId', async () => {
    const { tools } = build();
    await expect(tools.handleGetCompendiumItem({ packId: 'p' })).rejects.toThrow();
  });

  it('refuses an SRD (dnd5e.*) packId before touching the bridge', async () => {
    const { tools, calls } = build();
    await expect(
      tools.handleGetCompendiumItem({ packId: 'dnd5e.monsters', itemId: 'x' })
    ).rejects.toThrow(/SRD/);
    // Guard fires before any bridge call.
    expect(calls.find(c => c[0] === 'getCompendiumDocumentFull')).toBeUndefined();
  });
});

describe('handleListCreaturesByCriteria', () => {
  // Re-backed on the faceted engine: searchCompendiumFaceted returns a bare CompendiumHit[].
  const hit = (over: any = {}) => ({
    id: 'c1',
    name: 'Adult Red Dragon',
    type: 'npc',
    uuid: 'Compendium.dnd-monster-manual.actors.Actor.c1',
    pack: 'dnd-monster-manual.actors',
    packLabel: 'MM',
    img: 'icons/dragon.png',
    facets: { challengeRating: 17, creatureType: 'dragon', size: 'huge' },
    ...over,
  });

  it('forwards documentType:creature + facets to searchCompendiumFaceted and shapes the result', async () => {
    const { tools, calls } = build('dnd5e', [hit()]);

    const out = await tools.handleListCreaturesByCriteria({
      challengeRating: 17,
      creatureType: 'dragon',
    });

    const call = calls.find(c => c[0] === 'searchCompendiumFaceted');
    expect(call).toBeDefined();
    expect(call![1]).toMatchObject({
      documentType: 'creature',
      challengeRating: 17,
      creatureType: 'dragon',
      limit: 500, // schema default
    });

    expect(out.documentType).toBe('creature');
    expect(out.criteriaDescription).toBe('CR 17, dragon');
    expect(out.totalFound).toBe(1);
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({
      id: 'c1',
      name: 'Adult Red Dragon',
      pack: 'dnd-monster-manual.actors',
    });
  });

  it('describes a CR range and defaults the limit', async () => {
    const { tools, calls } = build('dnd5e', []);
    const out = await tools.handleListCreaturesByCriteria({
      challengeRating: { min: 10, max: 15 },
    });
    expect(out.criteriaDescription).toBe('CR 10-15');
    // An empty result must report a real count, not undefined.
    expect(out.totalFound).toBe(0);
    expect(out.results).toEqual([]);
    const call = calls.find(c => c[0] === 'searchCompendiumFaceted');
    expect(call![1].limit).toBe(500);
  });

  it('reports "no criteria" when called with no filters', async () => {
    const { tools } = build('dnd5e', []);
    const out = await tools.handleListCreaturesByCriteria({});
    expect(out.criteriaDescription).toBe('no criteria');
  });

  it('rejects an invalid size enum value', async () => {
    const { tools } = build();
    await expect(tools.handleListCreaturesByCriteria({ size: 'colossal' })).rejects.toThrow();
  });

  it('rejects a limit above the maximum of 1000', async () => {
    const { tools } = build();
    await expect(tools.handleListCreaturesByCriteria({ limit: 1001 })).rejects.toThrow();
  });

  it('drops SRD (dnd5e.*) creatures and counts only book results (enforced backstop)', async () => {
    const { tools } = build('dnd5e', [
      hit(),
      hit({ id: 's1', pack: 'dnd5e.monsters', packLabel: 'SRD' }),
    ]);
    const out = await tools.handleListCreaturesByCriteria({ creatureType: 'dragon' });
    expect(out.totalFound).toBe(1);
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({ id: 'c1', pack: 'dnd-monster-manual.actors' });
  });
});

describe('handleSearchCompendiumSpells', () => {
  // The faceted engine (searchCompendiumFaceted) returns a bare CompendiumHit[].
  const hit = (over: any = {}) => ({
    id: 's1',
    name: 'Fireball',
    type: 'spell',
    uuid: 'Compendium.dnd-players-handbook.spells.Item.s1',
    pack: 'dnd-players-handbook.spells',
    packLabel: 'PHB Spells',
    img: 'icons/fire.png',
    facets: { spellLevel: 3, spellSchool: 'evo' },
    ...over,
  });

  it('forwards documentType:spell + facets to searchCompendiumFaceted and shapes the result', async () => {
    const { tools, calls } = build('dnd5e', [hit()]);

    const out = await tools.handleSearchCompendiumSpells({
      spellLevel: 3,
      spellSchool: 'evocation',
      damageType: 'fire',
      name: 'fire',
    });

    const call = calls.find(c => c[0] === 'searchCompendiumFaceted');
    expect(call).toBeDefined();
    expect(call![1]).toEqual({
      documentType: 'spell',
      name: 'fire',
      spellLevel: 3,
      spellSchool: 'evocation',
      damageType: 'fire',
      limit: 50, // schema default
    });

    expect(out.documentType).toBe('spell');
    expect(out.criteriaDescription).toBe('level 3, evocation, fire damage, name~"fire"');
    expect(out.totalFound).toBe(1);
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({ id: 's1', pack: 'dnd-players-handbook.spells' });
  });

  it('describes a cantrip and a level range', async () => {
    const { tools } = build('dnd5e', []);
    expect((await tools.handleSearchCompendiumSpells({ spellLevel: 0 })).criteriaDescription).toBe(
      'cantrip'
    );
    expect(
      (await tools.handleSearchCompendiumSpells({ spellLevel: { min: 1, max: 3 } }))
        .criteriaDescription
    ).toBe('level 1-3');
  });

  it('coerces a stringified level (lenient client shape)', async () => {
    const { tools, calls } = build('dnd5e', []);
    await tools.handleSearchCompendiumSpells({ spellLevel: '5' });
    const call = calls.find(c => c[0] === 'searchCompendiumFaceted');
    expect(call![1].spellLevel).toBe(5);
  });

  it('drops SRD (dnd5e.*) spell hits and counts only book results (enforced backstop)', async () => {
    const { tools } = build('dnd5e', [
      hit(),
      hit({ id: 'srd1', pack: 'dnd5e.spells24', packLabel: 'SRD Spells' }),
    ]);
    const out = await tools.handleSearchCompendiumSpells({ spellSchool: 'evo' });
    expect(out.totalFound).toBe(1);
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({ id: 's1' });
  });

  it('reports an empty result set cleanly', async () => {
    const { tools } = build('dnd5e', []);
    const out = await tools.handleSearchCompendiumSpells({ spellLevel: 9 });
    expect(out.totalFound).toBe(0);
    expect(out.results).toEqual([]);
    expect(out.criteriaDescription).toBe('level 9');
  });

  it('rejects a spell level above 9', async () => {
    const { tools } = build();
    await expect(tools.handleSearchCompendiumSpells({ spellLevel: 10 })).rejects.toThrow();
  });

  it('rejects a limit above the maximum of 200', async () => {
    const { tools } = build();
    await expect(tools.handleSearchCompendiumSpells({ limit: 201 })).rejects.toThrow();
  });
});

describe('handleSearchCompendiumItems', () => {
  const hit = (over: any = {}) => ({
    id: 'w1',
    name: 'Flame Tongue',
    type: 'weapon',
    uuid: 'Compendium.dnd-dungeon-masters-guide.items.Item.w1',
    pack: 'dnd-dungeon-masters-guide.items',
    packLabel: 'DMG Items',
    img: 'icons/sword.png',
    facets: { rarity: 'rare', itemType: 'martialM', magical: true },
    ...over,
  });

  it('defaults documentType to gear and forwards facets to searchCompendiumFaceted', async () => {
    const { tools, calls } = build('dnd5e', [hit()]);

    const out = await tools.handleSearchCompendiumItems({
      rarity: 'very rare',
      itemType: 'wondrous',
      magical: true,
      name: 'cloak',
    });

    const call = calls.find(c => c[0] === 'searchCompendiumFaceted');
    expect(call).toBeDefined();
    expect(call![1]).toEqual({
      documentType: 'gear', // schema default
      name: 'cloak',
      rarity: 'very rare', // raw value forwarded; the engine normalizes to the dnd5e key
      itemType: 'wondrous',
      properties: undefined,
      magical: true,
      limit: 50,
    });

    expect(out.documentType).toBe('gear');
    expect(out.criteriaDescription).toBe('gear (very rare, wondrous, magical, name~"cloak")');
    expect(out.totalFound).toBe(1);
    expect(out.results[0]).toMatchObject({ id: 'w1', pack: 'dnd-dungeon-masters-guide.items' });
  });

  it('narrows the family via documentType', async () => {
    const { tools, calls } = build('dnd5e', []);
    await tools.handleSearchCompendiumItems({
      documentType: 'weapon',
      rarity: ['rare', 'legendary'],
    });
    const call = calls.find(c => c[0] === 'searchCompendiumFaceted');
    expect(call![1].documentType).toBe('weapon');
    expect(call![1].rarity).toEqual(['rare', 'legendary']);
  });

  it('coerces a stringified magical flag (lenient client shape)', async () => {
    const { tools, calls } = build('dnd5e', []);
    await tools.handleSearchCompendiumItems({ magical: 'true' });
    const call = calls.find(c => c[0] === 'searchCompendiumFaceted');
    expect(call![1].magical).toBe(true);
  });

  it('drops SRD (dnd5e.*) item hits and counts only book results (enforced backstop)', async () => {
    const { tools } = build('dnd5e', [
      hit(),
      hit({ id: 'srd1', pack: 'dnd5e.items', packLabel: 'SRD Items' }),
    ]);
    const out = await tools.handleSearchCompendiumItems({ rarity: 'rare' });
    expect(out.totalFound).toBe(1);
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({ id: 'w1' });
  });

  it('reports an empty result set cleanly', async () => {
    const { tools } = build('dnd5e', []);
    const out = await tools.handleSearchCompendiumItems({ documentType: 'consumable' });
    expect(out.totalFound).toBe(0);
    expect(out.results).toEqual([]);
    expect(out.criteriaDescription).toBe('consumable (no facets)');
  });

  it('rejects an invalid documentType', async () => {
    const { tools } = build();
    await expect(tools.handleSearchCompendiumItems({ documentType: 'spell' })).rejects.toThrow();
  });

  it('rejects a limit above the maximum of 200', async () => {
    const { tools } = build();
    await expect(tools.handleSearchCompendiumItems({ limit: 201 })).rejects.toThrow();
  });
});

describe('handleListCompendiumPacks', () => {
  it('forwards to getAvailablePacks and shapes the pack list', async () => {
    const packs = [
      { id: 'p1', label: 'Monsters', type: 'Actor', system: 'dnd5e', private: false },
      { id: 'p2', label: 'Items', type: 'Item', system: 'dnd5e', private: true },
    ];
    const { tools, calls } = build('dnd5e', packs);

    const out = await tools.handleListCompendiumPacks({});

    expect(calls[0][0]).toBe('getAvailablePacks');
    expect(out.total).toBe(2);
    expect(out.packs).toHaveLength(2);
    expect(out.packs[0]).toEqual({
      id: 'p1',
      label: 'Monsters',
      type: 'Actor',
      system: 'dnd5e',
      private: false,
    });
    expect(out.availableTypes.sort()).toEqual(['Actor', 'Item']);
  });

  it('filters packs by type when provided', async () => {
    const packs = [
      { id: 'p1', label: 'Monsters', type: 'Actor', system: 'dnd5e', private: false },
      { id: 'p2', label: 'Items', type: 'Item', system: 'dnd5e', private: false },
    ];
    const { tools } = build('dnd5e', packs);

    const out = await tools.handleListCompendiumPacks({ type: 'Item' });
    expect(out.total).toBe(1);
    expect(out.packs[0].id).toBe('p2');
    // availableTypes is derived from the unfiltered pack list.
    expect(out.availableTypes.sort()).toEqual(['Actor', 'Item']);
  });

  it('returns an empty list when no packs exist', async () => {
    const { tools } = build('dnd5e', []);
    const out = await tools.handleListCompendiumPacks({});
    expect(out.total).toBe(0);
    expect(out.packs).toEqual([]);
    expect(out.availableTypes).toEqual([]);
  });

  it('excludes SRD (dnd5e.*) packs from the list and from availableTypes (enforced backstop)', async () => {
    const packs = [
      {
        id: 'dnd-monster-manual.actors',
        label: 'MM',
        type: 'Actor',
        system: 'dnd5e',
        private: false,
      },
      {
        id: 'dnd5e.monsters',
        label: 'SRD Monsters',
        type: 'Actor',
        system: 'dnd5e',
        private: false,
      },
      { id: 'dnd5e.spells24', label: 'SRD Spells', type: 'Item', system: 'dnd5e', private: false },
    ];
    const { tools } = build('dnd5e', packs);

    const out = await tools.handleListCompendiumPacks({});
    expect(out.total).toBe(1);
    expect(out.packs.map((p: any) => p.id)).toEqual(['dnd-monster-manual.actors']);
    // availableTypes derives from the visible (book) packs only — no SRD-only 'Item' type leaks in.
    expect(out.availableTypes).toEqual(['Actor']);
  });
});

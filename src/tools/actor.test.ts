/**
 * Unit tests for ActorTools (actor reads: get-actor, get-actor-entity, list-actors,
 * search-actor-contents). World-Item CRUD + add/remove-from-actor moved to ItemTools — see
 * items.test.ts.
 *
 * These exercise the two things each handler owns before/after the bridge call:
 *   1. zod input validation — required fields, .min(1) non-empty strings (bad input throws and
 *      never reaches the bridge).
 *   2. forwarding + response shaping — the bridge method name + payload the handler sends, and the
 *      object it builds from the bridge result.
 *
 * get-actor's basicInfo/stats come from the single dnd5e extractor
 * (tools/dnd5e/actor-stats.ts) — there is no system registry/adapter. To keep
 * call-index assertions robust we use a method-keyed mock response and locate
 * bridge calls by method name rather than by position.
 */

import { describe, it, expect } from 'vitest';
import { ActorTools } from './actor.js';
import { makeLogger, makeFoundry } from './test-helpers.js';

/**
 * Build an ActorTools with a method-keyed mock bridge.
 *
 * `responses` maps a bridge method name to the value its call resolves to
 * (keys are the bare op name, e.g. 'getCharacterInfo').
 */
function build(responses: Record<string, any> = {}) {
  const { foundry, calls } = makeFoundry((method: string) => responses[method]);
  const tools = new ActorTools({ foundry, logger: makeLogger() });
  return { tools, calls, foundry };
}

/** Find the [method, data] pair for a given bare bridge op name. */
function callFor(calls: Array<[string, any]>, bareMethod: string) {
  return calls.find(([m]) => m === bareMethod);
}

describe('ActorTools.getToolDefinitions', () => {
  it('exposes exactly the actor-read tool names', () => {
    const { tools } = build();
    const names = tools
      .getToolDefinitions()
      .map(t => t.name)
      .sort();
    expect(names).toEqual([
      'get-actor',
      'get-actor-entity',
      'list-actors',
      'search-actor-contents',
    ]);
  });

  it('every definition has an object inputSchema', () => {
    const { tools } = build();
    for (const def of tools.getToolDefinitions()) {
      expect(def.inputSchema.type).toBe('object');
    }
  });

  it('definitions with required fields expose a required array', () => {
    const { tools } = build();
    const byName = Object.fromEntries(tools.getToolDefinitions().map(d => [d.name, d]));
    expect(byName['get-actor'].inputSchema.required).toEqual(['identifier']);
  });
});

describe('handleGetCharacter', () => {
  it('forwards characterName and shapes the formatted response', async () => {
    const { tools, calls } = build({
      getCharacterInfo: {
        id: 'actor1',
        name: 'Aria',
        type: 'character',
        img: 'tokens/aria.png',
        system: {
          attributes: { hp: { value: 18, max: 22, temp: 0 }, ac: { value: 15 } },
          details: { level: { value: 3 }, class: 'Wizard', race: 'Elf' },
          abilities: { int: { value: 16, mod: 3 } },
          skills: { arc: { value: 1, ability: 'int' } },
        },
        // saves are attached TOP-LEVEL by getCharacterInfo (page-side extractSaves), not under system
        saves: { str: { value: 0, proficient: 0 }, int: { value: 5, proficient: 1 } },
        items: [{ id: 'i1', name: 'Dagger', type: 'weapon', system: { equipped: true } }],
        effects: [
          {
            id: 'e1',
            name: 'Mage Armor',
            disabled: false,
            duration: { type: 'turns', remaining: 10 },
            icon: 'x.png',
          },
        ],
        actions: [{ name: 'Firebolt', type: 'spell', itemId: 'i1' }],
        spellcasting: [{ name: 'Wizard Spells', type: 'prepared', ability: 'int' }],
      },
    });

    const out = await tools.handleGetCharacter({ identifier: 'Aria' });

    const c = callFor(calls, 'getCharacterInfo');
    expect(c).toBeTruthy();
    expect(c![1]).toEqual({ characterName: 'Aria' });

    expect(out.id).toBe('actor1');
    expect(out.name).toBe('Aria');
    expect(out.type).toBe('character');
    expect(out.hasImage).toBe(true);
    // basicInfo (extractActorBasicInfo)
    expect(out.basicInfo.hitPoints).toEqual({ current: 18, max: 22, temp: 0 });
    expect(out.basicInfo.armorClass).toBe(15);
    expect(out.basicInfo.level).toBe(3);
    expect(out.basicInfo.class).toBe('Wizard');
    expect(out.basicInfo.race).toBe('Elf');
    // stats (extractActorStats) — the single dnd5e get-actor stats path
    expect(out.stats.name).toBe('Aria');
    expect(out.stats.type).toBe('character');
    expect(out.stats.level).toBe(3);
    expect(out.stats.hitPoints).toEqual({ current: 18, max: 22, temp: 0 });
    expect(out.stats.armorClass).toBe(15);
    expect(out.stats.abilities.int).toEqual({ value: 16, modifier: 3 });
    expect(out.stats.skills.arc).toEqual({ value: 1, modifier: 0, proficient: 1 });
    // saves: derived totals attached top-level page-side (extractSaves) and passed through
    expect(out.stats.saves).toEqual({
      str: { value: 0, proficient: 0 },
      int: { value: 5, proficient: 1 },
    });
    // items / effects / actions / spellcasting
    expect(out.items).toEqual([{ id: 'i1', name: 'Dagger', type: 'weapon', equipped: true }]);
    expect(out.effects).toEqual([
      {
        id: 'e1',
        name: 'Mage Armor',
        disabled: false,
        duration: { type: 'turns', remaining: 10 },
        hasIcon: true,
      },
    ]);
    expect(out.actions).toEqual([{ name: 'Firebolt', type: 'spell', itemId: 'i1' }]);
    expect(out.spellcasting).toEqual([{ name: 'Wizard Spells', type: 'prepared', ability: 'int' }]);
  });

  it('collapses an embedded race item to its name and omits empty actions/spellcasting', async () => {
    const { tools } = build({
      getCharacterInfo: {
        id: 'a2',
        name: 'Bran',
        type: 'character',
        system: { details: { race: { name: 'Dwarf', _id: 'r1' } } },
        items: [],
        effects: [],
        actions: [],
        spellcasting: [],
      },
    });

    const out = await tools.handleGetCharacter({ identifier: 'Bran' });
    expect(out.basicInfo.race).toBe('Dwarf');
    expect(out.hasImage).toBe(false);
    expect(out.actions).toBeUndefined();
    expect(out.spellcasting).toBeUndefined();
  });

  it('wraps a bridge failure in a descriptive error', async () => {
    const { foundry, calls } = makeFoundry((method: string) => {
      if (method === 'getWorldInfo') return { system: 'dnd5e' };
      throw new Error('boom');
    });
    void calls;
    const tools = new ActorTools({ foundry, logger: makeLogger() });
    await expect(tools.handleGetCharacter({ identifier: 'Ghost' })).rejects.toThrow(
      /Failed to retrieve character "Ghost": boom/
    );
  });

  it('rejects an empty identifier', async () => {
    const { tools } = build();
    await expect(tools.handleGetCharacter({ identifier: '' })).rejects.toThrow();
  });

  it('rejects missing args', async () => {
    const { tools } = build();
    await expect(tools.handleGetCharacter({})).rejects.toThrow();
    await expect(tools.handleGetCharacter(undefined)).rejects.toThrow();
  });
});

describe('handleGetCharacterEntity', () => {
  const charWith = (extra: any) => ({
    getCharacterInfo: {
      id: 'c1',
      name: 'Aria',
      items: [],
      actions: [],
      effects: [],
      ...extra,
    },
  });

  it('resolves an item entity by name and returns full item shape', async () => {
    const { tools, calls } = build(
      charWith({
        items: [
          {
            id: 'it1',
            name: 'Flaming Sword',
            type: 'weapon',
            img: 'sword.png',
            system: {
              description: { value: 'A burning blade' },
              quantity: 2,
              equipped: true,
              attunement: 1,
            },
          },
        ],
      })
    );

    const out = await tools.handleGetCharacterEntity({
      characterIdentifier: 'Aria',
      entityIdentifier: 'flaming sword',
    });

    expect(callFor(calls, 'getCharacterInfo')![1]).toEqual({ characterName: 'Aria' });
    expect(out.entityType).toBe('item');
    expect(out.id).toBe('it1');
    expect(out.name).toBe('Flaming Sword');
    expect(out.type).toBe('weapon');
    expect(out.description).toBe('A burning blade');
    expect(out.quantity).toBe(2);
    expect(out.equipped).toBe(true);
    expect(out.attunement).toBe(1);
    expect(out.hasImage).toBe(true);
    expect(out.system).toBeTruthy();
  });

  it('resolves an action entity by name', async () => {
    const { tools } = build(
      charWith({
        actions: [{ name: 'Power Attack', type: 'action', itemId: 'x' }],
      })
    );
    const out = await tools.handleGetCharacterEntity({
      characterIdentifier: 'Aria',
      entityIdentifier: 'Power Attack',
    });
    expect(out.entityType).toBe('action');
    expect(out.name).toBe('Power Attack');
    expect(out.itemId).toBe('x');
    expect(out.description).toBe('Action from character strikes/abilities');
  });

  it('resolves an effect entity by name', async () => {
    const { tools } = build(
      charWith({
        effects: [{ id: 'ef1', name: 'Blessed', duration: { type: 'turns' } }],
      })
    );
    const out = await tools.handleGetCharacterEntity({
      characterIdentifier: 'Aria',
      entityIdentifier: 'blessed',
    });
    expect(out.entityType).toBe('effect');
    expect(out.id).toBe('ef1');
    expect(out.name).toBe('Blessed');
    expect(out.description).toBe('Blessed'); // falls back to name
  });

  it('throws when the entity is not found anywhere', async () => {
    const { tools } = build(charWith({}));
    await expect(
      tools.handleGetCharacterEntity({ characterIdentifier: 'Aria', entityIdentifier: 'Nope' })
    ).rejects.toThrow(/not found on character "Aria"/);
  });

  it('rejects an empty characterIdentifier', async () => {
    const { tools } = build();
    await expect(
      tools.handleGetCharacterEntity({ characterIdentifier: '', entityIdentifier: 'x' })
    ).rejects.toThrow();
  });

  it('rejects a missing entityIdentifier', async () => {
    const { tools } = build();
    await expect(tools.handleGetCharacterEntity({ characterIdentifier: 'Aria' })).rejects.toThrow();
  });
});

describe('handleListCharacters', () => {
  it('forwards the type filter and shapes the list result', async () => {
    const { tools, calls } = build({
      listActors: [
        { id: 'a1', name: 'Aria', type: 'character', img: 'a.png' },
        { id: 'a2', name: 'Goblin', type: 'npc' },
      ],
    });

    const out = await tools.handleListCharacters({ type: 'character' });

    const c = callFor(calls, 'listActors');
    expect(c![1]).toEqual({ type: 'character' });
    expect(out.total).toBe(2);
    expect(out.filtered).toBe('Filtered by type: character');
    expect(out.characters).toEqual([
      { id: 'a1', name: 'Aria', type: 'character', hasImage: true },
      { id: 'a2', name: 'Goblin', type: 'npc', hasImage: false },
    ]);
  });

  it('reports "All characters" when no type filter is supplied', async () => {
    const { tools } = build({ listActors: [] });
    const out = await tools.handleListCharacters({});
    expect(out.filtered).toBe('All characters');
    expect(out.total).toBe(0);
  });
});

describe('handleSearchCharacterItems', () => {
  it('forwards the search params with a default limit of 20', async () => {
    const { tools, calls } = build({
      searchCharacterItems: { characterName: 'Aria', matches: [{ id: 's1' }] },
    });
    const out = await tools.handleSearchCharacterItems({
      characterIdentifier: 'Aria',
      query: 'fire',
      type: 'spell',
    });
    expect(callFor(calls, 'searchCharacterItems')![1]).toEqual({
      characterIdentifier: 'Aria',
      query: 'fire',
      type: 'spell',
      category: undefined,
      limit: 20,
    });
    expect(out).toEqual({ characterName: 'Aria', matches: [{ id: 's1' }] });
  });

  it('passes an explicit limit through', async () => {
    const { tools, calls } = build({ searchCharacterItems: { matches: [] } });
    await tools.handleSearchCharacterItems({ characterIdentifier: 'Aria', limit: 5 });
    expect(callFor(calls, 'searchCharacterItems')![1].limit).toBe(5);
  });

  it('rejects an empty characterIdentifier', async () => {
    const { tools } = build();
    await expect(tools.handleSearchCharacterItems({ characterIdentifier: '' })).rejects.toThrow();
  });

  it('rejects a non-numeric limit', async () => {
    const { tools } = build();
    await expect(
      tools.handleSearchCharacterItems({ characterIdentifier: 'Aria', limit: 'lots' })
    ).rejects.toThrow();
  });
});

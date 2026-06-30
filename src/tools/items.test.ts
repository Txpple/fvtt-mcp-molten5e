/**
 * Unit tests for ItemTools — the world-Item lifecycle family: create/list/get/update/delete-item,
 * plus add-to-actor / remove-from-actor. (Split out of the old CharacterTools/ActorTools class.)
 *
 * Each handler owns two things around the bridge call:
 *   1. zod input validation — required ids/names, .min(1) non-empty strings/arrays, the dispatcher's
 *      action enum, and the remove-from-actor refine() (bad input throws, never hits the bridge).
 *   2. forwarding + response shaping — the bridge method name + payload the handler sends, and the
 *      object it builds from the bridge result.
 */

import { describe, it, expect } from 'vitest';
import { ItemTools } from './items.js';
import { makeLogger, makeFoundry } from './test-helpers.js';

/** Build an ItemTools with a method-keyed mock bridge (keys are bare op names, e.g. 'createWorldItems'). */
function build(responses: Record<string, any> = {}) {
  const { foundry, calls } = makeFoundry((method: string) => responses[method]);
  const tools = new ItemTools({ foundry, logger: makeLogger() });
  return { tools, calls, foundry };
}

/** Find the [method, data] pair for a given bare bridge op name. */
function callFor(calls: Array<[string, any]>, bareMethod: string) {
  return calls.find(([m]) => m === bareMethod);
}

describe('ItemTools.getToolDefinitions', () => {
  it('exposes exactly the world-item tool names', () => {
    const { tools } = build();
    const names = tools
      .getToolDefinitions()
      .map(t => t.name)
      .sort();
    expect(names).toEqual([
      'create-item',
      'delete-item',
      'get-item',
      'list-items',
      'remove-from-actor',
      'update-item',
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
    expect(byName['create-item'].inputSchema.required).toEqual(['items']);
    expect(byName['delete-item'].inputSchema.required).toEqual(['identifiers']);
  });
});

describe('handleAddActorItems', () => {
  it('forwards actorIdentifier + items and returns the bridge result', async () => {
    const { tools, calls } = build({
      addActorItems: { actorName: 'Aria', created: [{ id: 'n1' }] },
    });
    const out = await tools.handleAddActorItems({
      actorIdentifier: 'Aria',
      items: [{ name: 'Potion', type: 'consumable' }],
    });
    const c = callFor(calls, 'addActorItems');
    expect(c![1]).toEqual({
      actorIdentifier: 'Aria',
      items: [{ name: 'Potion', type: 'consumable' }],
    });
    expect(out).toEqual({ actorName: 'Aria', created: [{ id: 'n1' }] });
  });

  it('rejects an empty items array', async () => {
    const { tools } = build();
    await expect(
      tools.handleAddActorItems({ actorIdentifier: 'Aria', items: [] })
    ).rejects.toThrow();
  });

  it('rejects an item with an empty name', async () => {
    const { tools } = build();
    await expect(
      tools.handleAddActorItems({
        actorIdentifier: 'Aria',
        items: [{ name: '', type: 'weapon' }],
      })
    ).rejects.toThrow();
  });

  it('rejects a missing actorIdentifier', async () => {
    const { tools } = build();
    await expect(
      tools.handleAddActorItems({ items: [{ name: 'X', type: 'weapon' }] })
    ).rejects.toThrow();
  });
});

describe('handleUpdateWorldItems', () => {
  it('forwards updates and returns the bridge result', async () => {
    const { tools, calls } = build({ updateWorldItems: { updated: [{ id: 'i1' }] } });
    const out = await tools.handleUpdateWorldItems({
      updates: [{ id: 'i1', name: 'Renamed' }],
    });
    expect(callFor(calls, 'updateWorldItems')![1]).toEqual({
      updates: [{ id: 'i1', name: 'Renamed' }],
    });
    expect(out).toEqual({ updated: [{ id: 'i1' }] });
  });

  it('rejects an empty updates array', async () => {
    const { tools } = build();
    await expect(tools.handleUpdateWorldItems({ updates: [] })).rejects.toThrow();
  });

  it('rejects an update entry with an empty id', async () => {
    const { tools } = build();
    await expect(
      tools.handleUpdateWorldItems({ updates: [{ id: '', name: 'X' }] })
    ).rejects.toThrow();
  });
});

describe('handleListWorldItems', () => {
  it('forwards only the provided filters and shapes the result', async () => {
    const { tools, calls } = build({
      listWorldItems: [{ id: 'i1' }, { id: 'i2' }],
    });
    const out = await tools.handleListWorldItems({ type: 'weapon' });
    // Only `type` was provided, so folder/nameFilter must be absent from payload.
    expect(callFor(calls, 'listWorldItems')![1]).toEqual({ type: 'weapon' });
    expect(out).toEqual({ items: [{ id: 'i1' }, { id: 'i2' }], total: 2 });
  });

  it('defaults to an empty list when the bridge returns nothing', async () => {
    const { tools, calls } = build({ listWorldItems: undefined });
    const out = await tools.handleListWorldItems({});
    expect(callFor(calls, 'listWorldItems')![1]).toEqual({});
    expect(out).toEqual({ items: [], total: 0 });
  });
});

describe('handleCreateWorldItems', () => {
  it('forwards items + folder and returns the bridge result', async () => {
    const { tools, calls } = build({
      createWorldItems: { folderId: 'f1', created: [{ id: 'n1' }] },
    });
    const out = await tools.handleCreateWorldItems({
      items: [{ name: 'Sword', type: 'weapon' }],
      folder: 'Loot',
    });
    expect(callFor(calls, 'createWorldItems')![1]).toEqual({
      items: [{ name: 'Sword', type: 'weapon' }],
      folder: 'Loot',
    });
    expect(out).toEqual({ folderId: 'f1', created: [{ id: 'n1' }] });
  });

  it('rejects an empty items array', async () => {
    const { tools } = build();
    await expect(tools.handleCreateWorldItems({ items: [] })).rejects.toThrow();
  });

  it('rejects an item missing a type', async () => {
    const { tools } = build();
    await expect(tools.handleCreateWorldItems({ items: [{ name: 'X' }] })).rejects.toThrow();
  });

  it('surfaces page-side img warnings (bad path substituted)', async () => {
    const { tools } = build({
      createWorldItems: {
        folderId: 'f1',
        created: [{ id: 'n1' }],
        warnings: [
          'Supplied img "x/nope.webp" was not found on the server — substituted a real icon.',
        ],
      },
    });
    const out = await tools.handleCreateWorldItems({
      items: [{ name: 'Sword', type: 'weapon', img: 'x/nope.webp' }],
    });
    expect(out.message).toContain('not found on the server');
  });
});

describe('handleManageWorldItems (dispatch)', () => {
  it('routes "create" to handleCreateWorldItems', async () => {
    const { tools, calls } = build({ createWorldItems: { created: [] } });
    await tools.handleManageWorldItems({
      action: 'create',
      items: [{ name: 'X', type: 'weapon' }],
    });
    expect(callFor(calls, 'createWorldItems')).toBeTruthy();
  });

  it('routes "list" to handleListWorldItems', async () => {
    const { tools, calls } = build({ listWorldItems: [] });
    await tools.handleManageWorldItems({ action: 'list' });
    expect(callFor(calls, 'listWorldItems')).toBeTruthy();
  });

  it('routes "get" to handleGetWorldItem', async () => {
    const { tools, calls } = build({ getWorldItem: { id: 'i1' } });
    await tools.handleManageWorldItems({ action: 'get', identifier: 'i1' });
    expect(callFor(calls, 'getWorldItem')).toBeTruthy();
  });

  it('routes "delete" to handleDeleteWorldItems', async () => {
    const { tools, calls } = build({ deleteWorldItems: { deletedCount: 1 } });
    await tools.handleManageWorldItems({ action: 'delete', identifiers: ['i1'] });
    expect(callFor(calls, 'deleteWorldItems')).toBeTruthy();
  });

  it('routes "add-to-actor" to handleAddActorItems', async () => {
    const { tools, calls } = build({ addActorItems: { created: [] } });
    await tools.handleManageWorldItems({
      action: 'add-to-actor',
      actorIdentifier: 'Aria',
      items: [{ name: 'X', type: 'weapon' }],
    });
    expect(callFor(calls, 'addActorItems')).toBeTruthy();
  });

  it('routes "remove-from-actor" to handleRemoveActorItems', async () => {
    const { tools, calls } = build({ removeActorItems: { removed: [] } });
    await tools.handleManageWorldItems({
      action: 'remove-from-actor',
      actorIdentifier: 'Aria',
      itemIds: ['i1'],
    });
    expect(callFor(calls, 'removeActorItems')).toBeTruthy();
  });

  it('rejects an invalid action enum value', async () => {
    const { tools } = build();
    await expect(tools.handleManageWorldItems({ action: 'frobnicate' })).rejects.toThrow();
  });
});

describe('handleGetWorldItem', () => {
  it('forwards the identifier and returns the item', async () => {
    const { tools, calls } = build({ getWorldItem: { id: 'i1', name: 'Sword' } });
    const out = await tools.handleGetWorldItem({ identifier: 'i1' });
    expect(callFor(calls, 'getWorldItem')![1]).toEqual({ identifier: 'i1' });
    expect(out).toEqual({ id: 'i1', name: 'Sword' });
  });

  it('rejects an empty identifier', async () => {
    const { tools } = build();
    await expect(tools.handleGetWorldItem({ identifier: '' })).rejects.toThrow();
  });
});

describe('handleDeleteWorldItems', () => {
  it('forwards identifiers and returns the bridge result', async () => {
    const { tools, calls } = build({ deleteWorldItems: { deletedCount: 2 } });
    const out = await tools.handleDeleteWorldItems({ identifiers: ['i1', 'i2'] });
    expect(callFor(calls, 'deleteWorldItems')![1]).toEqual({ identifiers: ['i1', 'i2'] });
    expect(out).toEqual({ deletedCount: 2 });
  });

  it('rejects an empty identifiers array', async () => {
    const { tools } = build();
    await expect(tools.handleDeleteWorldItems({ identifiers: [] })).rejects.toThrow();
  });

  it('rejects an identifier that is an empty string', async () => {
    const { tools } = build();
    await expect(tools.handleDeleteWorldItems({ identifiers: [''] })).rejects.toThrow();
  });
});

describe('handleRemoveActorItems', () => {
  it('forwards actorIdentifier + itemIds and returns the bridge result', async () => {
    const { tools, calls } = build({
      removeActorItems: { actorName: 'Aria', removed: [{ id: 'r1' }] },
    });
    const out = await tools.handleRemoveActorItems({
      actorIdentifier: 'Aria',
      itemIds: ['r1'],
    });
    expect(callFor(calls, 'removeActorItems')![1]).toEqual({
      actorIdentifier: 'Aria',
      itemIds: ['r1'],
    });
    expect(out).toEqual({ actorName: 'Aria', removed: [{ id: 'r1' }] });
  });

  it('omits undefined itemNames/type from the payload', async () => {
    const { tools, calls } = build({ removeActorItems: { removed: [] } });
    await tools.handleRemoveActorItems({ actorIdentifier: 'Aria', itemNames: ['Dagger'] });
    expect(callFor(calls, 'removeActorItems')![1]).toEqual({
      actorIdentifier: 'Aria',
      itemNames: ['Dagger'],
    });
  });

  it('rejects when neither itemIds nor itemNames is provided (refine)', async () => {
    const { tools } = build();
    await expect(tools.handleRemoveActorItems({ actorIdentifier: 'Aria' })).rejects.toThrow();
  });

  it('rejects an empty actorIdentifier', async () => {
    const { tools } = build();
    await expect(
      tools.handleRemoveActorItems({ actorIdentifier: '', itemIds: ['x'] })
    ).rejects.toThrow();
  });
});

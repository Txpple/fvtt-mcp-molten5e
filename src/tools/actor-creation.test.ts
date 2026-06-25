/**
 * Unit tests for ActorCreationTools
 * (create-actor-from-compendium, delete-actor, delete-folder).
 *
 * Each handler owns three things around the bridge call:
 *   1. zod input validation — required ids/names, non-empty strings, enum
 *      membership, min array length (bad input throws, never hits the bridge).
 *   2. payload forwarding — the exact bridge method + data passed through,
 *      including the name back-fill that pads `customNames` up to quantity.
 *   3. response formatting — the `message` string built from the bridge result,
 *      across the success / not-found / deleted-contents branches.
 */

import { describe, it, expect } from 'vitest';
import { ActorCreationTools } from './actor-creation.js';
import { makeLogger, makeFoundry } from './test-helpers.js';

function build(response: any = {}) {
  const { foundry, calls } = makeFoundry(response);
  const tools = new ActorCreationTools({ foundry, logger: makeLogger() });
  return { tools, calls, foundry };
}

describe('ActorCreationTools.getToolDefinitions', () => {
  it('exposes the compendium-pull tool and the delete tools', () => {
    const { tools } = build();
    const names = tools
      .getToolDefinitions()
      .map(t => t.name)
      .sort();
    expect(names).toEqual(['create-actor-from-compendium', 'delete-actor', 'delete-folder']);
  });

  it('every definition has an object inputSchema', () => {
    const { tools } = build();
    for (const def of tools.getToolDefinitions()) {
      expect(def.inputSchema.type).toBe('object');
    }
  });
});

describe('handleCreateActorFromCompendium', () => {
  it('forwards the correct bridge method and payload for a single actor', async () => {
    const { tools, calls } = build({
      success: true,
      totalCreated: 1,
      totalRequested: 1,
      actors: [{ name: 'Flameheart', id: 'a1' }],
      tokensPlaced: 0,
    });
    await tools.handleCreateActorFromCompendium({
      packId: 'dnd-monster-manual.actors',
      itemId: 'owlbear-id',
      names: ['Flameheart'],
    });
    expect(calls[0][0]).toBe('createActorFromCompendium');
    expect(calls[0][1]).toMatchObject({
      packId: 'dnd-monster-manual.actors',
      itemId: 'owlbear-id',
      customNames: ['Flameheart'],
      quantity: 1,
      addToScene: false,
    });
  });

  it('back-fills names when quantity exceeds the names array', async () => {
    const { tools, calls } = build({
      success: true,
      totalCreated: 3,
      totalRequested: 3,
      actors: [],
      tokensPlaced: 0,
    });
    await tools.handleCreateActorFromCompendium({
      packId: 'p',
      itemId: 'i',
      names: ['Goblin'],
      quantity: 3,
    });
    // first name kept, remainder padded "<base> <n>"
    expect(calls[0][1].customNames).toEqual(['Goblin', 'Goblin 2', 'Goblin 3']);
    expect(calls[0][1].quantity).toBe(3);
  });

  it('forwards placement when addToScene is requested', async () => {
    const { tools, calls } = build({
      success: true,
      totalCreated: 1,
      totalRequested: 1,
      actors: [{ name: 'X' }],
      tokensPlaced: 1,
    });
    await tools.handleCreateActorFromCompendium({
      packId: 'p',
      itemId: 'i',
      names: ['X'],
      addToScene: true,
      placement: { type: 'coordinates', coordinates: [{ x: 5, y: 6 }] },
    });
    expect(calls[0][1].addToScene).toBe(true);
    expect(calls[0][1].placement).toEqual({
      type: 'coordinates',
      coordinates: [{ x: 5, y: 6 }],
    });
  });

  it('formats the success message with created counts and source pack', async () => {
    const { tools } = build({
      success: true,
      totalCreated: 2,
      totalRequested: 2,
      actors: [{ name: 'Sneak' }, { name: 'Peek' }],
      tokensPlaced: 0,
    });
    const out = await tools.handleCreateActorFromCompendium({
      packId: 'dnd-monster-manual.actors',
      itemId: 'goblin-id',
      names: ['Sneak', 'Peek'],
    });
    expect(out.summary).toBe('✅ Created 2 of 2 requested actors');
    expect(out.message).toContain('✅ Created 2 of 2 requested actors');
    expect(out.message).toContain('• **Sneak** (from dnd-monster-manual.actors)');
    expect(out.message).toContain('• **Peek** (from dnd-monster-manual.actors)');
    expect(out.message).not.toContain('Added');
    expect(out.message).not.toContain('Issues');
  });

  it('forwards modifications to the page for the prefab-as-base bridge', async () => {
    const { tools, calls } = build({
      success: true,
      totalCreated: 1,
      totalRequested: 1,
      actors: [{ name: 'Veteran Captain', id: 'a1' }],
      tokensPlaced: 0,
    });
    await tools.handleCreateActorFromCompendium({
      packId: 'dnd-monster-manual.actors',
      itemId: 'veteran-id',
      names: ['Veteran Captain'],
      modifications: { cr: 4, hp: { value: 90, max: 90 } },
    });
    const call = calls.find(c => c[0] === 'createActorFromCompendium');
    expect(call![1].modifications).toEqual({ cr: 4, hp: { value: 90, max: 90 } });
  });

  it('omits modifications from the page call when none are given', async () => {
    const { tools, calls } = build({
      success: true,
      totalCreated: 1,
      totalRequested: 1,
      actors: [{ name: 'X' }],
      tokensPlaced: 0,
    });
    await tools.handleCreateActorFromCompendium({ packId: 'p', itemId: 'i', names: ['X'] });
    expect(calls[0][1]).not.toHaveProperty('modifications');
  });

  it('surfaces the layered modifications the page applied to the world copy', async () => {
    const { tools } = build({
      success: true,
      totalCreated: 1,
      totalRequested: 1,
      actors: [
        {
          name: 'Veteran Captain',
          id: 'a1',
          modifications: { applied: ['cr', 'hp'], warnings: [] },
        },
      ],
      tokensPlaced: 0,
    });
    const out = await tools.handleCreateActorFromCompendium({
      packId: 'p',
      itemId: 'i',
      names: ['Veteran Captain'],
      modifications: { cr: 4 },
    });
    expect(out.message).toContain('🔧 Layered onto the copy: cr, hp');
    expect(out.details.modifications).toEqual({ applied: ['cr', 'hp'], warnings: [] });
  });

  it('surfaces modification warnings update-actor raised on the copy', async () => {
    const { tools } = build({
      success: true,
      totalCreated: 1,
      totalRequested: 1,
      actors: [
        {
          name: 'X',
          id: 'a1',
          modifications: {
            applied: ['damageResistances'],
            warnings: ['Unknown damage type "lazer"'],
          },
        },
      ],
      tokensPlaced: 0,
    });
    const out = await tools.handleCreateActorFromCompendium({
      packId: 'p',
      itemId: 'i',
      names: ['X'],
      modifications: { damageResistances: { values: ['lazer'] } },
    });
    expect(out.message).toContain('⚠️ Modification warnings: Unknown damage type "lazer"');
  });

  it('surfaces unresolved @scale tokens the page reports on a copied actor', async () => {
    const { tools } = build({
      success: true,
      totalCreated: 1,
      totalRequested: 1,
      actors: [
        {
          name: 'Drako',
          id: 'a1',
          unresolvedScale: [
            {
              itemId: 'i1',
              itemName: 'Fire Breath Weapon',
              path: 'system.activities.b.damage.parts.0.bonus',
              formula: '@scale.dragonborn.breath-damage',
            },
          ],
        },
      ],
      tokensPlaced: 0,
    });
    const out = await tools.handleCreateActorFromCompendium({
      packId: 'dnd-monster-manual.actors',
      itemId: 'drako-id',
      names: ['Drako'],
    });
    expect(out.message).toContain('1 unresolved');
    expect(out.message).toContain('Drako → Fire Breath Weapon');
    expect(out.message).toContain('@scale.dragonborn.breath-damage');
    expect(out.details.unresolvedScale).toEqual([
      {
        label: 'Drako → Fire Breath Weapon',
        path: 'system.activities.b.damage.parts.0.bonus',
        formula: '@scale.dragonborn.breath-damage',
      },
    ]);
  });

  it('appends scene placement and error info when present', async () => {
    const { tools } = build({
      success: true,
      totalCreated: 1,
      totalRequested: 1,
      actors: [{ name: 'X' }],
      tokensPlaced: 2,
      errors: ['scene full'],
    });
    const out = await tools.handleCreateActorFromCompendium({
      packId: 'p',
      itemId: 'i',
      names: ['X'],
      addToScene: true,
    });
    expect(out.message).toContain('🎯 Added 2 tokens to the current scene');
    expect(out.message).toContain('⚠️ Issues: scene full');
  });

  it('rejects an empty packId', async () => {
    const { tools } = build();
    await expect(
      tools.handleCreateActorFromCompendium({ packId: '', itemId: 'i', names: ['X'] })
    ).rejects.toThrow();
  });

  it('rejects a missing itemId', async () => {
    const { tools } = build();
    await expect(
      tools.handleCreateActorFromCompendium({ packId: 'p', names: ['X'] })
    ).rejects.toThrow();
  });

  it('rejects an empty names array', async () => {
    const { tools } = build();
    await expect(
      tools.handleCreateActorFromCompendium({ packId: 'p', itemId: 'i', names: [] })
    ).rejects.toThrow();
  });

  it('rejects a name that is an empty string', async () => {
    const { tools } = build();
    await expect(
      tools.handleCreateActorFromCompendium({ packId: 'p', itemId: 'i', names: [''] })
    ).rejects.toThrow();
  });

  it('rejects a quantity above the max of 10', async () => {
    const { tools } = build();
    await expect(
      tools.handleCreateActorFromCompendium({
        packId: 'p',
        itemId: 'i',
        names: ['X'],
        quantity: 11,
      })
    ).rejects.toThrow();
  });

  it('rejects an invalid placement type', async () => {
    const { tools } = build();
    await expect(
      tools.handleCreateActorFromCompendium({
        packId: 'p',
        itemId: 'i',
        names: ['X'],
        placement: { type: 'spiral' },
      })
    ).rejects.toThrow();
  });
});

describe('handleDeleteActor', () => {
  it('forwards the deleteActor bridge call with defaults', async () => {
    const { tools, calls } = build({
      success: true,
      deletedCount: 1,
      deleted: [{ name: 'Goblin', id: 'g1' }],
      notFound: [],
    });
    await tools.handleDeleteActor({ identifiers: ['Goblin'] });
    expect(calls[0][0]).toBe('deleteActor');
    expect(calls[0][1]).toMatchObject({ identifiers: ['Goblin'], removeEmptyFolder: true });
  });

  it('formats the deleted list with singular wording for one actor', async () => {
    const { tools } = build({
      success: true,
      deletedCount: 1,
      deleted: [{ name: 'Goblin', id: 'g1' }],
      notFound: [],
    });
    const out = await tools.handleDeleteActor({ identifiers: ['Goblin'] });
    expect(out.message).toContain('🗑️ Deleted 1 actor');
    expect(out.message).not.toContain('actors');
    expect(out.message).toContain('• **Goblin** (g1)');
  });

  it('uses plural wording and appends not-found + removed-folder info', async () => {
    const { tools } = build({
      success: true,
      deletedCount: 2,
      deleted: [
        { name: 'Goblin', id: 'g1' },
        { name: 'Kobold', id: 'k1' },
      ],
      notFound: ['ghost'],
      removedFolders: [{ name: 'Foundry MCP Creatures' }],
    });
    const out = await tools.handleDeleteActor({ identifiers: ['g1', 'k1', 'ghost'] });
    expect(out.message).toContain('🗑️ Deleted 2 actors');
    expect(out.message).toContain('⚠️ Not found (nothing deleted): ghost');
    expect(out.message).toContain('📁 Also removed emptied folder(s): Foundry MCP Creatures');
  });

  it('passes removeEmptyFolder=false through', async () => {
    const { tools, calls } = build({ deletedCount: 0, deleted: [], notFound: [] });
    await tools.handleDeleteActor({ identifiers: ['x'], removeEmptyFolder: false });
    expect(calls[0][1].removeEmptyFolder).toBe(false);
  });

  it('rejects an empty identifiers array', async () => {
    const { tools } = build();
    await expect(tools.handleDeleteActor({ identifiers: [] })).rejects.toThrow();
  });

  it('rejects an identifier that is an empty string', async () => {
    const { tools } = build();
    await expect(tools.handleDeleteActor({ identifiers: [''] })).rejects.toThrow();
  });

  it('rejects missing identifiers entirely', async () => {
    const { tools } = build();
    await expect(tools.handleDeleteActor({})).rejects.toThrow();
  });
});

describe('handleDeleteFolder', () => {
  it('forwards the deleteFolder bridge call with type/deleteContents defaults', async () => {
    const { tools, calls } = build({
      success: true,
      deleted: true,
      folder: { name: 'Loot', id: 'f1' },
    });
    await tools.handleDeleteFolder({ identifier: 'Loot' });
    expect(calls[0][0]).toBe('deleteFolder');
    expect(calls[0][1]).toMatchObject({
      identifier: 'Loot',
      type: 'Actor',
      deleteContents: false,
    });
  });

  it('formats an empty-folder deletion message', async () => {
    const { tools } = build({
      success: true,
      deleted: true,
      folder: { name: 'Loot', id: 'f1' },
    });
    const out = await tools.handleDeleteFolder({ identifier: 'Loot' });
    expect(out.message).toBe('🗑️ Deleted folder **Loot** (f1)\n(was empty)');
  });

  it('reports removed contents when deleteContents was applied', async () => {
    const { tools, calls } = build({
      success: true,
      deleted: true,
      deletedContents: true,
      folder: { name: 'Old', id: 'f9' },
      removedDocuments: 3,
      removedSubfolders: 1,
    });
    const out = await tools.handleDeleteFolder({
      identifier: 'Old',
      type: 'JournalEntry',
      deleteContents: true,
    });
    expect(calls[0][1]).toMatchObject({ type: 'JournalEntry', deleteContents: true });
    expect(out.message).toContain('🗑️ Deleted folder **Old** (f9)');
    expect(out.message).toContain('⚠️ Also deleted 3 document(s) and 1 subfolder(s) inside it');
  });

  it('formats a not-found result using the bridge notFound value', async () => {
    const { tools } = build({ success: false, deleted: false, notFound: 'Ghost Folder' });
    const out = await tools.handleDeleteFolder({ identifier: 'Ghost Folder' });
    expect(out.message).toBe('⚠️ Folder not found: Ghost Folder');
    expect(out.details.deleted).toBe(false);
  });

  it('falls back to the supplied identifier when notFound is absent', async () => {
    const { tools } = build({ success: false, deleted: false });
    const out = await tools.handleDeleteFolder({ identifier: 'Mystery' });
    expect(out.message).toBe('⚠️ Folder not found: Mystery');
  });

  it('rejects an empty identifier', async () => {
    const { tools } = build();
    await expect(tools.handleDeleteFolder({ identifier: '' })).rejects.toThrow();
  });

  it('rejects a missing identifier', async () => {
    const { tools } = build();
    await expect(tools.handleDeleteFolder({})).rejects.toThrow();
  });
});

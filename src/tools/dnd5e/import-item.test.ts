/**
 * Unit tests for DnD5eImportItemTool (import-item → importItemFromCompendium).
 *
 * Covers: tool definition, zod validation (required packId/itemId), bridge forwarding of the parsed
 * payload, and the response formatter (incl. the "renamed from" branch and the actor vs world target
 * line). handleImportItem probes the system via assertDnd5e (getWorldInfo, cached), so the fake bridge
 * answers that probe with dnd5e and the cache is cleared before each test.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DnD5eImportItemTool } from './import-item.js';
import { makeLogger, makeFoundry } from '../test-helpers.js';
import { clearSystemCache } from '../../utils/system-detection.js';

function build(bridgeResult: any = {}) {
  const { foundry, calls } = makeFoundry((method: string) =>
    method === 'getWorldInfo' ? { system: 'dnd5e' } : bridgeResult
  );
  const tools = new DnD5eImportItemTool({ foundry, logger: makeLogger() });
  return { tools, calls, foundry };
}

beforeEach(() => {
  clearSystemCache();
});

describe('DnD5eImportItemTool.getToolDefinitions', () => {
  it('exposes the single import-item tool with an object inputSchema', () => {
    const { tools } = build();
    const defs = tools.getToolDefinitions();
    expect(defs.map(d => d.name)).toEqual(['import-item']);
    expect(defs[0].inputSchema.type).toBe('object');
  });
});

describe('handleImportItem — validation', () => {
  it('rejects missing packId / itemId', async () => {
    const { tools } = build();
    await expect(tools.handleImportItem({ itemId: 'x' })).rejects.toThrow();
    await expect(tools.handleImportItem({ packId: 'p' })).rejects.toThrow();
  });
});

describe('handleImportItem — forwarding + formatting', () => {
  it('forwards the parsed payload to importItemFromCompendium and formats an actor copy', async () => {
    const { tools, calls } = build({
      success: true,
      source: { packId: 'dnd-players-handbook.equipment', itemId: 'phbMace', name: 'Mace' },
      target: { type: 'actor', id: 'a1', name: 'Rhogar' },
      item: { id: 'i1', name: 'Mace', type: 'weapon' },
    });
    const out = await tools.handleImportItem({
      packId: 'dnd-players-handbook.equipment',
      itemId: 'phbMace',
      actorIdentifier: 'Rhogar',
      equipped: true,
    });

    const call = calls.find(c => c[0] === 'importItemFromCompendium');
    expect(call).toBeDefined();
    expect(call![1]).toMatchObject({
      packId: 'dnd-players-handbook.equipment',
      itemId: 'phbMace',
      actorIdentifier: 'Rhogar',
      equipped: true,
    });
    expect(out.success).toBe(true);
    expect(out.summary).toBe('✅ Copied "Mace" onto actor "Rhogar"');
    expect(out.message).toContain('**Source:** `dnd-players-handbook.equipment` / `phbMace`');
  });

  it('notes the rename in the summary when name differs from the source', async () => {
    const { tools } = build({
      success: true,
      source: {
        packId: 'dnd-dungeon-masters-guide.equipment',
        itemId: 'shield1',
        name: 'Shield, +1',
      },
      target: { type: 'actor', id: 'a1', name: 'Rhogar' },
      item: { id: 'i2', name: 'Aegis of the Dawnflame', type: 'equipment' },
    });
    const out = await tools.handleImportItem({
      packId: 'dnd-dungeon-masters-guide.equipment',
      itemId: 'shield1',
      actorIdentifier: 'Rhogar',
      name: 'Aegis of the Dawnflame',
    });
    expect(out.summary).toBe(
      '✅ Copied "Aegis of the Dawnflame" (from "Shield, +1") onto actor "Rhogar"'
    );
  });

  it('surfaces an unresolved @scale token the page reports on the copy', async () => {
    const { tools } = build({
      success: true,
      source: { packId: 'dnd-dungeon-masters-guide.equipment', itemId: 'staff1', name: 'Staff X' },
      target: { type: 'actor', id: 'a1', name: 'Rhogar' },
      item: { id: 'i4', name: 'Staff X', type: 'weapon' },
      unresolvedScale: [{ path: 'system.uses.max', formula: '@scale.wizard.arcane-recovery' }],
    });
    const out = await tools.handleImportItem({
      packId: 'dnd-dungeon-masters-guide.equipment',
      itemId: 'staff1',
      actorIdentifier: 'Rhogar',
    });
    expect(out.message).toContain('1 unresolved');
    expect(out.message).toContain('@scale.wizard.arcane-recovery');
    expect(out.unresolvedScale).toEqual([
      { label: 'Staff X', path: 'system.uses.max', formula: '@scale.wizard.arcane-recovery' },
    ]);
  });

  it('formats a world-target copy', async () => {
    const { tools } = build({
      success: true,
      source: {
        packId: 'dnd-dungeon-masters-guide.equipment',
        itemId: 'potion1',
        name: 'Potion of Healing',
      },
      target: { type: 'world', folderName: 'Loot' },
      item: { id: 'i3', name: 'Potion of Healing', type: 'consumable' },
    });
    const out = await tools.handleImportItem({
      packId: 'dnd-dungeon-masters-guide.equipment',
      itemId: 'potion1',
    });
    expect(out.summary).toBe('✅ Copied "Potion of Healing" onto world Items (folder "Loot")');
  });
});

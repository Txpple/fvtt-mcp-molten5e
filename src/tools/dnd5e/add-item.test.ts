/**
 * Unit tests for the add-item tool: schema validation, soft-validation warnings, normalized
 * forwarding to the addItem bridge call, and response shaping. The page-side buildPhysicalItemData
 * correctness is covered by items.test.ts + the live acceptance script.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DnD5eAddItemTool } from './add-item.js';
import { makeFoundry, makeLogger } from '../test-helpers.js';
import { clearSystemCache } from '../../utils/system-detection.js';

beforeEach(() => clearSystemCache());

function makeTool(response: any = {}) {
  const { foundry, calls } = makeFoundry((name: string) =>
    name === 'getWorldInfo'
      ? { system: 'dnd5e' }
      : {
          success: true,
          target: { type: 'actor', name: 'Knight' },
          item: { id: 'i1', name: 'X', type: 'weapon' },
          ...response,
        }
  );
  const tool = new DnD5eAddItemTool({ foundry, logger: makeLogger() });
  return { tool, calls };
}

describe('add-item tool definition', () => {
  it('advertises add-item requiring itemType + name', () => {
    const { tool } = makeTool();
    const def = tool.getToolDefinitions()[0];
    expect(def.name).toBe('add-item');
    const req = (def.inputSchema as any).required;
    expect(req).toContain('itemType');
    expect(req).toContain('name');
  });
});

describe('handleAddItem', () => {
  it('forwards a weapon and defaults withAttack=true when damage is given', async () => {
    const { tool, calls } = makeTool();
    await tool.handleAddItem({
      itemType: 'weapon',
      actorIdentifier: 'Knight',
      name: '+1 Longsword',
      damage: { number: 1, denomination: 8, types: ['slashing'] },
      magicalBonus: 1,
      attunement: 'required',
    });
    const call = calls.find(([n]) => n === 'addItem');
    expect(call?.[1].itemType).toBe('weapon');
    expect(call?.[1].withAttack).toBe(true);
    expect(call?.[1].magicalBonus).toBe(1);
    expect(call?.[1].attunement).toBe('required');
  });

  it('respects withAttack:false on a loot weapon', async () => {
    const { tool, calls } = makeTool();
    await tool.handleAddItem({
      itemType: 'weapon',
      name: 'Broken Sword',
      damage: { number: 1, denomination: 8, types: ['slashing'] },
      withAttack: false,
    });
    const call = calls.find(([n]) => n === 'addItem');
    expect(call?.[1].withAttack).toBe(false);
  });

  it('never sets withAttack for non-weapon types', async () => {
    const { tool, calls } = makeTool();
    await tool.handleAddItem({ itemType: 'loot', name: 'Ruby', lootType: 'gem' });
    const call = calls.find(([n]) => n === 'addItem');
    expect(call?.[1].withAttack).toBe(false);
  });

  it('warns (without blocking) on an unknown damage type', async () => {
    const { tool } = makeTool();
    const res = await tool.handleAddItem({
      itemType: 'weapon',
      name: 'Weird Blade',
      damage: { number: 1, denomination: 8, types: ['kryptonite'] },
    });
    expect(res.warnings.some((w: string) => w.includes('kryptonite'))).toBe(true);
    expect(res.success).toBe(true);
  });

  it('warns when attuned is set but attunement is none', async () => {
    const { tool } = makeTool();
    const res = await tool.handleAddItem({
      itemType: 'wondrous',
      name: 'Ring',
      attuned: true,
    });
    expect(res.warnings.some((w: string) => w.toLowerCase().includes('attun'))).toBe(true);
  });

  it('warns when armor is created without an armorValue', async () => {
    const { tool } = makeTool();
    const res = await tool.handleAddItem({ itemType: 'armor', name: 'Mystery Plate' });
    expect(res.warnings.some((w: string) => w.includes('armorValue'))).toBe(true);
  });

  it('warns when a ranged weapon has no rangeFt', async () => {
    const { tool } = makeTool();
    const res = await tool.handleAddItem({
      itemType: 'weapon',
      name: 'Shortbow',
      attackType: 'ranged',
      damage: { number: 1, denomination: 6, types: ['piercing'] },
    });
    expect(res.warnings.some((w: string) => w.includes('rangeFt'))).toBe(true);
  });

  it('warns when attunement is set on a loot item (it is ignored)', async () => {
    const { tool } = makeTool();
    const res = await tool.handleAddItem({
      itemType: 'loot',
      name: 'Mystery Gem',
      lootType: 'gem',
      attunement: 'required',
    });
    expect(res.warnings.some((w: string) => w.includes('ignored for loot'))).toBe(true);
  });

  it('warns that a wondrous item has no numeric +N field', async () => {
    const { tool } = makeTool();
    const res = await tool.handleAddItem({
      itemType: 'wondrous',
      name: 'Ring of Power',
      magicalBonus: 1,
    });
    expect(res.warnings.some((w: string) => w.includes('manage-effect'))).toBe(true);
  });

  it('surfaces a page-side icon-substitution warning (a 404 img → auto-resolved, rule 8)', async () => {
    const { tool } = makeTool({
      warnings: [
        'Supplied img "icons/commodities/gems/pearl-white.webp" was not found on the server — substituted an auto-resolved icon (rule 8).',
      ],
    });
    const res = await tool.handleAddItem({
      itemType: 'loot',
      name: 'Tribute Pearl',
      lootType: 'gem',
      img: 'icons/commodities/gems/pearl-white.webp',
    });
    expect(res.success).toBe(true);
    expect(res.warnings.some((w: string) => w.includes('not found on the server'))).toBe(true);
    // and it reaches the human-readable message too
    expect(res.message).toContain('not found on the server');
  });

  it('rejects a missing name', async () => {
    const { tool } = makeTool();
    await expect(tool.handleAddItem({ itemType: 'loot' })).rejects.toThrow();
  });

  it('rejects an unknown itemType', async () => {
    const { tool } = makeTool();
    await expect(tool.handleAddItem({ itemType: 'spaceship', name: 'X' })).rejects.toThrow();
  });

  it('rejects a bad price denomination', async () => {
    const { tool } = makeTool();
    await expect(
      tool.handleAddItem({ itemType: 'loot', name: 'X', price: { value: 5, denomination: 'usd' } })
    ).rejects.toThrow();
  });
});

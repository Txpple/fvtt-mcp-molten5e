/**
 * Unit tests for manage-activity: validation + forwarding + response shaping. The bridge seam is
 * mocked; the live add/edit/remove/list against real items is covered by the acceptance script.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DnD5eManageActivityTool } from './manage-activity.js';
import { makeFoundry, makeLogger } from '../test-helpers.js';
import { clearSystemCache } from '../../utils/system-detection.js';

beforeEach(() => clearSystemCache());

function makeTool(response: any = {}) {
  const { foundry, calls } = makeFoundry((name: string) =>
    name === 'getWorldInfo' ? { system: 'dnd5e' } : response
  );
  const tool = new DnD5eManageActivityTool({ foundry, logger: makeLogger() });
  return { tool, calls };
}

describe('manage-activity tool', () => {
  it('advertises manage-activity with a generated inputSchema', () => {
    const { tool } = makeTool();
    const def = tool.getToolDefinitions()[0];
    expect(def.name).toBe('manage-activity');
    const req = (def.inputSchema as any).required;
    expect(req).toContain('action');
    expect(req).toContain('itemIdentifier');
  });

  it('add forwards the activity definition (heal maps to healing)', async () => {
    const { tool, calls } = makeTool({
      success: true,
      action: 'add',
      type: 'heal',
      activityId: 'NEW',
      item: { id: 'i1', name: 'Lay on Hands', type: 'feat' },
    });
    const res = await tool.handleManageActivity({
      action: 'add',
      actorIdentifier: 'Paladin',
      itemIdentifier: 'Lay on Hands',
      type: 'heal',
      name: 'Heal',
      healAmount: { number: 2, denomination: 8, type: 'healing' },
    });
    const call = calls.find(([n]) => n === 'manageActivity');
    expect(call?.[1].action).toBe('add');
    expect(call?.[1].activity.type).toBe('heal');
    expect(call?.[1].activity.healing).toEqual({ number: 2, denomination: 8, type: 'healing' });
    expect(res.message).toContain('heal');
  });

  it('add a utility activity (Multiattack)', async () => {
    const { tool, calls } = makeTool({
      success: true,
      action: 'add',
      type: 'utility',
      activityId: 'MA',
      item: { id: 'i2', name: 'Multiattack', type: 'feat' },
    });
    await tool.handleManageActivity({
      action: 'add',
      actorIdentifier: 'Devil',
      itemIdentifier: 'Multiattack',
      type: 'utility',
      name: 'Multiattack',
    });
    const call = calls.find(([n]) => n === 'manageActivity');
    expect(call?.[1].activity.type).toBe('utility');
    expect(call?.[1].activity.name).toBe('Multiattack');
  });

  it('edit forwards a relative patch', async () => {
    const { tool, calls } = makeTool({
      success: true,
      action: 'edit',
      activityId: 'A1',
      editedKeys: ['system.activities.A1.attack.bonus'],
      item: { id: 'i1', name: 'Claws', type: 'weapon' },
    });
    await tool.handleManageActivity({
      action: 'edit',
      actorIdentifier: 'Devil',
      itemIdentifier: 'Claws',
      activityId: 'A1',
      patch: { 'attack.bonus': '3' },
    });
    const call = calls.find(([n]) => n === 'manageActivity');
    expect(call?.[1].patch).toEqual({ 'attack.bonus': '3' });
  });

  it('requires type for add and activityId for edit/remove', async () => {
    const { tool } = makeTool();
    await expect(tool.handleManageActivity({ action: 'add', itemIdentifier: 'X' })).rejects.toThrow(
      /requires `type`/
    );
    await expect(
      tool.handleManageActivity({ action: 'edit', itemIdentifier: 'X', patch: { a: 1 } })
    ).rejects.toThrow(/requires `activityId`/);
    await expect(
      tool.handleManageActivity({ action: 'remove', itemIdentifier: 'X' })
    ).rejects.toThrow(/requires `activityId`/);
  });

  it('requires per-type mechanics (save needs ability+DC, heal needs amount, damage needs parts)', async () => {
    const { tool } = makeTool();
    // save without saveAbility/saveDC would write a malformed save.ability:[undefined]
    await expect(
      tool.handleManageActivity({ action: 'add', itemIdentifier: 'X', type: 'save' })
    ).rejects.toThrow(/"save" requires saveAbility and saveDC/);
    await expect(
      tool.handleManageActivity({ action: 'add', itemIdentifier: 'X', type: 'heal' })
    ).rejects.toThrow(/"heal" requires healAmount/);
    await expect(
      tool.handleManageActivity({ action: 'add', itemIdentifier: 'X', type: 'damage' })
    ).rejects.toThrow(/"damage" requires at least one damageParts/);
    // utility needs nothing beyond type
    const { tool: tool2, calls } = makeTool({
      success: true,
      action: 'add',
      type: 'utility',
      activityId: 'U',
      item: { id: 'i', name: 'X', type: 'feat' },
    });
    await tool2.handleManageActivity({
      action: 'add',
      itemIdentifier: 'X',
      type: 'utility',
      name: 'Multiattack',
    });
    expect(calls.some(([n]) => n === 'manageActivity')).toBe(true);
  });

  it('add cast forwards spellUuid + castLevel->level + charges + saveDC', async () => {
    const { tool, calls } = makeTool({
      success: true,
      action: 'add',
      type: 'cast',
      activityId: 'C1',
      spell: 'Compendium.dnd-players-handbook.spells.Item.phbsplFireball00',
      item: { id: 'w', name: 'Wand of Fireballs', type: 'equipment' },
    });
    const res = await tool.handleManageActivity({
      action: 'add',
      itemIdentifier: 'Wand of Fireballs',
      type: 'cast',
      spellUuid: 'Compendium.dnd-players-handbook.spells.Item.phbsplFireball00',
      castLevel: 3,
      charges: 1,
      saveDC: 15,
    });
    const call = calls.find(([n]) => n === 'manageActivity');
    expect(call?.[1].activity.type).toBe('cast');
    expect(call?.[1].activity.spellUuid).toBe(
      'Compendium.dnd-players-handbook.spells.Item.phbsplFireball00'
    );
    // the tool maps the friendly `castLevel` param onto the page builder's `level`
    expect(call?.[1].activity.level).toBe(3);
    expect(call?.[1].activity.charges).toBe(1);
    expect(call?.[1].activity.saveDC).toBe(15);
    expect(res.message).toContain('linking spell');
  });

  it('cast requires spellUuid, and refuses both saveDC and attackBonus', async () => {
    const { tool } = makeTool();
    await expect(
      tool.handleManageActivity({ action: 'add', itemIdentifier: 'X', type: 'cast' })
    ).rejects.toThrow(/"cast" requires `spellUuid`/);
    await expect(
      tool.handleManageActivity({
        action: 'add',
        itemIdentifier: 'X',
        type: 'cast',
        spellUuid: 'Compendium.dnd-players-handbook.spells.Item.phbsplFireball00',
        saveDC: 15,
        attackBonus: 7,
      })
    ).rejects.toThrow(/saveDC OR attackBonus/);
  });
});

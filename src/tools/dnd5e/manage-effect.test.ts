/**
 * Unit tests for manage-effect: validation + forwarding + response shaping. The bridge seam is
 * mocked; live create/edit/delete/list against real docs is covered by the acceptance script.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DnD5eManageEffectTool } from './manage-effect.js';
import { makeFoundry, makeLogger } from '../test-helpers.js';
import { clearSystemCache } from '../../utils/system-detection.js';

// handleManageEffect now probes the system via assertDnd5e (getWorldInfo, module-cached), so the
// fake bridge answers that probe with the dnd5e marker and the cache is cleared before each test.
beforeEach(() => clearSystemCache());

function makeTool(response: any = {}) {
  const { foundry, calls } = makeFoundry((name: string) =>
    name === 'getWorldInfo' ? { system: 'dnd5e' } : response
  );
  const tool = new DnD5eManageEffectTool({ foundry, logger: makeLogger() });
  return { tool, calls };
}

describe('manage-effect tool', () => {
  it('advertises manage-effect with a generated inputSchema', () => {
    const { tool } = makeTool();
    const def = tool.getToolDefinitions()[0];
    expect(def.name).toBe('manage-effect');
    expect((def.inputSchema as any).required).toContain('action');
  });

  it('create forwards the effect (changes default type "add")', async () => {
    const { tool, calls } = makeTool({
      success: true,
      action: 'create',
      effectId: 'E1',
      name: '+1 AC',
      actor: { id: 'a1', name: 'Devil' },
    });
    const res = await tool.handleManageEffect({
      action: 'create',
      actorIdentifier: 'Devil',
      name: '+1 AC',
      changes: [{ key: 'system.attributes.ac.bonus', value: '1' }],
    });
    const call = calls.find(([n]) => n === 'manageEffect');
    expect(call?.[1].action).toBe('create');
    expect(call?.[1].effect.changes[0]).toMatchObject({
      key: 'system.attributes.ac.bonus',
      value: '1',
      type: 'add',
    });
    expect(res.message).toContain('+1 AC');
  });

  it('targets an embedded item when both ids are given', async () => {
    const { tool, calls } = makeTool({
      success: true,
      action: 'create',
      effectId: 'E2',
      name: 'Glow',
      actor: { id: 'a1', name: 'Hero' },
      item: { id: 'i1', name: 'Torch', type: 'equipment' },
    });
    await tool.handleManageEffect({
      action: 'create',
      actorIdentifier: 'Hero',
      itemIdentifier: 'Torch',
      name: 'Glow',
      changes: [{ key: 'system.attributes.ac.bonus', value: '0' }],
    });
    const call = calls.find(([n]) => n === 'manageEffect');
    expect(call?.[1].actorIdentifier).toBe('Hero');
    expect(call?.[1].itemIdentifier).toBe('Torch');
  });

  it('requires name + changes for create, effectId for edit/delete, and a target', async () => {
    const { tool } = makeTool();
    await expect(
      tool.handleManageEffect({ action: 'create', actorIdentifier: 'X', name: 'Y' })
    ).rejects.toThrow(/requires `name` and at least one/);
    await expect(tool.handleManageEffect({ action: 'edit', actorIdentifier: 'X' })).rejects.toThrow(
      /requires `effectId`/
    );
    await expect(
      tool.handleManageEffect({ action: 'delete', actorIdentifier: 'X' })
    ).rejects.toThrow(/requires `effectId`/);
    await expect(tool.handleManageEffect({ action: 'list' })).rejects.toThrow(
      /actorIdentifier and\/or itemIdentifier/
    );
  });
});

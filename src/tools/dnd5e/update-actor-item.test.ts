/**
 * Unit tests for update-actor-item: validation + forwarding + response shaping. The bridge seam is
 * mocked; the dot-path patch / deletePaths -> "-=" transform is covered live by the acceptance script.
 */

import { describe, it, expect } from 'vitest';
import { DnD5eUpdateActorItemTool } from './update-actor-item.js';
import { makeFoundry, makeLogger } from '../test-helpers.js';

function makeTool(response: any = {}) {
  const { foundry, calls } = makeFoundry(() => response);
  const tool = new DnD5eUpdateActorItemTool({ foundry, logger: makeLogger() });
  return { tool, calls };
}

describe('update-actor-item tool', () => {
  it('advertises update-actor-item with a generated inputSchema', () => {
    const { tool } = makeTool();
    const def = tool.getToolDefinitions()[0];
    expect(def.name).toBe('update-actor-item');
    const req = (def.inputSchema as any).required;
    expect(req).toContain('actorIdentifier');
    expect(req).toContain('itemIdentifier');
  });

  it('forwards patch and deletePaths to the bridge', async () => {
    const { tool, calls } = makeTool({
      success: true,
      actor: { id: 'a1', name: 'Devil' },
      item: { id: 'i1', name: 'Claws', type: 'weapon' },
      appliedKeys: ['system.damage.base.number', 'system.activities.-=old'],
    });
    const res = await tool.handleUpdateActorItem({
      actorIdentifier: 'Devil',
      itemIdentifier: 'Claws',
      patch: { 'system.damage.base.number': 3 },
      deletePaths: ['system.activities.old'],
    });
    const call = calls.find(([n]) => n === 'updateActorItem');
    expect(call?.[1].patch).toEqual({ 'system.damage.base.number': 3 });
    expect(call?.[1].deletePaths).toEqual(['system.activities.old']);
    expect(res.success).toBe(true);
    expect(res.message).toContain('Claws');
  });

  it('surfaces a bad-img (404) warning from the page layer', async () => {
    const { tool } = makeTool({
      success: true,
      actor: { id: 'a1', name: 'Devil' },
      item: { id: 'i1', name: 'Claws', type: 'weapon' },
      appliedKeys: ['img'],
      warnings: [
        'Supplied img "x/nope.webp" was not found on the server — substituted a real icon.',
      ],
    });
    const res = await tool.handleUpdateActorItem({
      actorIdentifier: 'Devil',
      itemIdentifier: 'Claws',
      img: 'x/nope.webp',
    });
    expect(res.warnings).toHaveLength(1);
    expect(res.message).toContain('not found on the server');
  });

  it('rejects a call with nothing to change', async () => {
    const { tool } = makeTool();
    await expect(
      tool.handleUpdateActorItem({ actorIdentifier: 'Devil', itemIdentifier: 'Claws' })
    ).rejects.toThrow();
  });

  it('rejects a missing itemIdentifier', async () => {
    const { tool } = makeTool();
    await expect(
      tool.handleUpdateActorItem({ actorIdentifier: 'Devil', patch: { 'system.x': 1 } })
    ).rejects.toThrow();
  });
});

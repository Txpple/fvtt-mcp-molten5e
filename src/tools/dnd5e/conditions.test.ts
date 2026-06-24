/**
 * Unit tests for apply-condition: validation + forwarding + response shaping. The bridge seam is
 * mocked; live toggleStatusEffect / exhaustion behavior is covered by the acceptance script.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DnD5eConditionTool } from './conditions.js';
import { makeFoundry, makeLogger } from '../test-helpers.js';
import { clearSystemCache } from '../../utils/system-detection.js';

beforeEach(() => clearSystemCache());

function makeTool(response: any = {}) {
  const { foundry, calls } = makeFoundry((name: string) =>
    name === 'getWorldInfo' ? { system: 'dnd5e' } : response
  );
  const tool = new DnD5eConditionTool({ foundry, logger: makeLogger() });
  return { tool, calls };
}

describe('apply-condition tool', () => {
  it('advertises apply-condition with a generated inputSchema', () => {
    const { tool } = makeTool();
    const def = tool.getToolDefinitions()[0];
    expect(def.name).toBe('apply-condition');
    expect((def.inputSchema as any).required).toContain('conditions');
  });

  it('defaults active to true and forwards the conditions', async () => {
    const { tool, calls } = makeTool({
      success: true,
      actor: { id: 'a1', name: 'Goblin', type: 'npc' },
      applied: ['poisoned', 'prone'],
      removed: [],
      warnings: [],
      statuses: ['poisoned', 'prone'],
    });
    const res = await tool.handleApplyCondition({
      actorIdentifier: 'Goblin',
      conditions: ['poisoned', 'prone'],
    });
    const call = calls.find(([n]) => n === 'applyCondition');
    expect(call?.[1]).toMatchObject({ conditions: ['poisoned', 'prone'], active: true });
    expect(res.applied).toEqual(['poisoned', 'prone']);
    expect(res.message).toContain('poisoned');
  });

  it('passes exhaustionLevel through', async () => {
    const { tool, calls } = makeTool({
      success: true,
      actor: { id: 'a1', name: 'X', type: 'npc' },
      applied: ['exhaustion 4'],
      removed: [],
      warnings: [],
      statuses: ['exhaustion'],
    });
    await tool.handleApplyCondition({
      actorIdentifier: 'X',
      conditions: ['exhaustion'],
      exhaustionLevel: 4,
    });
    const call = calls.find(([n]) => n === 'applyCondition');
    expect(call?.[1].exhaustionLevel).toBe(4);
  });

  it('rejects an empty conditions list and an out-of-range exhaustion level', async () => {
    const { tool } = makeTool();
    await expect(
      tool.handleApplyCondition({ actorIdentifier: 'X', conditions: [] })
    ).rejects.toThrow();
    await expect(
      tool.handleApplyCondition({
        actorIdentifier: 'X',
        conditions: ['exhaustion'],
        exhaustionLevel: 9,
      })
    ).rejects.toThrow();
  });
});

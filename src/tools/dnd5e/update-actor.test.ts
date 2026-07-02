/**
 * Unit tests for the update-actor tool: validation + forwarding to the bridge + response shaping.
 * The bridge seam is mocked (the page-side updateActor correctness is covered by the live
 * acceptance script), so these assert the tool contract, not Foundry behavior.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DnD5eUpdateActorTool } from './update-actor.js';
import { makeFoundry, makeLogger } from '../test-helpers.js';
import { clearSystemCache } from '../../utils/system-detection.js';

// detectGameSystem caches the result module-wide, so clear it between tests and have the mock
// answer getWorldInfo with the dnd5e marker (a bare string, matching the real bridge shape).
beforeEach(() => clearSystemCache());

function makeTool(response: any = {}) {
  const { foundry, calls } = makeFoundry((name: string) =>
    name === 'getWorldInfo' ? { system: 'dnd5e' } : response
  );
  const tool = new DnD5eUpdateActorTool({ foundry, logger: makeLogger() });
  return { tool, calls };
}

describe('update-actor tool definition', () => {
  it('advertises update-actor with a generated inputSchema', () => {
    const { tool } = makeTool();
    const def = tool.getToolDefinitions()[0];
    expect(def.name).toBe('update-actor');
    expect(def.inputSchema).toBeTruthy();
    expect((def.inputSchema as any).required).toContain('actorIdentifier');
  });
});

describe('handleUpdateActor', () => {
  it('forwards parsed args to the updateActor bridge call', async () => {
    const { tool, calls } = makeTool({
      success: true,
      actor: { id: 'a1', name: 'Barbed Devil', type: 'npc' },
      applied: ['abilities', 'cr'],
      warnings: [],
    });
    const res = await tool.handleUpdateActor({
      actorIdentifier: 'Barbed Devil',
      abilities: { str: 20 },
      cr: 5,
    });
    const call = calls.find(([n]) => n === 'updateActor');
    expect(call).toBeTruthy();
    expect(call?.[1].actorIdentifier).toBe('Barbed Devil');
    expect(call?.[1].abilities).toEqual({ str: 20 });
    expect(res.success).toBe(true);
    expect(res.applied).toEqual(['abilities', 'cr']);
    expect(res.message).toContain('Barbed Devil');
  });

  it('forwards the prototype-token toggles (auto-rotate / ring)', async () => {
    const { tool, calls } = makeTool({
      success: true,
      actor: { id: 'a1', name: 'Osric the Bartender', type: 'npc' },
      applied: ['tokenAutoRotate', 'tokenRing'],
      warnings: [],
    });
    await tool.handleUpdateActor({
      actorIdentifier: 'Osric the Bartender',
      tokenAutoRotate: true,
      tokenRing: false,
    });
    const call = calls.find(([n]) => n === 'updateActor');
    expect(call?.[1].tokenAutoRotate).toBe(true);
    expect(call?.[1].tokenRing).toBe(false);
  });

  it('rejects a non-boolean token toggle', async () => {
    const { tool } = makeTool({});
    await expect(
      tool.handleUpdateActor({ actorIdentifier: 'X', tokenAutoRotate: 'yes' })
    ).rejects.toThrow();
  });

  it('applies the default replace mode to Set fields', async () => {
    const { tool, calls } = makeTool({
      success: true,
      actor: { id: 'a1', name: 'X', type: 'npc' },
      applied: ['damageImmunities'],
      warnings: [],
    });
    await tool.handleUpdateActor({
      actorIdentifier: 'X',
      damageImmunities: { values: ['fire', 'poison'] },
    });
    const call = calls.find(([n]) => n === 'updateActor');
    expect(call?.[1].damageImmunities).toEqual({ mode: 'replace', values: ['fire', 'poison'] });
  });

  it('forwards a currency group with its default mode', async () => {
    const { tool, calls } = makeTool({
      success: true,
      actor: { id: 'a1', name: 'Knight', type: 'npc' },
      applied: ['currency'],
      warnings: [],
    });
    await tool.handleUpdateActor({
      actorIdentifier: 'Knight',
      currency: { gp: 30, sp: 5 },
    });
    const call = calls.find(([n]) => n === 'updateActor');
    expect(call?.[1].currency).toEqual({ mode: 'set', gp: 30, sp: 5 });
  });

  it('forwards currency mode add for loot adjustments', async () => {
    const { tool, calls } = makeTool({
      success: true,
      actor: { id: 'a1', name: 'Knight', type: 'npc' },
      applied: ['currency'],
      warnings: [],
    });
    await tool.handleUpdateActor({
      actorIdentifier: 'Knight',
      currency: { mode: 'add', gp: -10 },
    });
    const call = calls.find(([n]) => n === 'updateActor');
    expect(call?.[1].currency).toEqual({ mode: 'add', gp: -10 });
  });

  it('rejects a non-integer coin amount', async () => {
    const { tool } = makeTool();
    await expect(
      tool.handleUpdateActor({ actorIdentifier: 'X', currency: { gp: 1.5 } })
    ).rejects.toThrow();
  });

  it('surfaces bridge warnings in the response', async () => {
    const { tool } = makeTool({
      success: true,
      actor: { id: 'a1', name: 'Hero', type: 'character' },
      applied: ['abilities'],
      warnings: ['"cr" is an NPC-only field — skipped on character "Hero"'],
    });
    const res = await tool.handleUpdateActor({
      actorIdentifier: 'Hero',
      abilities: { str: 18 },
      cr: 5,
    });
    expect(res.warnings).toHaveLength(1);
    expect(res.message).toContain('NPC-only');
  });

  it('surfaces a bad-img (404) warning from the page layer', async () => {
    const { tool } = makeTool({
      success: true,
      actor: { id: 'a1', name: 'Goblin', type: 'npc' },
      applied: ['img'],
      warnings: [
        'Supplied img "x/nope.webp" was not found on the server — substituted a real icon.',
      ],
    });
    const res = await tool.handleUpdateActor({
      actorIdentifier: 'Goblin',
      img: 'x/nope.webp',
    });
    expect(res.warnings).toHaveLength(1);
    expect(res.message).toContain('not found on the server');
  });

  it('rejects a missing actorIdentifier', async () => {
    const { tool } = makeTool();
    await expect(tool.handleUpdateActor({ cr: 5 })).rejects.toThrow();
  });

  it('rejects an out-of-range ability score', async () => {
    const { tool } = makeTool();
    await expect(
      tool.handleUpdateActor({ actorIdentifier: 'X', abilities: { str: 99 } })
    ).rejects.toThrow();
  });
});

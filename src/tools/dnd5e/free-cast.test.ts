/**
 * Unit tests for the add-free-cast tool: schema validation, forwarding to the addFreeCast bridge
 * call, and response shaping. The page-side planners (buildFreeCastActivityPlan /
 * buildRepertoireCleanup) are covered by src/page/dnd5e/free-cast.test.ts + the live verify script.
 */

import { describe, it, expect } from 'vitest';
import { DnD5eFreeCastTool } from './free-cast.js';
import { makeFoundry, makeLogger } from '../test-helpers.js';

function makeTool(response: any = {}) {
  const { foundry, calls } = makeFoundry(() => ({
    success: true,
    actor: { id: 'a1', name: 'Gren' },
    feature: { id: 'f1', name: 'Magic Initiate' },
    spell: {
      uuid: 'Compendium.dnd-players-handbook.spells.Item.phbsplBless00000',
      name: 'Bless',
      level: 1,
    },
    repertoire: { id: 'i1', name: 'Bless', imported: false, migrated: true },
    activity: {
      id: 'castActivity0000',
      name: 'Bless - Magic Initiate',
      reused: false,
      uses: { max: '1', recovery: [{ period: 'lr', type: 'recoverAll' }] },
      activationType: 'action',
    },
    additionalSpells: {
      cachedId: 'cached0000000000',
      name: 'Bless - Magic Initiate',
      mintedBy: 'system',
      removedDuplicates: 2,
    },
    warnings: [],
    ...response,
  }));
  const tool = new DnD5eFreeCastTool({ foundry, logger: makeLogger() });
  return { tool, calls };
}

describe('add-free-cast tool definition', () => {
  it('advertises add-free-cast requiring actor, spell, and grantedBy', () => {
    const { tool } = makeTool();
    const def = tool.getToolDefinitions()[0];
    expect(def.name).toBe('add-free-cast');
    expect((def.inputSchema as any).required).toEqual([
      'actorIdentifier',
      'spellIdentifier',
      'grantedBy',
    ]);
    // The native shape: repertoire + Additional Spells, never a tracker feat / on-spell forward.
    expect(def.description).toContain('Additional Spells');
    expect(def.description).toContain('ALWAYS-PREPARED');
  });
});

describe('handleAddFreeCast', () => {
  it('forwards the parsed args to the addFreeCast bridge call', async () => {
    const { tool, calls } = makeTool();
    await tool.handleAddFreeCast({
      actorIdentifier: 'Gren',
      spellIdentifier: 'Bless',
      grantedBy: 'Magic Initiate',
      uses: 1,
      recoveryPeriod: 'lr',
    });
    const call = calls.find(([n]) => n === 'addFreeCast');
    expect(call?.[1]).toMatchObject({
      actorIdentifier: 'Gren',
      spellIdentifier: 'Bless',
      grantedBy: 'Magic Initiate',
      uses: 1,
      recoveryPeriod: 'lr',
    });
  });

  it('shapes the success response: feature, repertoire state, and the Additional Spells entry', async () => {
    const { tool } = makeTool();
    const res = await tool.handleAddFreeCast({
      actorIdentifier: 'Gren',
      spellIdentifier: 'Bless',
      grantedBy: 'Magic Initiate',
    });
    expect(res.success).toBe(true);
    expect(res.summary).toContain('Bless - Magic Initiate');
    expect(res.summary).toContain('on feature "Magic Initiate"');
    expect(res.message).toContain('1 per lr');
    expect(res.message).toContain('old free-cast shape migrated off');
    expect(res.message).toContain('Additional Spells entry');
    expect(res.additionalSpells?.cachedId).toBe('cached0000000000');
  });

  it('says "Updated" and surfaces warnings on an idempotent re-run', async () => {
    const { tool } = makeTool({
      activity: {
        id: 'castActivity0000',
        name: 'Bless - Magic Initiate',
        reused: true,
        uses: { max: '1', recovery: [{ period: 'lr', type: 'recoverAll' }] },
        activationType: 'action',
      },
      warnings: [
        '"Magic Initiate" already had a free-cast activity for this spell — rebuilt it in place',
      ],
    });
    const res = await tool.handleAddFreeCast({
      actorIdentifier: 'Gren',
      spellIdentifier: 'Bless',
      grantedBy: 'Magic Initiate',
    });
    expect(res.summary).toContain('Updated');
    expect(res.warnings?.[0]).toContain('rebuilt it in place');
  });

  it('accepts a formula uses string', async () => {
    const { tool, calls } = makeTool();
    await tool.handleAddFreeCast({
      actorIdentifier: 'Jetten',
      spellIdentifier: "Hunter's Mark",
      grantedBy: 'Favored Enemy',
      uses: '@scale.ranger.favored-enemy',
    });
    const call = calls.find(([n]) => n === 'addFreeCast');
    expect(call?.[1].uses).toBe('@scale.ranger.favored-enemy');
  });

  it('rejects a missing grantedBy and a bad recoveryPeriod', async () => {
    const { tool } = makeTool();
    await expect(
      tool.handleAddFreeCast({ actorIdentifier: 'Gren', spellIdentifier: 'Bless' })
    ).rejects.toThrow();
    await expect(
      tool.handleAddFreeCast({
        actorIdentifier: 'Gren',
        spellIdentifier: 'Bless',
        grantedBy: 'Magic Initiate',
        recoveryPeriod: 'fortnight',
      })
    ).rejects.toThrow();
  });
});

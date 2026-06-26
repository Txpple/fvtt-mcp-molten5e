/**
 * Unit tests for the PC tools (create-pc / inspect-pc-advancement): schema validation, normalized
 * forwarding to the createPcActor / inspectAdvancementChoices bridge calls, and response shaping
 * (success, the needsChoices dry-run, and unresolved-@scale surfacing). The page-side leveling
 * engine's correctness is covered by advancement.test.ts + scripts/verify-pc-build.mjs.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DnD5ePcTools } from './pc.js';
import { makeFoundry, makeLogger } from '../test-helpers.js';
import { clearSystemCache } from '../../utils/system-detection.js';

beforeEach(() => clearSystemCache());

function makeTool(respond: (name: string) => any) {
  const { foundry, calls } = makeFoundry((name: string) =>
    name === 'getWorldInfo' ? { system: 'dnd5e' } : respond(name)
  );
  const tool = new DnD5ePcTools({ foundry, logger: makeLogger() });
  return { tool, calls };
}

describe('PC tool definitions', () => {
  it('advertises create-pc, inspect-pc-advancement, and level-up-pc', () => {
    const { tool } = makeTool(() => ({}));
    const defs = tool.getToolDefinitions();
    const names = defs.map(d => d.name);
    expect(names).toEqual(['create-pc', 'inspect-pc-advancement', 'level-up-pc']);
    const createPc = defs.find(d => d.name === 'create-pc') as any;
    expect(createPc.inputSchema.required).toEqual(['name', 'className']);
    // choices is the nested record map (no zod tuple)
    expect(Object.keys(createPc.inputSchema.properties)).toContain('choices');
    const levelUp = defs.find(d => d.name === 'level-up-pc') as any;
    expect(levelUp.inputSchema.required).toEqual(['actorIdentifier', 'className']);
  });
});

describe('handleCreatePc', () => {
  it('forwards the parsed plan (with defaults) to createPcActor', async () => {
    const { tool, calls } = makeTool(name =>
      name === 'createPcActor'
        ? {
            success: true,
            actor: { id: 'p1', name: 'Aria', className: 'Wizard', level: 1, hp: 8 },
            applied: [],
            warnings: [],
          }
        : {}
    );
    await tool.handleCreatePc({
      name: 'Aria',
      className: 'Wizard',
      abilities: { str: 8, dex: 14, con: 14, int: 15, wis: 12, cha: 10 },
    });
    const call = calls.find(([n]) => n === 'createPcActor');
    expect(call?.[1].name).toBe('Aria');
    expect(call?.[1].className).toBe('Wizard');
    expect(call?.[1].level).toBe(1); // z.literal(1).default(1)
    expect(call?.[1].sourceRules).toBe('2024');
    expect(call?.[1].acceptDefaults).toBe(false);
  });

  it('shapes a success response with the actor summary', async () => {
    const { tool } = makeTool(name =>
      name === 'createPcActor'
        ? {
            success: true,
            actor: {
              id: 'p1',
              name: 'Borin',
              className: 'Fighter',
              species: 'Dragonborn',
              background: 'Soldier',
              level: 1,
              hp: 12,
              folder: 'f1',
            },
            applied: [
              {
                source: 'class',
                level: 1,
                type: 'Trait',
                title: 'Skill Proficiencies',
                result: 'applied (+choice)',
              },
            ],
            warnings: [],
          }
        : {}
    );
    const res = await tool.handleCreatePc({ name: 'Borin', className: 'Fighter' });
    expect(res.success).toBe(true);
    expect(res.actor.id).toBe('p1');
    expect(res.message).toContain('Borin');
    expect(res.message).toContain('Fighter');
    expect(res.message).toContain('HP:');
  });

  it('forwards a multiclass[] plan and renders the class breakdown', async () => {
    const { tool, calls } = makeTool(name =>
      name === 'createPcActor'
        ? {
            success: true,
            actor: {
              id: 'p1',
              name: 'Vesh',
              className: 'Fighter',
              level: 2,
              hp: 14,
              classes: [
                { name: 'Fighter', levels: 1 },
                { name: 'Wizard', levels: 1 },
              ],
            },
            applied: [],
            warnings: [],
          }
        : {}
    );
    const res = await tool.handleCreatePc({
      name: 'Vesh',
      className: 'Fighter',
      multiclass: [{ className: 'Wizard', levels: 1 }],
    });
    const call = calls.find(([n]) => n === 'createPcActor');
    expect(call?.[1].multiclass).toEqual([{ className: 'Wizard', levels: 1 }]);
    expect(res.success).toBe(true);
    expect(res.message).toContain('Fighter 1 / Wizard 1');
  });

  it('rejects a multiclass entry with an empty className or non-positive levels', async () => {
    const { tool } = makeTool(() => ({}));
    await expect(
      tool.handleCreatePc({
        name: 'X',
        className: 'Fighter',
        multiclass: [{ className: '', levels: 1 }],
      })
    ).rejects.toThrow();
    await expect(
      tool.handleCreatePc({
        name: 'X',
        className: 'Fighter',
        multiclass: [{ className: 'Wizard', levels: 0 }],
      })
    ).rejects.toThrow();
  });

  it('shapes a needsChoices dry-run response (success:false, nothing created)', async () => {
    const { tool } = makeTool(name =>
      name === 'createPcActor'
        ? {
            success: false,
            needsChoices: [
              {
                id: 'adv1',
                source: 'class',
                level: 1,
                type: 'Trait',
                title: 'Skill Proficiencies',
                dataKey: 'chosen',
                count: 2,
                options: [{ value: 'skills:acr' }],
              },
            ],
            warnings: ['fill the choices map'],
          }
        : {}
    );
    const res = await tool.handleCreatePc({ name: 'Borin', className: 'Fighter' });
    expect(res.success).toBe(false);
    expect(res.needsChoices).toHaveLength(1);
    expect(res.message).toContain('Skill Proficiencies');
    expect(res.message).toContain('NOTHING was created');
  });

  it('surfaces unresolved @scale in the success message', async () => {
    const { tool } = makeTool(name =>
      name === 'createPcActor'
        ? {
            success: true,
            actor: { id: 'p1', name: 'X', className: 'Fighter', level: 1, hp: 12 },
            applied: [],
            unresolvedScale: [
              {
                itemId: 'i1',
                itemName: 'Mystery Feat',
                path: 'system.x',
                formula: '@scale.foo.bar',
              },
            ],
            warnings: [],
          }
        : {}
    );
    const res = await tool.handleCreatePc({ name: 'X', className: 'Fighter' });
    expect(res.unresolvedScale).toHaveLength(1);
    expect(res.message).toContain('Unresolved @scale');
    expect(res.message).toContain('@scale.foo.bar');
  });

  it('rejects a plan missing the required name / className', async () => {
    const { tool } = makeTool(() => ({}));
    await expect(tool.handleCreatePc({ className: 'Fighter' })).rejects.toThrow();
    await expect(tool.handleCreatePc({ name: 'Aria' })).rejects.toThrow();
  });
});

describe('handleInspectPcAdvancement', () => {
  it('forwards to inspectAdvancementChoices and shapes the read model', async () => {
    const { tool, calls } = makeTool(name =>
      name === 'inspectAdvancementChoices'
        ? {
            class: { name: 'Fighter', identifier: 'fighter' },
            level: 1,
            choices: [
              {
                id: 'a1',
                source: 'class',
                level: 1,
                type: 'ItemChoice',
                title: 'Fighting Style',
                dataKey: 'selected',
                count: 1,
                options: [{ value: 'u1', label: 'Archery' }],
              },
            ],
            spellcasting: null,
          }
        : {}
    );
    const res = await tool.handleInspectPcAdvancement({ className: 'Fighter', level: 1 });
    const call = calls.find(([n]) => n === 'inspectAdvancementChoices');
    expect(call?.[1].className).toBe('Fighter');
    expect(res.choices).toHaveLength(1);
    expect(res.message).toContain('Fighting Style');
    expect(res.message).toContain('Archery');
  });

  it('rejects neither / both of className + classUuid (exactly-one)', async () => {
    const { tool } = makeTool(() => ({}));
    await expect(tool.handleInspectPcAdvancement({})).rejects.toThrow();
    await expect(
      tool.handleInspectPcAdvancement({ className: 'Fighter', classUuid: 'Compendium.x.Item.y' })
    ).rejects.toThrow();
  });
});

describe('handleLevelUpPc', () => {
  it('forwards to levelUpPc and shapes a success message with the class breakdown', async () => {
    const { tool, calls } = makeTool(name =>
      name === 'levelUpPc'
        ? {
            success: true,
            actor: {
              id: 'p1',
              name: 'Borin',
              className: 'Wizard',
              level: 6,
              classLevel: 2,
              hp: 44,
              classes: [
                { name: 'Fighter', levels: 4 },
                { name: 'Wizard', levels: 2 },
              ],
            },
            applied: [
              {
                source: 'class',
                level: 2,
                type: 'ItemGrant',
                title: 'Class Features',
                result: 'applied',
              },
            ],
            warnings: [],
          }
        : {}
    );
    const res = await tool.handleLevelUpPc({ actorIdentifier: 'Borin', className: 'Wizard' });
    const call = calls.find(([n]) => n === 'levelUpPc');
    expect(call?.[1].actorIdentifier).toBe('Borin');
    expect(call?.[1].hpMode).toBe('avg'); // default
    expect(res.success).toBe(true);
    expect(res.message).toContain('Fighter 4 / Wizard 2');
    expect(res.message).toContain('character level 6');
  });

  it('shapes a needsChoices response (e.g. subclass at level 3) without changing the PC', async () => {
    const { tool } = makeTool(name =>
      name === 'levelUpPc'
        ? {
            success: false,
            needsChoices: [
              {
                id: 'sub',
                source: 'class',
                level: 3,
                type: 'Subclass',
                title: 'Subclass',
                dataKey: 'uuid',
                count: 1,
                options: [{ value: 'u1', label: 'Champion' }],
              },
            ],
            warnings: ['pick a subclass'],
          }
        : {}
    );
    const res = await tool.handleLevelUpPc({ actorIdentifier: 'Borin', className: 'Fighter' });
    expect(res.success).toBe(false);
    expect(res.needsChoices).toHaveLength(1);
    expect(res.message).toContain('was NOT changed');
    expect(res.message).toContain('Champion');
  });

  it('rejects a call missing actorIdentifier / className', async () => {
    const { tool } = makeTool(() => ({}));
    await expect(tool.handleLevelUpPc({ className: 'Wizard' })).rejects.toThrow();
    await expect(tool.handleLevelUpPc({ actorIdentifier: 'Borin' })).rejects.toThrow();
  });
});

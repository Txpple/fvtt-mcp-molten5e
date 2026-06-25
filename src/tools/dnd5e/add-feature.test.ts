/**
 * Unit tests for DnD5eAddFeatureTool (add-feature).
 *
 * This is a discriminated multi-mode tool: handleAddFeature parses the
 * `featureType` and dispatches to a private per-mode handler. Each mode has
 * its own zod schema, forwards to a distinct bridge method, and builds its own
 * message string. The tests therefore exercise, per mode:
 *   (a) a valid call forwards the right bridge method + payload and produces
 *       the expected message, and
 *   (b) zod rejects bad input (missing required, empty .min(1) strings/arrays,
 *       invalid enums, mode-specific superRefine rules).
 *
 * Every handler calls detectGameSystem() (calls `getWorldInfo`, caches
 * module-globally), so the fake foundry answers that probe with
 * `{ system: 'dnd5e' }` and the cache is cleared before each test.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DnD5eAddFeatureTool } from './add-feature.js';
import { makeLogger, makeFoundry } from '../test-helpers.js';
import { clearSystemCache } from '../../utils/system-detection.js';

/**
 * Build a tool whose foundry answers the world-info probe with dnd5e and every
 * bridge call with `bridgeResult`.
 */
function build(bridgeResult: any = {}) {
  const { foundry, calls } = makeFoundry((method: string) =>
    method === 'getWorldInfo' ? { system: 'dnd5e' } : bridgeResult
  );
  const tools = new DnD5eAddFeatureTool({ foundry, logger: makeLogger() });
  return { tools, calls, foundry };
}

/** Standard {actor,item} result the feature formatters read. */
function itemResult(extra: Record<string, any> = {}) {
  return {
    actor: { id: 'a1', name: 'Red Dragon' },
    item: { id: 'i1', name: 'Bite' },
    ...extra,
  };
}

const fireDamage = [{ number: 2, denomination: 6, type: 'fire' }];

function bridgeMethodFrom(calls: Array<[string, any]>): [string, any] {
  const call = calls.find(c => c[0] !== 'getWorldInfo');
  if (!call) throw new Error('no bridge call recorded');
  return call;
}

beforeEach(() => {
  clearSystemCache();
});

// ---------------------------------------------------------------------------
// getToolDefinitions
// ---------------------------------------------------------------------------

describe('DnD5eAddFeatureTool.getToolDefinitions', () => {
  it('exposes the single add-feature tool with an object schema', () => {
    const { tools } = build();
    const defs = tools.getToolDefinitions();
    expect(defs.map(d => d.name)).toEqual(['add-feature']);
    expect(defs[0].inputSchema.type).toBe('object');
    expect(defs[0].inputSchema.required).toEqual(['featureType', 'actorIdentifier']);
  });
});

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

describe('handleAddFeature dispatcher', () => {
  it('rejects an unknown featureType', async () => {
    const { tools } = build();
    await expect(
      tools.handleAddFeature({ featureType: 'bogus', actorIdentifier: 'X' })
    ).rejects.toThrow();
  });

  it('rejects a missing featureType', async () => {
    const { tools } = build();
    await expect(tools.handleAddFeature({ actorIdentifier: 'X' })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// passive
// ---------------------------------------------------------------------------

describe('handleAddFeature — passive', () => {
  it('forwards addPassiveFeatureToActor and formats the message', async () => {
    const { tools, calls } = build(itemResult({ item: { id: 'i1', name: 'Magic Resistance' } }));
    const out = await tools.handleAddFeature({
      featureType: 'passive',
      actorIdentifier: 'Red Dragon',
      featureName: 'Magic Resistance',
      sourceBook: "MM'14",
    });

    const [method, payload] = bridgeMethodFrom(calls);
    expect(method).toBe('addPassiveFeatureToActor');
    expect(payload).toMatchObject({
      actorIdentifier: 'Red Dragon',
      featureName: 'Magic Resistance',
    });

    expect(out.success).toBe(true);
    expect(out.summary).toBe('✅ Feature "Magic Resistance" added to "Red Dragon"');
    expect(out.message).toContain('**Type:** passive / descriptive (no activity)');
    expect(out.message).toContain("**Rules:** 2024 — MM'14");
  });

  it('rejects an empty featureName', async () => {
    const { tools } = build();
    await expect(
      tools.handleAddFeature({ featureType: 'passive', actorIdentifier: 'X', featureName: '' })
    ).rejects.toThrow();
  });

  it('rejects a missing actorIdentifier', async () => {
    const { tools } = build();
    await expect(
      tools.handleAddFeature({ featureType: 'passive', featureName: 'Y' })
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// save
// ---------------------------------------------------------------------------

describe('handleAddFeature — save', () => {
  it('forwards addSaveFeatureToActor and formats damage + save + area', async () => {
    const { tools, calls } = build(itemResult({ item: { id: 'i1', name: 'Fire Breath' } }));
    const out = await tools.handleAddFeature({
      featureType: 'save',
      actorIdentifier: 'Red Dragon',
      featureName: 'Fire Breath',
      saveAbility: 'dex',
      saveDC: 18,
      damageParts: [{ number: 6, denomination: 6, type: 'fire' }],
      areaType: 'cone',
      areaSize: 30,
    });

    const [method] = bridgeMethodFrom(calls);
    expect(method).toBe('addSaveFeatureToActor');
    expect(out.summary).toBe('✅ Feature "Fire Breath" added to "Red Dragon"');
    expect(out.message).toContain('**Save:** DC 18 DEX save — half damage on save');
    expect(out.message).toContain('**Damage:** 6d6 fire, 30ft cone');
  });

  it('rejects a missing saveAbility', async () => {
    const { tools } = build();
    await expect(
      tools.handleAddFeature({
        featureType: 'save',
        actorIdentifier: 'X',
        featureName: 'Y',
        saveDC: 12,
        damageParts: fireDamage,
      })
    ).rejects.toThrow();
  });

  it('rejects an empty damageParts array', async () => {
    const { tools } = build();
    await expect(
      tools.handleAddFeature({
        featureType: 'save',
        actorIdentifier: 'X',
        featureName: 'Y',
        saveAbility: 'con',
        saveDC: 12,
        damageParts: [],
      })
    ).rejects.toThrow();
  });

  it('rejects areaType set without areaSize (superRefine)', async () => {
    const { tools } = build();
    await expect(
      tools.handleAddFeature({
        featureType: 'save',
        actorIdentifier: 'X',
        featureName: 'Y',
        saveAbility: 'con',
        saveDC: 12,
        damageParts: fireDamage,
        areaType: 'cone',
      })
    ).rejects.toThrow();
  });

  it('rejects an out-of-range saveDC', async () => {
    const { tools } = build();
    await expect(
      tools.handleAddFeature({
        featureType: 'save',
        actorIdentifier: 'X',
        featureName: 'Y',
        saveAbility: 'con',
        saveDC: 99,
        damageParts: fireDamage,
      })
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// attack
// ---------------------------------------------------------------------------

describe('handleAddFeature — attack', () => {
  it('forwards addAttackToActor with effectiveAbility and formats melee', async () => {
    const { tools, calls } = build(itemResult({ item: { id: 'i1', name: 'Claw' } }));
    const out = await tools.handleAddFeature({
      featureType: 'attack',
      actorIdentifier: 'Red Dragon',
      featureName: 'Claw',
      attackType: 'melee',
      damageParts: [{ number: 2, denomination: 6, type: 'slashing' }],
      reachFt: 10,
    });

    const [method, payload] = bridgeMethodFrom(calls);
    expect(method).toBe('addAttackToActor');
    expect(payload.effectiveAbility).toBe('str'); // melee default
    expect(out.summary).toBe('✅ Attack "Claw" added to "Red Dragon"');
    expect(out.message).toContain('**Attack:** melee — STR modifier');
    expect(out.message).toContain('**Range/Reach:** reach 10 ft.');
    expect(out.message).toContain('**Damage:** 2d6 slashing');
  });

  it('defaults effectiveAbility to dex for ranged and renders range', async () => {
    const { tools, calls } = build(itemResult({ item: { id: 'i1', name: 'Longbow' } }));
    const out = await tools.handleAddFeature({
      featureType: 'attack',
      actorIdentifier: 'Archer',
      featureName: 'Longbow',
      attackType: 'ranged',
      rangeFt: 150,
      longRangeFt: 600,
      damageParts: [{ number: 1, denomination: 8, type: 'piercing' }],
    });
    const [, payload] = bridgeMethodFrom(calls);
    expect(payload.effectiveAbility).toBe('dex');
    expect(out.message).toContain('**Range/Reach:** range 150/600 ft.');
  });

  it('surfaces a warning for a non-canonical damage type', async () => {
    const { tools } = build(itemResult({ item: { id: 'i1', name: 'Weird' } }));
    const out = await tools.handleAddFeature({
      featureType: 'attack',
      actorIdentifier: 'X',
      featureName: 'Weird',
      attackType: 'melee',
      damageParts: [{ number: 1, denomination: 6, type: 'kinetic' }],
    });
    expect(out.warnings.length).toBe(1);
    expect(out.message).toContain('Unknown damage type "kinetic"');
  });

  it('rejects ranged attack missing rangeFt (superRefine)', async () => {
    const { tools } = build();
    await expect(
      tools.handleAddFeature({
        featureType: 'attack',
        actorIdentifier: 'X',
        featureName: 'Y',
        attackType: 'ranged',
        damageParts: fireDamage,
      })
    ).rejects.toThrow();
  });

  it('rejects an invalid attackType enum', async () => {
    const { tools } = build();
    await expect(
      tools.handleAddFeature({
        featureType: 'attack',
        actorIdentifier: 'X',
        featureName: 'Y',
        attackType: 'thrown',
        damageParts: fireDamage,
      })
    ).rejects.toThrow();
  });

  it('rejects an empty damageParts array', async () => {
    const { tools } = build();
    await expect(
      tools.handleAddFeature({
        featureType: 'attack',
        actorIdentifier: 'X',
        featureName: 'Y',
        attackType: 'melee',
        damageParts: [],
      })
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// attack-with-save
// ---------------------------------------------------------------------------

describe('handleAddFeature — attack-with-save', () => {
  it('forwards addAttackWithSaveToActor and formats attack + save damage', async () => {
    const { tools, calls } = build(itemResult({ item: { id: 'i1', name: 'Stinger' } }));
    const out = await tools.handleAddFeature({
      featureType: 'attack-with-save',
      actorIdentifier: 'Wasp',
      featureName: 'Stinger',
      attackType: 'melee',
      damageParts: [{ number: 1, denomination: 6, type: 'piercing' }],
      saveAbility: 'con',
      saveDC: 13,
      saveDamageParts: [{ number: 4, denomination: 6, type: 'poison' }],
      saveOnSave: 'half',
    });

    const [method] = bridgeMethodFrom(calls);
    expect(method).toBe('addAttackWithSaveToActor');
    expect(out.summary).toBe('✅ Attack+Save "Stinger" added to "Red Dragon"');
    expect(out.message).toContain('**Attack damage:** 1d6 piercing');
    expect(out.message).toContain('**Save:** DC 13 CON — 4d6 poison (half on save)');
  });

  it('rejects a missing saveDamageParts', async () => {
    const { tools } = build();
    await expect(
      tools.handleAddFeature({
        featureType: 'attack-with-save',
        actorIdentifier: 'X',
        featureName: 'Y',
        attackType: 'melee',
        damageParts: fireDamage,
        saveAbility: 'con',
        saveDC: 13,
      })
    ).rejects.toThrow();
  });

  it('rejects an empty saveDamageParts array', async () => {
    const { tools } = build();
    await expect(
      tools.handleAddFeature({
        featureType: 'attack-with-save',
        actorIdentifier: 'X',
        featureName: 'Y',
        attackType: 'melee',
        damageParts: fireDamage,
        saveAbility: 'con',
        saveDC: 13,
        saveDamageParts: [],
      })
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// aura
// ---------------------------------------------------------------------------

describe('handleAddFeature — aura', () => {
  it('forwards addAuraToActor and formats automatic-damage area', async () => {
    const { tools, calls } = build(itemResult({ item: { id: 'i1', name: 'Fire Aura' } }));
    const out = await tools.handleAddFeature({
      featureType: 'aura',
      actorIdentifier: 'Fire Elemental',
      featureName: 'Fire Aura',
      damageParts: [{ number: 1, denomination: 10, type: 'fire' }],
      areaType: 'emanation',
      areaSize: 10,
    });

    const [method] = bridgeMethodFrom(calls);
    expect(method).toBe('addAuraToActor');
    expect(out.summary).toBe('✅ Aura "Fire Aura" added to "Red Dragon"');
    expect(out.message).toContain(
      '**Damage:** 1d10 fire (automatic — no attack roll, no saving throw)'
    );
    expect(out.message).toContain('**Area:** 10ft emanation, affects: creature');
  });

  it('rejects a missing areaType', async () => {
    const { tools } = build();
    await expect(
      tools.handleAddFeature({
        featureType: 'aura',
        actorIdentifier: 'X',
        featureName: 'Y',
        damageParts: fireDamage,
        areaSize: 10,
      })
    ).rejects.toThrow();
  });

  it('rejects a non-positive areaSize', async () => {
    const { tools } = build();
    await expect(
      tools.handleAddFeature({
        featureType: 'aura',
        actorIdentifier: 'X',
        featureName: 'Y',
        damageParts: fireDamage,
        areaType: 'sphere',
        areaSize: 0,
      })
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// spellcasting
// ---------------------------------------------------------------------------

describe('handleAddFeature — spellcasting', () => {
  it('forwards setActorSpellcasting with the class default ability and formats slots', async () => {
    const { tools, calls } = build({
      actor: { id: 'a1', name: 'Acolyte' },
      spellcasting: { slots: { spell1: 4, spell2: 3, spell3: 0 } },
      warnings: [],
    });
    const out = await tools.handleAddFeature({
      featureType: 'spellcasting',
      actorIdentifier: 'Acolyte',
      spellcastingClass: 'cleric',
      spellcastingLevel: 5,
    });

    const [method, payload] = bridgeMethodFrom(calls);
    expect(method).toBe('setActorSpellcasting');
    expect(payload.effectiveAbility).toBe('wis'); // cleric default
    expect(out.summary).toBe('✅ Spellcasting configured on "Acolyte" — cleric level 5');
    expect(out.message).toContain('**Ability:** WIS');
    expect(out.message).toContain('**Slots:** L1: 4, L2: 3');
  });

  it('formats warlock pact magic slots', async () => {
    const { tools } = build({
      actor: { id: 'a1', name: 'Warlock' },
      spellcasting: { slots: { pact: { max: 2, level: 3 } } },
      warnings: [],
    });
    const out = await tools.handleAddFeature({
      featureType: 'spellcasting',
      actorIdentifier: 'Warlock',
      spellcastingClass: 'warlock',
      spellcastingLevel: 5,
    });
    expect(out.message).toContain('**Slots:** Pact Magic: 2 slot(s) of level 3');
  });

  it('rejects an invalid spellcastingClass enum', async () => {
    const { tools } = build();
    await expect(
      tools.handleAddFeature({
        featureType: 'spellcasting',
        actorIdentifier: 'X',
        spellcastingClass: 'rogue',
        spellcastingLevel: 5,
      })
    ).rejects.toThrow();
  });

  it('rejects an out-of-range spellcastingLevel', async () => {
    const { tools } = build();
    await expect(
      tools.handleAddFeature({
        featureType: 'spellcasting',
        actorIdentifier: 'X',
        spellcastingClass: 'wizard',
        spellcastingLevel: 21,
      })
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// spells
// ---------------------------------------------------------------------------

describe('handleAddFeature — spells', () => {
  it('forwards addSpellsToActor with default packs and formats an added report', async () => {
    const { tools, calls } = build({
      actor: { id: 'a1', name: 'Wizard' },
      added: [{ name: 'Fireball', packId: 'dnd5e.spells24', packLabel: 'Spells', itemId: 's1' }],
      skipped: [],
      notFound: [],
      failed: [],
      warnings: [],
    });
    const out = await tools.handleAddFeature({
      featureType: 'spells',
      actorIdentifier: 'Wizard',
      spellNames: ['Fireball'],
    });

    const [method, payload] = bridgeMethodFrom(calls);
    expect(method).toBe('addSpellsToActor');
    expect(payload.compendiumPacks).toEqual(['dnd5e.spells24']);
    expect(out.summary).toBe('✅ Spells imported to "Wizard" — 1 added');
    expect(out.message).toContain('  - Fireball *(Spells, item `s1`)*');
  });

  it('uses the 🔍 icon when spells are not found', async () => {
    const { tools } = build({
      actor: { id: 'a1', name: 'Wizard' },
      added: [],
      skipped: [],
      notFound: ['Nonexistent Spell'],
      failed: [],
      warnings: [],
    });
    const out = await tools.handleAddFeature({
      featureType: 'spells',
      actorIdentifier: 'Wizard',
      spellNames: ['Nonexistent Spell'],
    });
    expect(out.summary).toBe('🔍 Spells imported to "Wizard" — 1 not found');
    expect(out.message).toContain('❌ **Not found in compendium:**');
  });

  it('rejects an empty spellNames array', async () => {
    const { tools } = build();
    await expect(
      tools.handleAddFeature({ featureType: 'spells', actorIdentifier: 'X', spellNames: [] })
    ).rejects.toThrow();
  });

  it('rejects an empty-string spell name', async () => {
    const { tools } = build();
    await expect(
      tools.handleAddFeature({ featureType: 'spells', actorIdentifier: 'X', spellNames: [''] })
    ).rejects.toThrow();
  });

  it('rejects more than 50 spell names', async () => {
    const { tools } = build();
    const tooMany = Array.from({ length: 51 }, (_, i) => `Spell ${i}`);
    await expect(
      tools.handleAddFeature({ featureType: 'spells', actorIdentifier: 'X', spellNames: tooMany })
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// homebrew-spell
// ---------------------------------------------------------------------------

describe('handleAddFeature — homebrew-spell', () => {
  it('forwards addHomebrewSpellToActor with the mapped spell fields', async () => {
    const { tools, calls } = build({
      actor: { id: 'a1', name: 'Lich' },
      item: { id: 's1', name: 'Soul Bolt', type: 'spell' },
    });
    const out = await tools.handleAddFeature({
      featureType: 'homebrew-spell',
      actorIdentifier: 'Lich',
      featureName: 'Soul Bolt',
      spellLevel: 1,
      spellSchool: 'nec',
      spellMethod: 'innate',
      spellComponents: ['vocal', 'somatic'],
      spellRange: 120,
      spellRangeUnits: 'ft',
    });
    const [method, payload] = bridgeMethodFrom(calls);
    expect(method).toBe('addHomebrewSpellToActor');
    expect(payload.name).toBe('Soul Bolt');
    expect(payload.level).toBe(1);
    expect(payload.school).toBe('nec');
    expect(payload.method).toBe('innate');
    expect(payload.components).toEqual(['vocal', 'somatic']);
    expect(payload.rangeValue).toBe(120);
    expect(out.summary).toBe('✅ Spell "Soul Bolt" (level 1) added to "Lich"');
  });

  it('builds an optional save activity and forwards it', async () => {
    const { tools, calls } = build({
      actor: { id: 'a1', name: 'Lich' },
      item: { id: 's2', name: 'Frost Nova', type: 'spell' },
      activityType: 'save',
    });
    await tools.handleAddFeature({
      featureType: 'homebrew-spell',
      actorIdentifier: 'Lich',
      featureName: 'Frost Nova',
      spellLevel: 3,
      spellActivity: 'save',
      saveAbility: 'con',
      saveDC: 16,
      saveOnSave: 'half',
      damageParts: [{ number: 8, denomination: 6, type: 'cold' }],
    });
    const [, payload] = bridgeMethodFrom(calls);
    expect(payload.activity.type).toBe('save');
    expect(payload.activity.saveAbility).toBe('con');
    expect(payload.activity.saveDC).toBe(16);
    expect(payload.activity.damageParts).toEqual([{ number: 8, denomination: 6, type: 'cold' }]);
  });

  it('rejects a missing spellLevel', async () => {
    const { tools } = build();
    await expect(
      tools.handleAddFeature({
        featureType: 'homebrew-spell',
        actorIdentifier: 'X',
        featureName: 'Y',
      })
    ).rejects.toThrow();
  });

  it('rejects a save activity without saveAbility/saveDC', async () => {
    const { tools } = build();
    await expect(
      tools.handleAddFeature({
        featureType: 'homebrew-spell',
        actorIdentifier: 'X',
        featureName: 'Y',
        spellLevel: 1,
        spellActivity: 'save',
        damageParts: [{ number: 1, denomination: 6, type: 'cold' }],
      })
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// passive feat widening
// ---------------------------------------------------------------------------

describe('handleAddFeature — passive feat widening', () => {
  it('forwards featType + requirements', async () => {
    const { tools, calls } = build(itemResult({ item: { id: 'f1', name: 'Pack Tactics' } }));
    await tools.handleAddFeature({
      featureType: 'passive',
      actorIdentifier: 'Wolf',
      featureName: 'Pack Tactics',
      featType: 'monster',
      requirements: 'An ally within 5 feet',
    });
    const [method, payload] = bridgeMethodFrom(calls);
    expect(method).toBe('addPassiveFeatureToActor');
    expect(payload.featType).toBe('monster');
    expect(payload.requirements).toBe('An ally within 5 feet');
  });
});

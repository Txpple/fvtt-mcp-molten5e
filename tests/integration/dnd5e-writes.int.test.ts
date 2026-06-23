// dnd5e authoring + data-model inspection (live). Ports scripts/verify-dnd5e-writes.mjs:
// drive the dnd5e NPC-authoring tools end-to-end, then INSPECT the constructed dnd5e
// system data (activities, save DCs, spell slots, embedded items) via the page-eval
// escape hatch. That data-model inspection is the correctness gate the seam-mocking unit
// tests cannot provide. Everything is built on one disposable NPC, deleted in afterAll.
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { Foundry } from '../../dist/foundry.js';
import { DnD5eNpcTools } from '../../dist/tools/dnd5e/npc.js';
import { DnD5eAddFeatureTool } from '../../dist/tools/dnd5e/add-feature.js';
import { DnD5eFeaturesFromCompendiumTools } from '../../dist/tools/dnd5e/features.js';
import { LIVE, foundryConfig, noopLogger, CONNECT_TIMEOUT_MS, TAG } from './setup.js';

interface InspectedItem {
  name: string;
  type: string;
  activityTypes: string[];
  hasDamage: boolean;
  saveDc?: string;
}
interface Inspected {
  cr?: number;
  hpMax?: number;
  acFlat?: number;
  spellAbility?: string;
  spell1?: { liveMax?: number; srcValue?: number; srcOverride?: number };
  spell3?: { liveMax?: number; srcValue?: number; srcOverride?: number };
  itemCount: number;
  items: InspectedItem[];
}

describe.skipIf(!LIVE)('dnd5e authoring + data model (live)', () => {
  const NAME = `${TAG} Dragon`;
  let foundry: Foundry;
  let npc: DnD5eNpcTools;
  let feat: DnD5eAddFeatureTool;
  let comp: DnD5eFeaturesFromCompendiumTools;
  let actorId: string | undefined;
  let inspect: Inspected | null = null;

  beforeAll(async () => {
    foundry = new Foundry(foundryConfig(), noopLogger);
    await foundry.connect();
    npc = new DnD5eNpcTools({ foundry, logger: noopLogger });
    feat = new DnD5eAddFeatureTool({ foundry, logger: noopLogger });
    comp = new DnD5eFeaturesFromCompendiumTools({ foundry, logger: noopLogger });
  }, CONNECT_TIMEOUT_MS);

  afterAll(async () => {
    try {
      await foundry.call('deleteActor', {
        identifiers: actorId ? [actorId] : [NAME],
        removeEmptyFolder: true,
      });
    } catch {
      /* best-effort cleanup */
    }
    await foundry?.dispose();
  });

  it('createNpcActor', async () => {
    const out = await npc.handleCreateNpc({
      name: NAME,
      creatureType: 'dragon',
      size: 'large',
      cr: '5',
      hpAverage: 76,
      hpFormula: '9d10+27',
      acMode: 'flat',
      acValue: 18,
      abilities: { str: 19, dex: 10, con: 17, int: 14, wis: 13, cha: 15 },
      savingThrows: ['dex', 'con'],
    });
    expect(out?.success).toBeTruthy();
  });

  it('findActor resolves the new NPC id', async () => {
    const found = await foundry.call<{ id?: string }>('findActor', { identifier: NAME });
    actorId = found?.id;
    expect(actorId).toBeTruthy();
  });

  it('addPassiveFeatureToActor', async () => {
    const out = await feat.handleAddFeature({
      featureType: 'passive',
      actorIdentifier: NAME,
      featureName: 'Legendary Resistance',
      sourceBook: 'MM',
    });
    expect(out?.success).toBeTruthy();
  });

  it('addSaveFeatureToActor', async () => {
    const out = await feat.handleAddFeature({
      featureType: 'save',
      actorIdentifier: NAME,
      featureName: 'Fire Breath',
      saveAbility: 'dex',
      saveDC: 15,
      damageParts: [{ number: 6, denomination: 6, type: 'fire' }],
      areaType: 'cone',
      areaSize: 30,
    });
    expect(out?.success).toBeTruthy();
  });

  it('addAttackToActor', async () => {
    const out = await feat.handleAddFeature({
      featureType: 'attack',
      actorIdentifier: NAME,
      featureName: 'Bite',
      attackType: 'melee',
      damageParts: [{ number: 2, denomination: 10, type: 'piercing' }],
      reachFt: 10,
    });
    expect(out?.success).toBeTruthy();
  });

  it('addAttackWithSaveToActor', async () => {
    const out = await feat.handleAddFeature({
      featureType: 'attack-with-save',
      actorIdentifier: NAME,
      featureName: 'Stinger',
      attackType: 'melee',
      damageParts: [{ number: 1, denomination: 6, type: 'piercing' }],
      saveAbility: 'con',
      saveDC: 13,
      saveDamageParts: [{ number: 4, denomination: 6, type: 'poison' }],
      saveOnSave: 'half',
    });
    expect(out?.success).toBeTruthy();
  });

  it('addAuraToActor', async () => {
    const out = await feat.handleAddFeature({
      featureType: 'aura',
      actorIdentifier: NAME,
      featureName: 'Fire Aura',
      damageParts: [{ number: 1, denomination: 10, type: 'fire' }],
      areaType: 'emanation',
      areaSize: 10,
    });
    expect(out?.success).toBeTruthy();
  });

  it('setActorSpellcasting', async () => {
    const out = await feat.handleAddFeature({
      featureType: 'spellcasting',
      actorIdentifier: NAME,
      spellcastingClass: 'wizard',
      spellcastingLevel: 5,
    });
    expect(out?.success).toBeTruthy();
  });

  it('addSpellsToActor', async () => {
    const out = await feat.handleAddFeature({
      featureType: 'spells',
      actorIdentifier: NAME,
      spellNames: ['Fireball'],
    });
    expect(out?.success).toBeTruthy();
  });

  it('addFeaturesFromCompendium', async () => {
    const out = await comp.handleAddFeaturesFromCompendium({
      actorIdentifier: NAME,
      featureNames: ['Pack Tactics'],
    });
    expect(out).not.toBeNull();
  });

  // --- Inspect the constructed data model directly in the page ---
  it('inspects the constructed dnd5e data model', async ctx => {
    if (!actorId) return ctx.skip();
    inspect = await foundry.evaluate((id: string) => {
      const g = (globalThis as { game?: { actors?: { get(id: string): unknown } } }).game;
      const live: any = g?.actors?.get(id);
      if (!live) return null;
      // Read the RAW source (toObject): in dnd5e 5.x system.activities is an
      // ActivityCollection (Map-like) on the live doc, so Object.values() on the live
      // doc returns []. The source object is plain and keyed by activity id.
      const a = live.toObject();
      const items = (a.items ?? []).map((i: any) => {
        const acts: any[] = Object.values(i.system?.activities ?? {});
        return {
          name: i.name,
          type: i.type,
          activityTypes: acts.map((act: any) => act.type),
          hasDamage: acts.some((act: any) => (act.damage?.parts ?? []).length > 0),
          saveDc: acts.find((act: any) => act.type === 'save')?.save?.dc?.formula,
        };
      });
      // Spell slots: .max is DERIVED in dnd5e 5.x (computed in prepareData), so read the
      // LIVE doc for max and the SOURCE for value/override to see what was written.
      const sp = (k: string) => ({
        liveMax: live.system?.spells?.[k]?.max,
        srcValue: a.system?.spells?.[k]?.value,
        srcOverride: a.system?.spells?.[k]?.override,
      });
      return {
        cr: a.system?.details?.cr,
        hpMax: a.system?.attributes?.hp?.max,
        acFlat: a.system?.attributes?.ac?.flat,
        spellAbility: live.system?.attributes?.spellcasting ?? a.system?.attributes?.spellcasting,
        spell1: sp('spell1'),
        spell3: sp('spell3'),
        itemCount: items.length,
        items,
      };
    }, actorId);
    expect(inspect).toBeTruthy();
  });

  it('NPC system data: cr=5, hp=76, ac flat=18', ctx => {
    if (!inspect) return ctx.skip();
    expect(inspect.cr).toBe(5);
    expect(inspect.hpMax).toBe(76);
    expect(inspect.acFlat).toBe(18);
  });

  it('attack item has an attack activity with damage', ctx => {
    if (!inspect) return ctx.skip();
    expect(inspect.items.some(i => i.activityTypes.includes('attack') && i.hasDamage)).toBe(true);
  });

  it('save feature has a save activity', ctx => {
    if (!inspect) return ctx.skip();
    expect(inspect.items.some(i => i.activityTypes.includes('save'))).toBe(true);
  });

  it('aura/damage activity present', ctx => {
    if (!inspect) return ctx.skip();
    expect(inspect.items.some(i => i.activityTypes.includes('damage'))).toBe(true);
  });

  it('spellcasting wrote L3 slots (wizard L5)', ctx => {
    if (!inspect) return ctx.skip();
    const s3 = inspect.spell3 ?? {};
    expect((s3.liveMax ?? 0) >= 2 || (s3.srcValue ?? 0) >= 2 || (s3.srcOverride ?? 0) >= 2).toBe(
      true
    );
  });

  it('setActorOwnership for the bridge user', async ctx => {
    if (!actorId) return ctx.skip();
    const userId = await foundry.evaluate(
      () => (globalThis as { game?: { userId?: string } }).game?.userId ?? '',
      null
    );
    const out = await foundry.call<{ success?: boolean }>('setActorOwnership', {
      actorId,
      userId,
      permission: 3,
    });
    expect(out?.success).toBeTruthy();
  });
});

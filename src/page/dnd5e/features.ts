// Page-side: dnd5e feature authoring writes. Runs inside the Foundry page.
//
// Creates embedded "feat" Items on an actor (dnd5e 5.3.3 system data). A save
// feature carries a single "save" activity (save dc/ability + damage parts +
// optional area template); a passive feature is description-only (empty
// activities map). Writes perform awaited createEmbeddedDocuments mutations,
// best-effort (no rollback) — the bridge is always a ready GM. Return shapes
// match the old data-access.ts oracle exactly (addSaveFeatureToActor @5169-5325,
// addPassiveFeatureToActor @5947-6041) so the consuming tool
// (src/tools/dnd5e/add-feature.ts) and its test stay green.

import { slugify, resolveActorFuzzy as findActorByIdentifier } from '../_shared.js';
import { resolveAuthoredIcon } from './icons.js';

// ---------------------------------------------------------------------------
// save feature — feat Item with a single "save" activity
// ---------------------------------------------------------------------------

export async function addSaveFeatureToActor(args: {
  actorIdentifier: string;
  featureName: string;
  description: string;
  activationType: string;
  saveAbility: string;
  saveDC: number;
  damageParts: Array<{ number: number; denomination: number; type: string }>;
  halfOnSave: boolean;
  areaType: string;
  areaSize?: number;
  areaUnits: string;
  affectsType: string;
  img?: string;
}): Promise<unknown> {
  // 1. Lookup actor
  const actor = findActorByIdentifier(args.actorIdentifier);
  if (!actor) {
    throw new Error(`Actor not found: "${args.actorIdentifier}"`);
  }

  // 2. System guard
  if (game.system.id !== 'dnd5e') {
    throw new Error(`addSaveFeatureToActor requires D&D 5e. Current system: "${game.system.id}".`);
  }

  // 3. Duplicate check (by name only, regardless of item type)
  const existing = actor.items.find((i: any) => i.name === args.featureName);
  if (existing) {
    throw new Error(
      `Feature "${args.featureName}" already exists on actor "${actor.name}" ` +
        `(id: ${existing.id}). Use a different name or remove the existing feature first.`
    );
  }

  // 4. Generate activity ID
  const activityId: string = foundry.utils.randomID(16);

  // 5. Slug identifier
  const identifier = slugify(args.featureName);

  // 5a. Map emanation → radius (Foundry uses "radius" for radial emanations)
  const mappedAreaType: string = args.areaType === 'emanation' ? 'radius' : args.areaType;

  // 6. Build item data — schema verified against dnd5e real output
  const itemData = {
    name: args.featureName,
    // Rule 8 — a real, verified icon, not the blank feature star. The caller may override via img.
    img: args.img ?? resolveAuthoredIcon('save'),
    type: 'feat',
    system: {
      description: { value: args.description, chat: '' },
      identifier,
      source: { revision: 1, rules: '2024' },
      type: { value: 'monster', subtype: '' },
      uses: { spent: 0, recovery: [], max: '' },
      advancement: [],
      crewed: false,
      enchant: {},
      prerequisites: { items: [], repeatable: false, level: null },
      properties: [],
      requirements: '',
      activities: {
        [activityId]: {
          _id: activityId,
          type: 'save',
          sort: 0,
          name: '',
          activation: {
            type: args.activationType,
            override: false,
          },
          consumption: {
            scaling: { allowed: false },
            spellSlot: true,
            targets: [],
          },
          description: {},
          duration: { units: 'inst', concentration: false, override: false },
          effects: [],
          range: { units: 'self', override: false },
          uses: { spent: 0, recovery: [] },
          target: {
            template: {
              contiguous: false,
              units: args.areaUnits,
              count: '',
              type: mappedAreaType,
              size: mappedAreaType ? String(args.areaSize) : '',
            },
            affects: {
              choice: false,
              count: '',
              type: args.affectsType,
              special: '',
            },
            override: false,
            prompt: true,
          },
          damage: {
            onSave: args.halfOnSave ? 'half' : 'none',
            parts: args.damageParts.map(p => ({
              custom: { enabled: false, formula: '' },
              number: p.number,
              denomination: p.denomination,
              bonus: '',
              types: [p.type],
              scaling: { mode: '', number: 1 },
            })),
          },
          save: {
            ability: [args.saveAbility],
            dc: {
              calculation: '',
              formula: String(args.saveDC),
            },
          },
        },
      },
    },
    effects: [],
  };

  // 7. Create embedded item
  const [created] = (await actor.createEmbeddedDocuments('Item', [itemData])) as any[];

  // 8. Return structured result
  return {
    success: true,
    item: { id: created.id, name: created.name },
    actor: { id: actor.id, name: actor.name },
  };
}

// ---------------------------------------------------------------------------
// passive feature — feat Item, description only, empty activities map
// ---------------------------------------------------------------------------

export async function addPassiveFeatureToActor(args: any): Promise<unknown> {
  if (game.system.id !== 'dnd5e') {
    throw new Error('addPassiveFeatureToActor requires the dnd5e game system');
  }

  // 1. Resolve actor
  const actor = findActorByIdentifier(args.actorIdentifier);
  if (!actor) {
    throw new Error(`Actor not found: "${args.actorIdentifier}"`);
  }

  // 2. Duplicate check (case-insensitive)
  const existing = actor.items.find(
    (i: any) => i.name.toLowerCase() === args.featureName.toLowerCase()
  );
  if (existing) {
    throw new Error(
      `An item named "${args.featureName}" already exists on actor "${actor.name}". ` +
        `Remove or rename it first.`
    );
  }

  // 3. Slug identifier
  const identifier = slugify(args.featureName as string);

  // 4. Build item data — no activities, no activityId needed
  const itemData = {
    name: args.featureName,
    // Rule 8 — a real, verified icon, not the blank feature star. The caller may override via img.
    img: args.img ?? resolveAuthoredIcon('passive'),
    type: 'feat',
    system: {
      description: { value: args.description ?? '', chat: '' },
      identifier,
      source: {
        revision: 1,
        rules: args.sourceRules ?? '2024',
        custom: '',
        book: args.sourceBook ?? '',
        page: args.sourcePage ?? '',
        license: '',
      },
      type: { value: args.featType ?? 'monster', subtype: '' },
      uses: { spent: 0, recovery: [], max: '' },
      advancement: [],
      crewed: false,
      enchant: {},
      prerequisites: { items: [], repeatable: false, level: null },
      properties: [],
      requirements: args.requirements ?? '',
      activities: {}, // empty — passive feature has no mechanical activity
    },
    effects: [],
  };

  // 5. Create embedded item
  const [created] = (await actor.createEmbeddedDocuments('Item', [itemData])) as any[];
  if (!created) {
    throw new Error(
      `Failed to create passive feature "${args.featureName}" on actor "${actor.name}"`
    );
  }

  return {
    success: true,
    actor: { id: actor.id, name: actor.name },
    item: { id: created.id, name: created.name, type: 'feat' },
  };
}

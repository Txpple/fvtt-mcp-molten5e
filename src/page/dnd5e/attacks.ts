// Page-side: dnd5e attack-authoring writes. Runs INSIDE the headless Foundry page.
//
// Constructs dnd5e 5.3.3 weapon/feat Items with attack / damage / save activities
// (add-feature tool, featureTypes: attack, attack-with-save, aura). These build
// activity maps, damage.parts (with the base part split into system.damage.base),
// weapon properties, range/reach objects, and combined attack+save activities.
// The EXACT constructed system-data shape IS the working behavior — reproduced
// verbatim from the live-verified oracle (data-access.ts @ 6f9612e).
//
// Writes are awaited Foundry document mutations, best-effort (no rollback). No
// module scaffolding (validateFoundryState / auditLog / permissions / sockets) —
// the bridge is always a ready GM. Each exported function takes the single args
// object the Node tools send via foundry.call(name, args) and returns the exact
// shape the tools + tests expect: { success, actor:{id,name}, item:{id,name,type}, warnings }.

import { slugify, resolveActorFuzzy as findActorByIdentifier, DAMAGE_TYPES } from '../_shared.js';

// =============================================================================
// Method-specific constants (ported verbatim from the oracle).
// =============================================================================

// dnd5e 5.3.3 weapon property codes — the live CONFIG.DND5E.validProperties.weapon set (17).
// Soft-validation only (warn, never block). Kept in sync with the copy in tools/dnd5e/add-feature.ts.
const ATTACK_PROPERTY_CANONICAL = new Set([
  'ada',
  'amm',
  'fin',
  'fir',
  'foc',
  'hvy',
  'lgt',
  'lod',
  'mgc',
  'rch',
  'rel',
  'ret',
  'sil',
  'spc',
  'thr',
  'two',
  'ver',
]);

// =============================================================================
// Pure activity-assembly helpers (no Foundry globals) — unit-tested offline in
// attacks.test.ts. These encode the two subtle dnd5e shape rules: the first
// damage part is the weapon BASE (system.damage.base), so only parts[1..] become
// activity parts; and melee vs ranged choose reach vs normal/long range.
// =============================================================================

export interface DamagePart {
  number: number;
  denomination: number;
  type: string;
}

/**
 * Build the dnd5e activity `damage.parts` array. The FIRST authoring part is the weapon's base
 * damage (it lives in system.damage.base), so only parts[1..] are emitted as activity parts.
 */
export function buildActivityDamageParts(
  damageParts: DamagePart[]
): Array<Record<string, unknown>> {
  return damageParts.slice(1).map(p => ({
    types: [p.type],
    number: p.number,
    denomination: p.denomination,
    bonus: '',
    scaling: { mode: '', number: 1 },
    custom: { enabled: false },
  }));
}

/**
 * Build the system-level range/reach object for an attack: melee uses reach (default 5 ft),
 * ranged uses normal/long range.
 */
export function buildAttackRange(data: {
  attackType: string;
  reachFt?: number;
  rangeFt?: number;
  longRangeFt?: number;
}): { value: number | undefined; long: number | null; units: string } {
  return data.attackType === 'melee'
    ? { value: data.reachFt ?? 5, long: null, units: 'ft' }
    : { value: data.rangeFt, long: data.longRangeFt ?? null, units: 'ft' };
}

// =============================================================================
// addAttackToActor — weapon Item with a single "attack" activity
// (add-feature, featureType: attack). Oracle ~5534-5769.
// =============================================================================

export async function addAttackToActor(data: any): Promise<unknown> {
  if (game.system.id !== 'dnd5e') {
    throw new Error('addAttackToActor requires the dnd5e game system');
  }

  // 1. Resolve actor
  const actor = findActorByIdentifier(data.actorIdentifier);
  if (!actor) {
    throw new Error(`Actor not found: "${data.actorIdentifier}"`);
  }

  // 2. Duplicate check
  const existing = actor.items.find(
    (i: any) => i.name.toLowerCase() === data.featureName.toLowerCase()
  );
  if (existing) {
    throw new Error(
      `An item named "${data.featureName}" already exists on actor "${actor.name}". ` +
        `Remove or rename it first.`
    );
  }

  // 3. Soft validation — collect warnings, never block
  const warnings: string[] = [];

  for (const part of data.damageParts as Array<{
    number: number;
    denomination: number;
    type: string;
  }>) {
    if (!DAMAGE_TYPES.has(part.type)) {
      const msg = `Unknown damage type "${part.type}" — verify it matches dnd5e system values`;
      warnings.push(msg);
      console.warn(msg);
    }
  }
  for (const prop of data.properties as string[]) {
    if (!ATTACK_PROPERTY_CANONICAL.has(prop)) {
      const msg = `Unknown weapon property "${prop}" — verify it matches dnd5e system values`;
      warnings.push(msg);
      console.warn(msg);
    }
  }

  // 4. Generate activity ID
  const activityId: string = foundry.utils.randomID(16);

  // 5. Damage parts for the activity (all except the first — which is system.damage.base)
  const activityDamageParts = buildActivityDamageParts(data.damageParts as DamagePart[]);

  // 6. Range object (system-level — holds the real range/reach)
  const rangeObj = buildAttackRange(data);

  // 7. Conditional 2024-only fields
  const sourceRules: string = data.sourceRules ?? '2014';
  const masteryField = sourceRules === '2024' ? { mastery: '' } : {};
  const abilityField = sourceRules === '2024' ? { ability: data.effectiveAbility } : {};
  const classification = sourceRules === '2014' ? 'weapon' : '';

  // 8. Build item data
  const itemData: Record<string, any> = {
    name: data.featureName,
    type: 'weapon',
    system: {
      description: {
        value: data.description ?? '',
        chat: '',
        unidentified: '',
      },
      source: {
        custom: '',
        book: data.sourceBook ?? '',
        page: data.sourcePage ?? '',
        license: '',
        rules: sourceRules,
      },
      quantity: 1,
      weight: { value: 0, units: 'lb' },
      price: { value: 0, denomination: 'gp' },
      attunement: '',
      equipped: data.equipped !== false,
      rarity: '',
      identified: true,
      activation: {
        type: data.activationType ?? 'action',
        value: 1,
        condition: '',
        override: false,
      },
      duration: { value: '', units: '' },
      cover: null,
      target: {
        template: {
          count: '',
          contiguous: false,
          type: '',
          size: '',
          width: '',
          height: '',
          units: '',
        },
        affects: { count: '', type: '', choice: false, special: '' },
        prompt: true,
        override: false,
      },
      range: rangeObj,
      uses: { value: null, max: '', recovery: [], prompt: true },
      damage: {
        base: {
          types: [(data.damageParts as any[])[0].type],
          number: (data.damageParts as any[])[0].number,
          denomination: (data.damageParts as any[])[0].denomination,
          bonus: '',
          scaling: { mode: '', number: 1 },
          custom: { enabled: false },
        },
      },
      type: { value: data.weaponClass ?? 'natural', baseItem: '' },
      properties: data.properties as string[],
      proficient: 1,
      magicalBonus: null,
      ...masteryField,
      activities: {
        [activityId]: {
          _id: activityId,
          type: 'attack',
          name: '',
          img: '',
          sort: 0,
          description: {},
          activation: {
            type: data.activationType ?? 'action',
            value: 1,
            condition: '',
            override: false,
          },
          duration: { units: '', value: '', override: false },
          target: {
            template: {
              count: '',
              contiguous: false,
              type: '',
              size: '',
              width: '',
              height: '',
              units: '',
            },
            affects: { count: '', type: '', choice: false, special: '' },
            prompt: true,
            override: false,
          },
          range: { units: 'self', override: false },
          uses: { spent: 0, max: '', recovery: [] },
          consumption: {
            targets: [],
            scaling: { allowed: false, max: '' },
            spellSlot: true,
          },
          attack: {
            ability: '',
            bonus: data.attackBonus > 0 ? String(data.attackBonus) : '',
            critical: { threshold: null },
            flat: false,
            type: {
              value: data.attackType ?? 'melee',
              classification,
            },
            ...abilityField,
          },
          damage: {
            critical: { bonus: '' },
            includeBase: true,
            parts: activityDamageParts,
          },
          effects: [],
          save: { ability: '', dc: { formula: '', calculation: '' } },
        },
      },
    },
  };

  // 9. Create the item on the actor
  const created = (await actor.createEmbeddedDocuments('Item', [itemData]))[0];
  if (!created) {
    throw new Error(`Failed to create attack item "${data.featureName}" on actor "${actor.name}"`);
  }

  return {
    success: true,
    actor: { id: actor.id, name: actor.name },
    item: { id: created.id, name: created.name, type: 'weapon' },
    warnings,
  };
}

// =============================================================================
// addAuraToActor — feat Item with a single "damage" activity (no attack, no save)
// (add-feature, featureType: aura). Oracle ~5769-5947.
// =============================================================================

export async function addAuraToActor(data: any): Promise<unknown> {
  if (game.system.id !== 'dnd5e') {
    throw new Error('addAuraToActor requires the dnd5e game system');
  }

  // 1. Resolve actor
  const actor = findActorByIdentifier(data.actorIdentifier);
  if (!actor) {
    throw new Error(`Actor not found: "${data.actorIdentifier}"`);
  }

  // 2. Duplicate check (case-insensitive name match)
  const existing = actor.items.find(
    (i: any) => i.name.toLowerCase() === data.featureName.toLowerCase()
  );
  if (existing) {
    throw new Error(
      `An item named "${data.featureName}" already exists on actor "${actor.name}". ` +
        `Remove or rename it first.`
    );
  }

  // 3. Soft validation — collect warnings, never block
  const warnings: string[] = [];

  for (const part of data.damageParts as Array<{
    number: number;
    denomination: number;
    type: string;
  }>) {
    if (!DAMAGE_TYPES.has(part.type)) {
      const msg = `Unknown damage type "${part.type}" — verify it matches dnd5e system values`;
      warnings.push(msg);
      console.warn(msg);
    }
  }

  // 4. Map areaType: Foundry uses "radius" internally for what 5e 2024 calls "emanation"
  //    <option value="radius">Emanation</option> — no "emanation" value exists in the dropdown
  const mappedAreaType: string = data.areaType === 'emanation' ? 'radius' : data.areaType;

  // 5. Generate activity ID
  const activityId: string = foundry.utils.randomID(16);

  // 6. Slug identifier
  const identifier = slugify(data.featureName as string);

  // 7. Build item data — schema verified against dnd5e 5.1.8 Banshee Wail
  const itemData = {
    name: data.featureName,
    type: 'feat',
    img: 'systems/dnd5e/icons/svg/items/feature.svg',
    system: {
      description: { value: data.description ?? '', chat: '' },
      identifier,
      source: {
        revision: 1,
        rules: data.sourceRules ?? '2014',
        custom: '',
        book: data.sourceBook ?? '',
        page: data.sourcePage ?? '',
        license: '',
      },
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
          type: 'damage', // activity type: damage — no attack roll, no save
          name: '',
          sort: 0,
          activation: {
            type: data.activationType ?? 'action',
            value: 1,
            override: false,
            // NO condition — not present in real dnd5e 5.1.8 schema
          },
          consumption: {
            scaling: { allowed: false },
            spellSlot: true, // confirmed: true in real Banshee Wail schema
            targets: [], // no uses management in V1
          },
          description: {}, // empty object — confirmed from real schema
          duration: {
            units: 'inst',
            concentration: false,
            override: false,
          },
          effects: [],
          range: { units: 'self', override: false }, // NO value, NO special
          uses: { spent: 0, recovery: [] }, // NO max field
          target: {
            template: {
              contiguous: false,
              units: data.areaUnits ?? 'ft',
              count: '',
              type: mappedAreaType,
              size: String(data.areaSize),
              width: '',
              height: '',
            },
            affects: {
              count: '',
              type: data.affectsType ?? 'creature',
              choice: false,
              special: '',
            },
            override: false,
            prompt: true,
          },
          damage: {
            critical: { allow: false }, // only this key — no bonus, no dice
            parts: (
              data.damageParts as Array<{ number: number; denomination: number; type: string }>
            ).map(p => ({
              types: [p.type],
              number: p.number,
              denomination: p.denomination,
              bonus: '',
              scaling: { mode: '', number: 1 }, // mode: '' required — from real schema
              custom: { enabled: false }, // NO formula field
            })),
            // NO onSave — damage activity has no save concept
          },
          // NO save block
          // NO attack block
        },
      },
    },
    effects: [],
  };

  // 7. Create embedded item
  const [created] = (await actor.createEmbeddedDocuments('Item', [itemData])) as any[];
  if (!created) {
    throw new Error(`Failed to create aura item "${data.featureName}" on actor "${actor.name}"`);
  }

  return {
    success: true,
    actor: { id: actor.id, name: actor.name },
    item: { id: created.id, name: created.name, type: 'feat' },
    warnings,
  };
}

// =============================================================================
// addAttackWithSaveToActor — weapon Item with TWO activities: an "attack"
// (sort 0) + an independent "save" (sort 1) for bonus on-failure damage
// (add-feature, featureType: attack-with-save). Oracle ~6041-6317.
// =============================================================================

export async function addAttackWithSaveToActor(data: any): Promise<unknown> {
  if (game.system.id !== 'dnd5e') {
    throw new Error('addAttackWithSaveToActor requires the dnd5e game system');
  }

  // 1. Resolve actor
  const actor = findActorByIdentifier(data.actorIdentifier);
  if (!actor) {
    throw new Error(`Actor not found: "${data.actorIdentifier}"`);
  }

  // 2. Duplicate check
  const existing = actor.items.find(
    (i: any) => i.name.toLowerCase() === data.featureName.toLowerCase()
  );
  if (existing) {
    throw new Error(
      `An item named "${data.featureName}" already exists on actor "${actor.name}". ` +
        `Remove or rename it first.`
    );
  }

  // 3. Soft validation — both damage groups unified
  const warnings: string[] = [];
  const allParts = [
    ...(data.damageParts as Array<{ type: string }>),
    ...(data.saveDamageParts as Array<{ type: string }>),
  ];
  for (const part of allParts) {
    if (!DAMAGE_TYPES.has(part.type)) {
      const msg = `Unknown damage type "${part.type}" — verify it matches dnd5e system values`;
      if (!warnings.includes(msg)) warnings.push(msg);
      console.warn(msg);
    }
  }

  // 4. Generate two distinct activity IDs
  const attackActivityId: string = foundry.utils.randomID(16);
  const saveActivityId: string = foundry.utils.randomID(16);

  // 5. Attack activity damage parts: damageParts[1+] (base is in system.damage.base)
  const activityDamageParts = (
    data.damageParts as Array<{ number: number; denomination: number; type: string }>
  )
    .slice(1)
    .map(p => ({
      types: [p.type],
      number: p.number,
      denomination: p.denomination,
      bonus: '',
      scaling: { mode: '', number: 1 },
      custom: { enabled: false },
    }));

  // 6. Save activity damage parts: ALL saveDamageParts (no base — independent)
  const saveActivityDamageParts = (
    data.saveDamageParts as Array<{ number: number; denomination: number; type: string }>
  ).map(p => ({
    types: [p.type],
    number: p.number,
    denomination: p.denomination,
    bonus: '',
    scaling: { mode: '', number: 1 },
    custom: { enabled: false },
  }));

  // 7. System-level range (real reach/range — activity range is always 'self')
  const rangeObj =
    data.attackType === 'melee'
      ? { value: data.reachFt ?? 5, long: null, units: 'ft' }
      : { value: data.rangeFt, long: data.longRangeFt ?? null, units: 'ft' };

  // 8. Conditional 2024-only fields (same rules as Tipo A)
  const sourceRules: string = data.sourceRules ?? '2014';
  const masteryField = sourceRules === '2024' ? { mastery: '' } : {};
  const abilityField = sourceRules === '2024' ? { ability: data.effectiveAbility } : {};
  const classification = sourceRules === '2014' ? 'weapon' : '';

  // 9. Build item data
  const itemData: Record<string, any> = {
    name: data.featureName,
    type: 'weapon',
    system: {
      description: {
        value: data.description ?? '',
        chat: '',
        unidentified: '',
      },
      source: {
        custom: '',
        book: data.sourceBook ?? '',
        page: data.sourcePage ?? '',
        license: '',
        rules: sourceRules,
      },
      quantity: 1,
      weight: { value: 0, units: 'lb' },
      price: { value: 0, denomination: 'gp' },
      attunement: '',
      equipped: data.equipped !== false,
      rarity: '',
      identified: true,
      activation: {
        type: data.activationType ?? 'action',
        value: 1,
        condition: '',
        override: false,
      },
      duration: { value: '', units: '' },
      cover: null,
      target: {
        template: {
          count: '',
          contiguous: false,
          type: '',
          size: '',
          width: '',
          height: '',
          units: '',
        },
        affects: { count: '', type: '', choice: false, special: '' },
        prompt: true,
        override: false,
      },
      range: rangeObj,
      uses: { value: null, max: '', recovery: [], prompt: true },
      damage: {
        base: {
          types: [(data.damageParts as any[])[0].type],
          number: (data.damageParts as any[])[0].number,
          denomination: (data.damageParts as any[])[0].denomination,
          bonus: '',
          scaling: { mode: '', number: 1 },
          custom: { enabled: false },
        },
      },
      type: { value: data.weaponClass ?? 'natural', baseItem: '' },
      properties: data.properties as string[],
      proficient: 1,
      magicalBonus: null,
      ...masteryField,
      activities: {
        // ── Activity 1: attack (sort 0) ───────────────────────────────
        [attackActivityId]: {
          _id: attackActivityId,
          type: 'attack',
          name: '',
          img: '',
          sort: 0,
          description: {},
          activation: {
            type: data.activationType ?? 'action',
            value: 1,
            condition: '',
            override: false,
          },
          duration: { units: '', value: '', override: false },
          target: {
            template: {
              count: '',
              contiguous: false,
              type: '',
              size: '',
              width: '',
              height: '',
              units: '',
            },
            affects: { count: '', type: '', choice: false, special: '' },
            prompt: true,
            override: false,
          },
          range: { units: 'self', override: false },
          uses: { spent: 0, max: '', recovery: [] },
          consumption: { targets: [], scaling: { allowed: false, max: '' }, spellSlot: true },
          attack: {
            ability: '',
            bonus: data.attackBonus > 0 ? String(data.attackBonus) : '',
            critical: { threshold: null },
            flat: false,
            type: { value: data.attackType ?? 'melee', classification },
            ...abilityField,
          },
          damage: {
            critical: { bonus: '' },
            includeBase: true,
            parts: activityDamageParts,
          },
          effects: [],
          save: { ability: '', dc: { formula: '', calculation: '' } },
        },

        // ── Activity 2: save (sort 1) ─────────────────────────────────
        [saveActivityId]: {
          _id: saveActivityId,
          type: 'save',
          name: '',
          sort: 1,
          description: {}, // {} — not { chatFlavor: '' } (real schema confirmed)
          activation: {
            type: data.activationType ?? 'action',
            value: 1,
            override: false,
            // NO condition — per real schema
          },
          duration: { units: 'inst', concentration: false, override: false },
          effects: [],
          range: { units: 'self', override: false },
          uses: { spent: 0, recovery: [] }, // NO max
          consumption: { scaling: { allowed: false }, spellSlot: true, targets: [] },
          target: {
            template: {
              count: '',
              contiguous: false,
              type: '',
              size: '',
              width: '',
              height: '',
              units: '',
            },
            affects: { count: '1', type: 'creature', choice: false, special: '' },
            override: false,
            prompt: true,
          },
          damage: {
            onSave: data.saveOnSave ?? 'none',
            parts: saveActivityDamageParts,
            // NO includeBase — save damage is independent from weapon base damage
          },
          save: {
            ability: [data.saveAbility],
            dc: { calculation: '', formula: String(data.saveDC) },
          },
        },
      },
    },
  };

  // 10. Create the item on the actor
  const created = (await actor.createEmbeddedDocuments('Item', [itemData]))[0];
  if (!created) {
    throw new Error(
      `Failed to create attack+save item "${data.featureName}" on actor "${actor.name}"`
    );
  }

  return {
    success: true,
    actor: { id: actor.id, name: actor.name },
    item: { id: created.id, name: created.name, type: 'weapon' },
    warnings,
  };
}

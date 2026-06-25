// dnd5e NPC authoring — page-side writes that construct a full dnd5e 5.3.3 npc
// Actor system-data model (abilities + save proficiency, attributes.hp/ac,
// movement, senses, details.cr/type/alignment/source, traits damage/condition/
// size/languages, skills). Runs inside the headless Foundry page.

import { getOrCreateFolder, DAMAGE_TYPES } from '../_shared.js';
import {
  normalizeSize,
  normalizeSkill,
  normalizeCR,
  formatCR,
  CONDITION_TYPES,
  SKILL_ABILITY,
} from './actor-fields.js';

// CR helpers keep their npc-prefixed names for existing importers (npc.test.ts); the
// implementations now live in the shared actor-fields module so create + update share them.
export { normalizeCR as npcNormalizeCR, formatCR as npcFormatCR };

// =============================================================================
// NPC creation helpers — used exclusively by createNpcActor.
// =============================================================================

export function npcBuildSkillsBlock(
  skills: Array<{ skill: string; proficiency: string }>
): Record<string, { value: number; ability: string }> {
  // Collect requested proficiencies keyed by skill (unknown skill names are dropped).
  const proficiency: Record<string, number> = {};
  for (const { skill, proficiency: p } of skills) {
    const key = normalizeSkill(skill);
    if (key) {
      proficiency[key] = p === 'expert' ? 2 : 1;
    }
  }
  // Seed ALL 18 skills (value 0 unless proficient), each carrying its governing ability —
  // mirrors a compendium-imported NPC. Without the full set the actor is missing 15 skills
  // entirely, and without `ability` dnd5e drops the ability modifier from every skill total.
  const result: Record<string, { value: number; ability: string }> = {};
  for (const [key, ability] of Object.entries(SKILL_ABILITY)) {
    result[key] = { value: proficiency[key] ?? 0, ability };
  }
  return result;
}

// =============================================================================
// createNpcActor
// =============================================================================

export interface NpcInput {
  name: string;
  creatureType: string;
  creatureSubtype: string;
  size: string;
  alignment: string;
  cr: string | number;
  hpAverage: number;
  hpFormula: string;
  acMode: string;
  acValue?: number;
  abilities: { str: number; dex: number; con: number; int: number; wis: number; cha: number };
  savingThrows: string[];
  walkSpeed: number;
  flySpeed: number;
  swimSpeed: number;
  climbSpeed: number;
  burrowSpeed: number;
  hover: boolean;
  darkvision: number;
  blindsight: number;
  tremorsense: number;
  truesight: number;
  specialSenses: string;
  skills: Array<{ skill: string; proficiency: string }>;
  damageImmunities: string[];
  damageResistances: string[];
  damageVulnerabilities: string[];
  conditionImmunities: string[];
  languages: string[];
  languagesCustom: string;
  biography: string;
  sourceBook: string;
  sourcePage: string;
  sourceRules: string;
}

/**
 * PURE construction of the dnd5e 5.3.3 npc system-data model from validated input: soft-validation
 * warnings (unknown damage types / conditions), CR normalization, the ability + save-proficiency
 * block, the AC block, and the full actor create-data (minus the folder, which the caller assigns).
 * Touches no Foundry globals — unit-tested offline in npc.test.ts.
 */
export function buildNpcActorData(data: NpcInput): {
  actorData: any;
  warnings: string[];
  normalizedCR: number;
} {
  // Soft validation — collect warnings, do NOT block creation
  const warnings: string[] = [];
  const allDamageValues: Array<{ field: string; value: string }> = [
    ...data.damageImmunities.map(v => ({ field: 'damageImmunities', value: v })),
    ...data.damageResistances.map(v => ({ field: 'damageResistances', value: v })),
    ...data.damageVulnerabilities.map(v => ({ field: 'damageVulnerabilities', value: v })),
  ];
  for (const { field, value } of allDamageValues) {
    if (!DAMAGE_TYPES.has(value)) {
      const msg = `Unknown damage type "${value}" in ${field} — verify it matches dnd5e system values`;
      warnings.push(msg);
      console.warn(msg);
    }
  }
  for (const value of data.conditionImmunities) {
    if (!CONDITION_TYPES.has(value)) {
      const msg = `Unknown condition "${value}" in conditionImmunities — verify it matches dnd5e system values`;
      warnings.push(msg);
      console.warn(msg);
    }
  }

  // Normalize CR to float
  const normalizedCR = normalizeCR(data.cr);

  // Ability scores with saving throw proficiency flags
  const savingThrowSet = new Set(data.savingThrows);
  const abilities = {
    str: { value: data.abilities.str, proficient: savingThrowSet.has('str') ? 1 : 0 },
    dex: { value: data.abilities.dex, proficient: savingThrowSet.has('dex') ? 1 : 0 },
    con: { value: data.abilities.con, proficient: savingThrowSet.has('con') ? 1 : 0 },
    int: { value: data.abilities.int, proficient: savingThrowSet.has('int') ? 1 : 0 },
    wis: { value: data.abilities.wis, proficient: savingThrowSet.has('wis') ? 1 : 0 },
    cha: { value: data.abilities.cha, proficient: savingThrowSet.has('cha') ? 1 : 0 },
  };

  // AC block — omit flat when mode is "default"
  const acBlock =
    data.acMode === 'flat' ? { calc: 'flat', flat: data.acValue } : { calc: 'default' };

  // Build full actor data
  const actorData: any = {
    name: data.name,
    type: 'npc',
    system: {
      abilities,
      attributes: {
        ac: acBlock,
        hp: {
          value: data.hpAverage,
          max: data.hpAverage,
          temp: 0,
          tempmax: 0,
          formula: data.hpFormula,
        },
        movement: {
          walk: data.walkSpeed,
          fly: data.flySpeed,
          swim: data.swimSpeed,
          climb: data.climbSpeed,
          burrow: data.burrowSpeed,
          units: 'ft',
          hover: data.hover,
          special: '',
        },
        senses: {
          darkvision: data.darkvision,
          blindsight: data.blindsight,
          tremorsense: data.tremorsense,
          truesight: data.truesight,
          units: 'ft',
          special: data.specialSenses,
        },
      },
      details: {
        cr: normalizedCR,
        type: {
          value: data.creatureType,
          subtype: data.creatureSubtype,
        },
        alignment: data.alignment,
        biography: {
          value: data.biography,
          public: '',
        },
        source: {
          revision: 1,
          rules: data.sourceRules,
          book: data.sourceBook,
          page: data.sourcePage,
          custom: '',
          license: '',
        },
      },
      traits: {
        size: normalizeSize(data.size) ?? 'med',
        di: { value: data.damageImmunities, custom: '', bypasses: [] },
        dr: { value: data.damageResistances, custom: '', bypasses: [] },
        dv: { value: data.damageVulnerabilities, custom: '', bypasses: [] },
        ci: { value: data.conditionImmunities, custom: '' },
        languages: {
          value: data.languages,
          custom: data.languagesCustom,
          communication: {},
        },
      },
      skills: npcBuildSkillsBlock(data.skills),
    },
  };

  return { actorData, warnings, normalizedCR };
}

export async function createNpcActor(data: NpcInput): Promise<unknown> {
  const ActorClass = (globalThis as any).Actor;

  // 1. System guard
  if (game.system.id !== 'dnd5e') {
    throw new Error(`createNpcActor requires D&D 5e. Current system: "${game.system.id}".`);
  }

  // 2. Duplicate check by name — only against other NPCs, so a player
  //    character sharing the name does not block NPC creation.
  const existingActor = game.actors?.find((a: any) => a.name === data.name && a.type === 'npc');
  if (existingActor) {
    throw new Error(
      `NPC "${data.name}" already exists (id: ${existingActor.id}). ` +
        `Use a different name or remove the existing NPC first.`
    );
  }

  // 3. Build the (pure) dnd5e system-data model
  const { actorData, warnings, normalizedCR } = buildNpcActorData(data);

  // 4. Folder — assign if available
  const folderId = await getOrCreateFolder('Foundry MCP Creatures', 'Actor');
  if (folderId) {
    actorData.folder = folderId;
  }

  // 5. Create actor
  const actor = await ActorClass.create(actorData);
  if (!actor) {
    throw new Error(`Failed to create NPC actor "${data.name}"`);
  }

  // 6. Return structured result
  return {
    success: true,
    actor: {
      id: actor.id,
      name: actor.name,
      cr: formatCR(normalizedCR),
      folder: folderId ?? null,
    },
    warnings,
  };
}

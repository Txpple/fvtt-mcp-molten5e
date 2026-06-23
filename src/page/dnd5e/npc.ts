// dnd5e NPC authoring — page-side writes that construct a full dnd5e 5.3.3 npc
// Actor system-data model (abilities + save proficiency, attributes.hp/ac,
// movement, senses, details.cr/type/alignment/source, traits damage/condition/
// size/languages, skills). Runs inside the headless Foundry page.

import { getOrCreateFolder, DAMAGE_TYPES } from '../_shared.js';

// =============================================================================
// NPC creation helpers — ported verbatim from the oracle (data-access.ts),
// each used exclusively by createNpcActor.
// =============================================================================

const NPC_CONDITION_CANONICAL = new Set([
  'blinded',
  'charmed',
  'deafened',
  'exhaustion',
  'frightened',
  'grappled',
  'incapacitated',
  'invisible',
  'paralyzed',
  'petrified',
  'poisoned',
  'prone',
  'restrained',
  'stunned',
  'unconscious',
]);

const NPC_SIZE_MAP: Record<string, string> = {
  tiny: 'tiny',
  small: 'sm',
  medium: 'med',
  large: 'lg',
  huge: 'huge',
  gargantuan: 'grg',
};

const NPC_SKILL_MAP: Record<string, string> = {
  Acrobatics: 'acr',
  'Animal Handling': 'ani',
  Arcana: 'arc',
  Athletics: 'ath',
  Deception: 'dec',
  History: 'his',
  Insight: 'ins',
  Intimidation: 'itm',
  Investigation: 'inv',
  Medicine: 'med',
  Nature: 'nat',
  Perception: 'prc',
  Performance: 'prf',
  Persuasion: 'per',
  Religion: 'rel',
  'Sleight of Hand': 'slt',
  Stealth: 'ste',
  Survival: 'sur',
};

function npcNormalizeCR(input: string | number): number {
  if (typeof input === 'number') return input;
  if (input.includes('/')) {
    const [num, den] = input.split('/').map(Number);
    return num / den;
  }
  return parseInt(input, 10);
}

function npcFormatCR(value: number): string {
  if (value === 0) return '0';
  if (value === 0.125) return '1/8';
  if (value === 0.25) return '1/4';
  if (value === 0.5) return '1/2';
  return String(Math.round(value));
}

function npcBuildSkillsBlock(
  skills: Array<{ skill: string; proficiency: string }>
): Record<string, { value: number }> {
  const result: Record<string, { value: number }> = {};
  for (const { skill, proficiency } of skills) {
    const key = NPC_SKILL_MAP[skill];
    if (key) {
      result[key] = { value: proficiency === 'expert' ? 2 : 1 };
    }
  }
  return result;
}

// =============================================================================
// createNpcActor
// =============================================================================

export async function createNpcActor(data: {
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
}): Promise<unknown> {
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

  // 3. Soft validation — collect warnings, do NOT block creation
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
    if (!NPC_CONDITION_CANONICAL.has(value)) {
      const msg = `Unknown condition "${value}" in conditionImmunities — verify it matches dnd5e system values`;
      warnings.push(msg);
      console.warn(msg);
    }
  }

  // 4. Normalize CR to float
  const normalizedCR = npcNormalizeCR(data.cr);

  // 5. Folder
  const folderId = await getOrCreateFolder('Foundry MCP Creatures', 'Actor');

  // 6. Ability scores with saving throw proficiency flags
  const savingThrowSet = new Set(data.savingThrows);
  const abilities = {
    str: { value: data.abilities.str, proficient: savingThrowSet.has('str') ? 1 : 0 },
    dex: { value: data.abilities.dex, proficient: savingThrowSet.has('dex') ? 1 : 0 },
    con: { value: data.abilities.con, proficient: savingThrowSet.has('con') ? 1 : 0 },
    int: { value: data.abilities.int, proficient: savingThrowSet.has('int') ? 1 : 0 },
    wis: { value: data.abilities.wis, proficient: savingThrowSet.has('wis') ? 1 : 0 },
    cha: { value: data.abilities.cha, proficient: savingThrowSet.has('cha') ? 1 : 0 },
  };

  // 7. AC block — omit flat when mode is "default"
  const acBlock =
    data.acMode === 'flat' ? { calc: 'flat', flat: data.acValue } : { calc: 'default' };

  // 8. Build full actor data
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
        size: NPC_SIZE_MAP[data.size] ?? 'med',
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

  // 9. Assign folder if available
  if (folderId) {
    actorData.folder = folderId;
  }

  // 10. Create actor
  const actor = await ActorClass.create(actorData);
  if (!actor) {
    throw new Error(`Failed to create NPC actor "${data.name}"`);
  }

  // 11. Return structured result
  return {
    success: true,
    actor: {
      id: actor.id,
      name: actor.name,
      cr: npcFormatCR(normalizedCR),
      folder: folderId ?? null,
    },
    warnings,
  };
}
